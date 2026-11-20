import assert from 'node:assert/strict'
import test from 'node:test'
import type { ExecutionContext } from '../tools/context.ts'
import type { SessionManager } from '../sessions/session-manager.ts'
import type { SessionState } from '../sessions/session-store.ts'
import type { CronDispatcher } from './dispatch.ts'
import type { WorkDispatcher } from './work-dispatch.ts'
import { WorkDispatchAgent } from './work-dispatch-agent.ts'
import { WorkDispatchRoundState } from './work-dispatch-round-state.ts'
import { WORK_DISPATCH_AUTOMATION } from './defaults.ts'
import { WORK_DISPATCH_ID, workDispatchConfigSchema } from './work-dispatch-contract.ts'

function fixture() {
  const config = workDispatchConfigSchema.parse({ kind: 'work-dispatch' })
  const job = { ...WORK_DISPATCH_AUTOMATION, id: WORK_DISPATCH_ID, enabled: true, createdAt: new Date().toISOString(), program: config }
  let instructions = 'Reconcile existing PR owners. Verify locally; keep PRs draft.', task = '', runs = 0, deliveries = 0, dispatches = 0
  let version = 1, secondPage = 1, ownerBusy = false, failDelivery = false, failRun = false, recipient = 'manager'
  let onRun: () => Promise<void> = async () => {}
  const signal = new AbortController().signal
  const sessions = {
    getSessionState: () => ({ sessionId: 'cron:fixture', projectId: 'fixture', mode: 'task', agentType: 'dispatcher', executionStatus: 'running',
      automation: { jobId: WORK_DISPATCH_ID, config: { task, source: 'cron' } } }) as unknown as SessionState,
    deliver: async (id: string, input: { id: string; content: string }) => {
      deliveries++
      assert.equal(id, recipient)
      assert.match(input.content, /not authority/)
      if (failDelivery) throw new Error('transport outcome unknown')
      return { status: 'accepted', sessionId: id, inputId: input.id }
    },
  } as unknown as Pick<SessionManager, 'getSessionState' | 'deliver'>
  const dispatcher = {
    snapshot: (_config: unknown, offset = 0) => ({ capacity: { available: true }, targets: [], total: 2, next: offset === 0 ? 1 : undefined,
      records: [{ key: offset === 0 ? 'work:one' : 'work:two', sequence: offset === 0 ? version : secondPage, ownerBusy }] }),
    reviewTarget: (key: string, expected: number) => {
      if (expected !== version) throw new Error('Work changed')
      return { record: { key, sequence: version }, recipient }
    },
    dispatchWork: async () => { dispatches++; return {} },
  } as unknown as WorkDispatcher
  const cron = { dispatch: async (_job: unknown, _signal: unknown, text: string) => {
    task = text; runs++
    if (failRun) throw new Error('provider failed')
    await onRun()
    return 'cron:fixture'
  } } as unknown as Pick<CronDispatcher, 'dispatch'>
  const receipts = new WorkDispatchRoundState()
  const agent = new WorkDispatchAgent(dispatcher, sessions, cron, { instructions: async () => instructions }, () => job, receipts)
  const context = { sessionId: 'cron:fixture', signal } as ExecutionContext
  return { agent, job, signal, context, receipts, counts: () => ({ runs, deliveries, dispatches }),
    onRun: (fn: () => Promise<void>) => { onRun = fn },
    changeInstructions: () => { instructions += '\nNew scheduling guidance.' }, changeWork: () => { version++ },
    changeSecondPage: () => { secondPage++ }, changeOwner: () => { ownerBusy = !ownerBusy },
    failDelivery: () => { failDelivery = true }, failRun: () => { failRun = true },
    changeRecipient: () => { recipient = 'other-manager' },
  }
}

test('agent no-op suppression invalidates on instructions, all Work pages, owner state and configuration', async () => {
  const f = fixture()
  await f.agent.run(f.job, f.signal)
  await f.agent.run(f.job, f.signal)
  assert.equal(f.counts().runs, 1)
  f.changeInstructions(); await f.agent.run(f.job, f.signal)
  f.changeWork(); await f.agent.run(f.job, f.signal)
  f.changeSecondPage(); await f.agent.run(f.job, f.signal)
  f.changeOwner(); await f.agent.run(f.job, f.signal)
  f.job.program.maxConcurrent = 3; await f.agent.run(f.job, f.signal)
  assert.equal(f.counts().runs, 6)
})

test('coordinator review is bounded, preserves ownership, rejects stale grants and prevents subsequent new-worker dispatch', async () => {
  const f = fixture()
  const request = { action: 'request_review', key: 'work:one', version: 1, reason: 'Existing PR evidence needs owner reconciliation.' }
  f.onRun(async () => {
    const first = JSON.parse(await f.agent.execute(request, f.context))
    assert.equal(first.status, 'accepted')
    const repeated = JSON.parse(await f.agent.execute({ ...request, reason: 'Different wording must not cause another notification.' }, f.context))
    assert.equal(repeated.replayed, false)
    await assert.rejects(f.agent.execute({ action: 'dispatch', key: 'work:one', version: 1 }, f.context), /review is pending/)
    await assert.rejects(f.agent.execute({ ...request, version: 2 }, f.context), /changed/)
  })
  await f.agent.run(f.job, f.signal)
  assert.deepEqual(f.counts(), { runs: 1, deliveries: 1, dispatches: 0 })
  await assert.rejects(f.agent.execute(request, f.context), /active host-created/)
})

test('uncertain coordinator delivery is not replayed even in the same round', async () => {
  const f = fixture(); f.failDelivery()
  const request = { action: 'request_review', key: 'work:one', version: 1, reason: 'Need coordinator review.' }
  f.onRun(async () => {
    await assert.rejects(f.agent.execute(request, f.context), /outcome unknown/)
    const retry = JSON.parse(await f.agent.execute(request, f.context))
    assert.equal(retry.status, 'unconfirmed')
    assert.equal(retry.replayed, false)
  })
  await f.agent.run(f.job, f.signal)
  assert.equal(f.counts().deliveries, 1)
})

test('failed rounds back off and revoked configuration cannot notify a coordinator', async () => {
  const failed = fixture(); failed.failRun()
  await assert.rejects(failed.agent.run(failed.job, failed.signal), /provider failed/)
  await failed.agent.run(failed.job, failed.signal)
  assert.equal(failed.counts().runs, 1)
  const revoked = fixture()
  revoked.onRun(async () => {
    revoked.job.enabled = false
    await assert.rejects(revoked.agent.execute({ action: 'request_review', key: 'work:one', version: 1, reason: 'Need review' }, revoked.context), /revoked/)
  })
  await revoked.agent.run(revoked.job, revoked.signal)
  assert.equal(revoked.counts().deliveries, 0)
})


test('known pre-delivery abort releases only the unsent reservation; same-version review can retry', async () => {
  const f = fixture()
  const controller = new AbortController()
  const context = { ...f.context, signal: controller.signal }
  const request = { action: 'request_review', key: 'work:one', version: 1, reason: 'Reconcile owner.' }
  const reserve = f.receipts.reserveReview.bind(f.receipts)
  f.receipts.reserveReview = async input => {
    const reservation = await reserve(input)
    controller.abort()
    return reservation
  }
  f.onRun(async () => {
    await assert.rejects(f.agent.execute(request, context), /abort/i)
    assert.equal(f.counts().deliveries, 0)
    assert.equal(await f.receipts.reviewFor('work:one', 1), undefined)
    const retried = JSON.parse(await f.agent.execute(request, f.context))
    assert.equal(retried.status, 'accepted')
  })
  await f.agent.run(f.job, f.signal)
  assert.equal(f.counts().deliveries, 1)
})
