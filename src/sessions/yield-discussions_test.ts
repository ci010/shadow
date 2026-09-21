import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { withTempWorkspace } from '../testing/workspace.ts'
import { JsonlSessionStore } from './session-store-jsonl.ts'
import { SqliteSessionStore } from './session-store-sqlite.ts'
import { YieldRecords } from './yield-records.ts'
import { YieldDiscussions } from './yield-discussions.ts'
import { YieldManager } from './yield.ts'
import type { SessionState, SessionStore } from './session-store.ts'
import type { YieldReview } from './yield-contract.ts'

const question = { question: 'Expand the budget?', options: ['Six', 'Four'] as [string, string], defaultOption: 'Four' }
async function completed(read: () => Promise<YieldReview[]>) {
  for (let index = 0; index < 2000; index++) {
    const records = await read()
    if (records.at(-1)?.status !== 'running') return records.at(-1)!
    await setImmediate()
  }
  throw new Error('Discussion did not settle')
}
for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  test(`${Store.name}: duplicate starts await persistence, cancellation drains work, and restart never replays it`, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      const state = { sessionId: 'root', segmentIndex: 0 }
      const records = new YieldRecords(store, () => state)
      const yields = new YieldManager({ journal: records, getState: () => state, getPolicy: () => ({ timeoutMs: null }),
        notifyUser: async () => {}, notifyParent: async () => {} })
      const gate = Promise.withResolvers<void>()
      const entered = Promise.withResolvers<void>()
      const write = records.writeReview.bind(records)
      records.writeReview = async review => { if (review.status === 'running') { entered.resolve(); await gate.promise } await write(review) }
      let runs = 0
      const discussions = new YieldDiscussions(records, yields, async (_request, _review, signal) => {
        runs++
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          signal.throwIfAborted()
        })
      })
      const waiting = yields.ask('root', question, new AbortController().signal)
      const rejected = assert.rejects(waiting, /cancelled/)
      await yields.settled()
      const request = yields.get('root')!
      const id = randomUUID()
      const first = discussions.start('root', request.id, id, 'clarify', 'Explain')
      await entered.promise
      let acknowledged = false
      const retry = discussions.start('root', request.id, id, 'clarify', 'Explain').then(review => { acknowledged = true; return review })
      await setImmediate()
      assert.equal(acknowledged, false)
      assert.equal(runs, 0)
      gate.resolve()
      const [review, repeated] = await Promise.all([first, retry])
      assert.equal(review.id, repeated.id)
      assert.equal(runs, 1)
      await discussions.stop()
      assert.equal(discussions.active, false)
      assert.equal((await discussions.read(review.reference))[0]?.status, 'failed')
      assert.equal(yields.get('root')?.id, request.id, 'Stopping discussion must not answer or cancel the original question')
      const interrupted = { ...review, id: randomUUID() }
      await write(interrupted)
      assert.equal((await discussions.read(review.reference)).at(-1)?.status, 'interrupted')
      assert.equal(runs, 1)
      await assert.rejects(discussions.start('root', request.id, randomUUID(), 'clarify', 'Explain again'), /stopped/)
      await yields.cancelUser('root', request.id)
      await rejected
      await yields.settled()
      store.close?.()
    })
  })

  test(`${Store.name}: clarification never answers; revision replaces the version but retains the suspended call`, async t => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      const states: Record<string, SessionState> = {
        root: { sessionId: 'root', segmentIndex: 0 }, child: { sessionId: 'child', segmentIndex: 0, parentSessionId: 'root' },
      }
      for (const state of Object.values(states)) await store.saveState(state.sessionId, state)
      const records = new YieldRecords(store, id => states[id])
      const yields = new YieldManager({ journal: records, getState: id => states[id], getPolicy: () => ({ timeoutMs: 10 }),
        notifyUser: async () => {}, notifyParent: async () => {} })
      let result = Promise.withResolvers<string>()
      let runs = 0
      const discussions = new YieldDiscussions(records, yields, async () => { runs++; return result.promise })
      t.mock.timers.enable({ apis: ['setTimeout'] })
      let resumed = false
      const waiting = yields.ask('root', question, new AbortController().signal)
      void waiting.then(() => { resumed = true })
      await yields.settled()
      const request = yields.get('root')!
      const id = randomUUID()
      const review = await discussions.start('root', request.id, id, 'clarify', 'Why six? What did I originally request?')
      t.mock.timers.tick(100)
      assert.equal(yields.get('root')?.timeoutPaused, true)
      assert.equal(resumed, false)
      assert.equal(runs, 1)
      await discussions.start('root', request.id, id, 'clarify', review.question)
      assert.equal(runs, 1)
      await assert.rejects(discussions.start('root', request.id, randomUUID(), 'clarify', 'Another request'), /already running/)
      result.resolve('Four was the user limit; six is an agent proposal, not your instruction.')
      const explanation = await completed(() => discussions.read(review.reference))
      assert.equal(explanation.status, 'completed')
      assert.equal(yields.get('root')?.id, request.id)
      assert.equal(resumed, false)
      await setImmediate()
      await discussions.start('root', request.id, id, 'clarify', review.question)
      assert.equal(runs, 1, 'Persisted idempotency prevents repeating a completed explanation')

      result = Promise.withResolvers<string>()
      await discussions.start('root', request.id, randomUUID(), 'revise', 'Do not expand the budget; ask about capping retries.')
      result.resolve(JSON.stringify({ question: 'Keep the four-run budget by capping retries?', options: ['Cap retries', 'Pause work'],
        defaultOption: 'Pause work', explanation: 'Preserved the four-run constraint and removed the expansion assumption.' }))
      const revision = await completed(() => discussions.read(review.reference))
      assert.equal(revision.status, 'completed')
      assert.ok(revision.replacement)
      const next = yields.get('root')!
      assert.notEqual(next.id, request.id)
      assert.equal(next.decisionId, request.id)
      assert.equal(next.supersedes?.requestId, request.id)
      assert.deepEqual(next.recipient, request.recipient)
      assert.equal(resumed, false)
      assert.throws(() => yields.answerUser('root', request.id, 'Six'), /not found/)
      const facts = await records.read('root')
      assert.equal(facts[0]?.closed?.reason, 'superseded')
      assert.equal(facts[0]?.answer, undefined)
      assert.equal(facts[1]?.answer, undefined)
      const receipt = await yields.answerUser('root', next.id, 'Cap retries')
      assert.deepEqual(await waiting, receipt)
      assert.equal(receipt.revisedQuestion?.question, next.question)
      assert.equal(receipt.option, 'Cap retries')
      await discussions.stop()
      yields.stop()
      await yields.settled()
      store.close?.()
      const reopened: SessionStore = new Store(join(workspace, 'sessions'))
      await reopened.init()
      try {
        const restored = new YieldRecords(reopened, id => states[id])
        assert.equal((await restored.read('root'))[0]?.closed?.replacement?.requestId, next.id)
        assert.equal((await restored.readReviews(review.reference)).length, 2)
      } finally { reopened.close?.() }
    })
  })
}

test('invalid revision and late revision never become approvals or overwrite an answered request', async () => {
  await withTempWorkspace(async workspace => {
    const store = new JsonlSessionStore(join(workspace, 'sessions'))
    await store.init()
    const state = { sessionId: 'root', segmentIndex: 0 }
    const records = new YieldRecords(store, id => id === 'root' ? state : undefined)
    const yields = new YieldManager({ journal: records, getState: id => id === 'root' ? state : undefined,
      getPolicy: () => ({ timeoutMs: null }), notifyUser: async () => {}, notifyParent: async () => {} })
    let result = Promise.withResolvers<string>()
    const discussions = new YieldDiscussions(records, yields, () => result.promise)
    const waiting = yields.ask('root', question, new AbortController().signal)
    await yields.settled()
    const request = yields.get('root')!
    await assert.rejects(discussions.start('other', request.id, randomUUID(), 'clarify', 'Explain'), /requesting root/)
    const review = await discussions.start('root', request.id, randomUUID(), 'revise', 'Ask a clearer question')
    result.resolve('not JSON')
    assert.equal((await completed(() => discussions.read(review.reference))).status, 'failed')
    assert.equal(yields.get('root')?.id, request.id)
    await setImmediate()
    result = Promise.withResolvers<string>()
    await discussions.start('root', request.id, randomUUID(), 'revise', 'Clarify the cost')
    const answer = await yields.answerUser('root', request.id, 'Four')
    result.resolve(JSON.stringify({ ...question, explanation: 'New wording' }))
    assert.equal((await completed(() => discussions.read(review.reference))).status, 'failed')
    assert.deepEqual(await waiting, answer)
    assert.equal((await records.read('root')).length, 1)
    await discussions.stop()
  })
})
