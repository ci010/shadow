import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { withTempWorkspace } from '../testing/workspace.ts'
import { JsonlSessionStore } from './session-store-jsonl.ts'
import { SqliteSessionStore } from './session-store-sqlite.ts'
import type { SessionState } from './session-store.ts'
import { YieldRecords } from './yield-records.ts'
import { YieldManager } from './yield.ts'
import { InputRequests } from './input-requests.ts'
import { AskTool } from '../tools/ask.ts'
import type { ExecutionContext } from '../tools/context.ts'

const question = { question: 'Publish?', options: ['Publish', 'Wait'] as [string, string], defaultOption: 'Publish' }
for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  test(`${Store.name}: unattended human decisions persist deferred/nonapproval, race once, reject late IDs after reopen`, async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1_800_000_000_000 })
    await withTempWorkspace(async workspace => {
      let store = new Store(join(workspace, 'sessions'))
      await store.init()
      const state: SessionState = { sessionId: 'web:root', segmentIndex: 0, physicalIdVersion: 2 }
      await store.saveState(state.sessionId, state)
      let records = new YieldRecords(store, () => state)
      let opened = Promise.withResolvers<void>()
      const manager = new YieldManager({ getState: () => state, getPolicy: () => ({ timeoutMs: null }),
        userWait: () => ({ timeoutMs: 1000, awayGraceMs: 10 }), presence: () => 'away', journal: records,
        notifyUser: async () => { opened.resolve() }, notifyParent: async () => {} })
      try {
        const waiting = manager.ask(state.sessionId, question, new AbortController().signal)
        await opened.promise
        const first = manager.get(state.sessionId)!
        t.mock.timers.tick(10)
        assert.throws(() => manager.answerUser(state.sessionId, first.id, 'Publish'), /being recorded/)
        const result = await waiting
        assert.equal(result.approved, false)
        assert.equal(result.disposition, 'deferred')
        assert.equal(result.option, undefined)
        let saved = await records.read(state.sessionId)
        assert.equal(saved[0].closed?.reason, 'deferred')
        assert.equal(saved[0].answer, undefined)
        opened = Promise.withResolvers<void>()
        const second = manager.ask(state.sessionId, question, new AbortController().signal)
        await opened.promise
        const next = manager.get(state.sessionId)!
        assert.throws(() => manager.answerUser(state.sessionId, first.id, 'Publish'), /not found/)
        const answer = manager.answerUser(state.sessionId, next.id, 'Wait')
        t.mock.timers.tick(1000)
        assert.equal((await answer).answeredBy, 'user')
        assert.equal((await second).option, 'Wait')
        saved = await records.read(state.sessionId)
        assert.equal(saved.length, 2)
        assert.equal(saved[1].closed, undefined)
        store.close?.()
        store = new Store(join(workspace, 'sessions'))
        await store.init()
        records = new YieldRecords(store, () => state)
        assert.deepEqual(await records.read(state.sessionId), saved)
      } finally { manager.stop(); await manager.settled(); store.close?.() }
    })
  })
}

test('parent and A2A caller requests never consult presence or user timeout policy', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1000 })
  const states: Record<string, SessionState> = { root: { sessionId: 'root', segmentIndex: 0 },
    child: { sessionId: 'child', segmentIndex: 0, parentSessionId: 'root' },
    caller: { sessionId: 'caller', segmentIndex: 0 } }
  const forbidden = (): never => { throw new Error('Must not consult user presence/policy') }
  const yields = new YieldManager({ getState: id => states[id], getPolicy: () => ({ timeoutMs: null }),
    userWait: forbidden, presence: forbidden, notifyUser: async () => {}, notifyParent: async () => {} })
  const decision = yields.ask('child', question, new AbortController().signal)
  const id = yields.get('child')!.id
  t.mock.timers.tick(1_000_000)
  await yields.answerParent('root', id, 'Wait')
  assert.equal((await decision).answeredBy, 'parent')
  const inputs = new InputRequests({ getState: id => states[id], assertAccess: () => {}, hasDecision: () => false,
    timeout: () => null, userWait: forbidden, presence: forbidden, changed: () => {}, write: async () => {}, notify: async () => {} })
  const ctx = (sessionId: string) => ({ sessionId, channel: sessionId === 'caller' ? 'a2a' : 'web', senderId: 'alice', signal: new AbortController().signal }) as ExecutionContext
  const parentInput = inputs.ask('Path?', ctx('child'))
  await setImmediate()
  await inputs.replyParent('root', inputs.get('child')!.id, 'fixture')
  assert.equal((await parentInput).text, 'fixture')
  inputs.bindCaller('caller', async () => 'protocol answer')
  assert.equal((await inputs.ask('Name?', ctx('caller'))).answeredBy, 'caller')
})

test('Ask input returns structured unavailable, never invented text or approval', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1000 })
  const state: SessionState = { sessionId: 'root', segmentIndex: 0 }
  const records: unknown[] = []
  const inputs = new InputRequests({ getState: () => state, assertAccess: () => {}, hasDecision: () => false,
    timeout: () => null, userWait: () => ({ timeoutMs: 10, awayGraceMs: 1 }), presence: () => 'unknown',
    changed: () => {}, write: async record => { records.push(record) }, notify: async () => {} })
  const yields = new YieldManager({ getState: () => state, getPolicy: () => ({ timeoutMs: null }), notifyUser: async () => {}, notifyParent: async () => {} })
  const tool = new AskTool(yields, inputs)
  const result = tool.execute({ kind: 'input', question: 'Name?' }, {
    sessionId: 'root', channel: 'web', senderId: 'alice', signal: new AbortController().signal,
  } as ExecutionContext)
  await setImmediate()
  const id = inputs.get('root')!.id
  t.mock.timers.tick(10)
  const unavailable = JSON.parse(await result as string)
  assert.equal(unavailable.status, 'unavailable')
  assert.equal(unavailable.approved, false)
  assert.equal(unavailable.text, undefined)
  assert.equal(records.length, 2)
  assert.throws(() => inputs.replyUser('root', id, 'late'), /no longer pending/)
})

test('user unknown/active uses fixed deadline; explicit infinite suppresses away expiry', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1000 })
  for (const presence of ['unknown', 'active'] as const) {
    const manager = new YieldManager({ getState: id => ({ sessionId: id, segmentIndex: 0 }),
      getPolicy: () => ({ timeoutMs: null }), userWait: () => ({ timeoutMs: 100, awayGraceMs: 1 }),
      presence: () => presence, notifyUser: async () => {}, notifyParent: async () => {} })
    const result = manager.ask('web:root', question, new AbortController().signal)
    t.mock.timers.tick(99)
    assert.ok(manager.get('web:root'))
    const rejected = assert.rejects(result, /No human answer received/)
    t.mock.timers.tick(1)
    await rejected
  }
  const manager = new YieldManager({ getState: id => ({ sessionId: id, segmentIndex: 0 }),
    getPolicy: () => ({ timeoutMs: null }), userWait: () => ({ timeoutMs: null, awayGraceMs: 1 }),
    presence: () => 'away', notifyUser: async () => {}, notifyParent: async () => {} })
  const result = manager.ask('web:root', question, new AbortController().signal)
  t.mock.timers.tick(1_000_000)
  const pending = manager.get('web:root')!
  assert.equal(pending.deadline, null)
  await manager.answerUser('web:root', pending.id, 'Wait')
  assert.equal((await result).answeredBy, 'user')
})
