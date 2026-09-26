import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { withTempWorkspace } from '../testing/workspace.ts'
import { migrateSessionsToSqlite } from '../../scripts/migrate-sessions-to-sqlite.ts'
import { JsonlSessionStore } from './session-store-jsonl.ts'
import { SqliteSessionStore } from './session-store-sqlite.ts'
import type { SessionState, SessionStore } from './session-store.ts'
import { YieldRecords } from './yield-records.ts'
import { YieldManager, YieldError } from './yield.ts'
import { parseYieldDecisionRecord, type YieldRequest, type YieldDecisionRecord } from './yield-contract.ts'
import { physicalSessionId } from './session-identity.ts'

const question = { question: 'Keep the original budget?', options: ['Keep four', 'Allow six'] as [string, string], defaultOption: 'Keep four' }
const request = (sessionId = 'web:worker', id = 'decision-1'): YieldRequest => ({
  ...question, id, sessionId, recipient: { kind: 'user', sessionId },
  createdAt: '2026-09-21T10:00:00Z', deadline: null,
})

for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  test(`${Store.name}: convention sources require the current human input or an explicit live human decision`, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      const state: SessionState = { sessionId: 'web:worker', segmentIndex: 0, physicalIdVersion: 2 }
      await store.saveState(state.sessionId, state)
      const records = new YieldRecords(store, id => id === state.sessionId ? state : undefined)
      const physicalId = physicalSessionId(state)
      const input = { sessionId: state.sessionId, physicalId, id: 'current-input' }
      const source = { ...input, kind: 'user' as const, quote: 'Use pnpm' }
      try {
        await store.appendRawEvents(physicalId, [{ decision_input: { id: input.id, text: 'For this Project: Use pnpm' } }])
        assert.equal((await records.conventionAuthority(source, input)).quote, 'Use pnpm')
        await assert.rejects(records.conventionAuthority({ ...source, quote: 'Invented' }, input), /does not match/)
        await assert.rejects(records.conventionAuthority({ ...source, id: 'old-input' }, input), /current human input/)
        await assert.rejects(records.conventionAuthority({ ...source, sessionId: 'web:other' }, input), /current human conversation/)
        await assert.rejects(records.conventionAuthority({ ...source, kind: 'tool' }, input), /Tool observations/)
        state.segmentIndex = 1
        assert.equal((await records.conventionAuthority(source, { ...input, physicalId: physicalSessionId(state) })).quote, 'Use pnpm',
          'Compaction does not move the original human input to a different source segment')
        state.segmentIndex = 0
        for (const [index, answeredBy] of ['user', 'parent', 'timeout'].entries()) {
          const saved = await records.open({ ...request(state.sessionId, `choice-${index}`),
            ...(answeredBy === 'parent' ? { recipient: { kind: 'parent' as const, sessionId: 'web:parent' } } : {}) })
          await records.write({ request: saved, answer: {
            requestId: saved.id, answeredBy: answeredBy as 'user' | 'parent' | 'timeout',
            option: saved.options[0], answeredAt: saved.createdAt,
          } })
          const ref = { kind: 'decision' as const, sessionId: state.sessionId, physicalId, requestId: saved.id }
          if (answeredBy === 'user') {
            assert.equal((await records.conventionAuthority(ref, input)).quote, saved.options[0])
            await records.invalidate({ sessionId: state.sessionId, physicalId, requestId: saved.id }, 'Premise changed')
          }
          await assert.rejects(records.conventionAuthority(ref, input), /human-selected option/)
        }
        const custom = await records.open(request(state.sessionId, 'custom'))
        await records.write({ request: custom, answer: { requestId: custom.id, answeredBy: 'user', option: 'Use pnpm', custom: true, answeredAt: custom.createdAt } })
        await assert.rejects(records.conventionAuthority({ kind: 'decision', sessionId: state.sessionId, physicalId, requestId: custom.id }, input), /human-selected option/)
        const pending = await records.open(request(state.sessionId, 'pending'))
        await assert.rejects(records.conventionAuthority({ kind: 'decision', sessionId: state.sessionId, physicalId, requestId: pending.id }, input), /human-selected option/)
        await assert.rejects(records.conventionAuthority({ kind: 'decision', sessionId: state.sessionId, physicalId: '../foreign', requestId: 'x' }, input), /segment/)
      } finally { store.close?.() }
    })
  })

  test(`${Store.name}: decision facts and scoped references survive reopening and segment changes`, async () => {
    await withTempWorkspace(async workspace => {
      let store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      const states: Record<string, SessionState> = {
        'web:worker': { sessionId: 'web:worker', segmentIndex: 0, physicalIdVersion: 2 },
        'web:coordinator': { sessionId: 'web:coordinator', segmentIndex: 0, physicalIdVersion: 2 },
      }
      for (const state of Object.values(states)) await store.saveState(state.sessionId, state)
      let records = new YieldRecords(store, id => states[id])
      try {
        const source = await records.open(request(), 'worker-call')
        const ref = { sessionId: source.sessionId, physicalId: source.origin!.physicalId, requestId: source.id }
        const parent = await records.open({ ...request('web:coordinator', 'decision-2'), sources: [ref] }, 'coordinator-call')
        assert.deepEqual((await records.read(parent.sessionId))[0]?.request.sources, [ref])
        await assert.rejects(records.open({ ...request('web:coordinator', 'bad-source'), sources: [{ ...ref, requestId: 'invented' }] }), /does not exist/)
        await assert.rejects(records.open({ ...request('web:coordinator', 'wrong-owner'), sources: [{ ...ref, sessionId: 'web:coordinator' }] }), /does not belong/)
        await assert.rejects(records.read('web:foreign', ref.physicalId), /not found/)
        await assert.rejects(records.read(source.sessionId, '../outside'), /does not belong/)

        const answer = { requestId: source.id, option: 'Keep four', answeredBy: 'user' as const, answeredAt: '2026-09-21T10:01:00Z' }
        states[source.sessionId].segmentIndex = 1
        await store.saveState(source.sessionId, states[source.sessionId])
        await records.write({ request: source, answer })
        assert.deepEqual(await records.read(source.sessionId), [], 'Settlement must not move into the new segment')
        assert.deepEqual(await records.read(source.sessionId, ref.physicalId), [{ request: source, answer }])
        await store.appendMessages(physicalSessionId(states[parent.sessionId]), [{ role: 'user', content: 'Unrelated history', timestamp: source.createdAt }])
        store.close?.()
        store = new Store(join(workspace, 'sessions'))
        await store.init()
        records = new YieldRecords(store, id => states[id])
        assert.deepEqual(await records.read(source.sessionId, ref.physicalId), [{ request: source, answer }])
        assert.equal((await records.read(parent.sessionId))[0]?.answer, undefined, 'An abandoned opening is not an answer')
        const restored = new YieldManager({
          getState: id => states[id], getPolicy: () => ({ timeoutMs: null }), journal: records,
          notifyUser: async () => {}, notifyParent: async () => {},
        })
        assert.equal(restored.get(parent.sessionId), null)
        assert.throws(() => restored.answerUser(parent.sessionId, parent.id, 'Keep four'), /not found/)
      } finally { store.close?.() }
    })
  })
}

test('JSONL-to-SQLite migration retains decision identities, sources and outcome facts', async () => {
  await withTempWorkspace(async workspace => {
    const directory = join(workspace, 'sessions')
    const source = new JsonlSessionStore(directory)
    await source.init()
    const state: SessionState = { sessionId: 'web:worker', segmentIndex: 0, physicalIdVersion: 2, decisionOwnerSessionId: 'web:worker' }
    await source.saveState(state.sessionId, state)
    const records = new YieldRecords(source, () => state)
    const saved = await records.open(request(), 'call')
    const record: YieldDecisionRecord = { request: saved, closed: { at: saved.createdAt, reason: 'cancelled', message: 'Cancelled' } }
    await records.write(record)
    record.invalidated = { reference: { sessionId: state.sessionId, physicalId: saved.origin!.physicalId, requestId: saved.id },
      at: saved.createdAt, reason: 'Original premise corrected' }
    await source.appendRawEvents(saved.origin!.physicalId, [
      { decision_input: { id: 'original-goal', text: 'Keep the original scope', at: saved.createdAt } },
      { yield_invalidation: record.invalidated },
    ])
    await migrateSessionsToSqlite(directory)
    const target = new SqliteSessionStore(directory)
    try {
      await target.init()
      assert.equal((await target.getState(state.sessionId))?.decisionOwnerSessionId, 'web:worker')
      assert.deepEqual(await new YieldRecords(target, () => state).read(state.sessionId), [record])
      assert.equal((await new YieldRecords(target, () => state).context(state.sessionId)).userInputs[0]?.quote, 'Keep the original scope')
    } finally { target.close() }
  })
})

function gatedJournal() {
  const opening = Promise.withResolvers<YieldRequest>()
  const committing = Promise.withResolvers<void>()
  const seen: YieldDecisionRecord[] = []
  let proposed: YieldRequest | undefined
  let delivered = 0
  const manager = new YieldManager({
    getState: sessionId => ({ sessionId, segmentIndex: 0 }),
    getPolicy: () => ({ timeoutMs: null }),
    notifyUser: async () => { delivered++ }, notifyParent: async () => { delivered++ },
    journal: {
      open: async value => { proposed = value; return opening.promise },
      write: async value => { seen.push(value); await committing.promise },
    },
  })
  return { manager, opening, committing, seen, proposed: () => proposed!, delivered: () => delivered }
}

test('requests are durable before publishing; answers commit once before acknowledgment or resumption', async () => {
  const f = gatedJournal()
  const waiting = f.manager.ask('web:worker', question, new AbortController().signal)
  assert.equal(f.manager.get('web:worker'), null)
  assert.equal(f.delivered(), 0)
  assert.throws(() => f.manager.answerUser('web:worker', f.proposed().id, 'Keep four'), /being recorded/)
  await assert.rejects(f.manager.ask('web:worker', question, new AbortController().signal), /already has/)
  f.opening.resolve({ ...f.proposed(), origin: { physicalId: 'web_worker-0', toolCallId: 'call' } })
  await f.manager.settled()
  assert.equal(f.delivered(), 1)
  let resumed = false
  void waiting.then(() => { resumed = true })
  const saving = f.manager.answerUser('web:worker', f.proposed().id, 'Allow six')
  assert.equal(f.seen.length, 1)
  assert.throws(() => f.manager.answerUser('web:worker', f.proposed().id, 'Keep four'), /being recorded/)
  assert.throws(() => f.manager.cancelUser('web:worker', f.proposed().id), /being recorded/)
  await Promise.resolve()
  assert.equal(resumed, false)
  f.committing.resolve()
  const answer = await saving
  assert.deepEqual(await waiting, answer)
  assert.equal(f.seen[0]?.answer, answer)
  assert.equal(f.manager.get('web:worker'), null)
})

test('failed answer persistence surfaces an error and never resumes with an approval', async () => {
  const f = gatedJournal()
  const waiting = f.manager.ask('web:worker', question, new AbortController().signal)
  const rejected = assert.rejects(waiting, error => error instanceof YieldError && error.code === 'unavailable')
  f.opening.resolve({ ...f.proposed(), origin: { physicalId: 'web_worker-0' } })
  await f.manager.settled()
  const saving = f.manager.answerUser('web:worker', f.proposed().id, 'Allow six')
  f.committing.reject(new Error('Disk full'))
  await assert.rejects(saving, /could not be saved: Disk full/)
  await rejected
  assert.equal(f.manager.get('web:worker'), null)
})

test('cancellation during request persistence records a close without publishing or selecting a default', async () => {
  const f = gatedJournal()
  const controller = new AbortController()
  const waiting = f.manager.ask('web:worker', question, controller.signal)
  const rejected = assert.rejects(waiting, { name: 'AbortError' })
  controller.abort()
  f.opening.resolve({ ...f.proposed(), origin: { physicalId: 'web_worker-0' } })
  f.committing.resolve()
  await rejected
  await f.manager.settled()
  assert.equal(f.delivered(), 0)
  assert.equal(f.seen.length, 1)
  assert.equal(f.seen[0]?.closed?.reason, 'cancelled')
  assert.equal(f.seen[0]?.answer, undefined)
})

test('deleting a session while its answer commits preserves the fact but never resumes the cancelled turn', async () => {
  const f = gatedJournal()
  const waiting = f.manager.ask('web:worker', question, new AbortController().signal)
  const rejected = assert.rejects(waiting, { name: 'AbortError', message: 'Session deleted.' })
  f.opening.resolve({ ...f.proposed(), origin: { physicalId: 'web_worker-0' } })
  await f.manager.settled()
  const saving = f.manager.answerUser('web:worker', f.proposed().id, 'Allow six')
  f.manager.cancelSession('web:worker', 'Session deleted.')
  f.committing.resolve()
  assert.equal((await saving).option, 'Allow six')
  await rejected
  assert.equal(f.seen.length, 1, 'Cancellation cannot overwrite an already accepted decision')
  assert.equal(f.manager.get('web:worker'), null)
})

test('record parsing rejects mismatched authority and mutually exclusive outcomes', () => {
  const saved = { ...request(), origin: { physicalId: 'web_worker-0' } }
  const answer = { requestId: saved.id, option: 'Keep four', answeredBy: 'user', answeredAt: saved.createdAt }
  for (const invalid of [
    { request: request() }, { request: saved, answer: { ...answer, answeredBy: 'parent' } },
    { request: saved, answer: { ...answer, requestId: 'other' } },
    { request: saved, answer, closed: { at: saved.createdAt, reason: 'cancelled', message: '' } },
    { request: saved, closed: { at: 'invalid', reason: 'cancelled', message: '' } },
  ]) assert.throws(() => parseYieldDecisionRecord(invalid), TypeError)
})
