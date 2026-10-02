import assert from 'node:assert/strict'
import test from 'node:test'
import type { ChatMessage } from '../src/providers/provider.ts'
import { ACCEPTANCE_PHASE_MS, AcceptanceTimeline, stopAcceptanceCreation } from './microapp-acceptance-timeline.ts'
import { acceptanceBudgetError, acceptanceRequestRejection } from './microapp-a2a.ts'

function fixture() {
  let now = 0
  const timeline = new AcceptanceTimeline(() => now)
  return { timeline, at: (time: number) => { now = time } }
}

test('late publication retains separate review and full post-approval testing windows', () => {
  const { timeline, at } = fixture()
  assert.equal(timeline.snapshot().remainingMs, 30 * 60_000)
  assert.equal(timeline.modelError(), undefined)
  at(30 * 60_000)
  assert.equal(timeline.modelError(), 'live_test_creation_deadline_exhausted')
  timeline.review()
  assert.equal(timeline.snapshot().phase, 'review')
  assert.equal(timeline.snapshot().remainingMs, 5 * 60_000)
  assert.equal(timeline.modelError(), 'live_test_review_in_progress')
  at(34 * 60_000)
  timeline.approved(new Date(34 * 60_000).toISOString())
  assert.equal(timeline.snapshot().phase, 'testing')
  assert.equal(timeline.snapshot().remainingMs, 10 * 60_000)
  at(35 * 60_000)
  assert.equal(timeline.snapshot().remainingMs, 9 * 60_000, '60-second preference wait is inside testing, not charged to creation')
  assert.equal(timeline.modelError(), undefined)
  assert.equal(acceptanceBudgetError(100, 100), 'live_test_call_budget_exhausted', 'A phase transition does not add requests')
  at(44 * 60_000)
  assert.equal(timeline.modelError(), 'live_test_testing_deadline_exhausted')
})

test('early handoff and repeated controls cannot extend phase deadlines or the 45-minute ceiling', () => {
  const { timeline, at } = fixture()
  at(10 * 60_000)
  timeline.review()
  const review = timeline.snapshot()
  at(12 * 60_000)
  timeline.review()
  assert.equal(timeline.snapshot().deadlineAt, review.deadlineAt)
  timeline.approved(new Date(12 * 60_000).toISOString())
  const testing = timeline.snapshot()
  at(15 * 60_000)
  timeline.approved(new Date(15 * 60_000).toISOString())
  assert.equal(timeline.snapshot().deadlineAt, testing.deadlineAt)
  assert.equal(timeline.snapshot().remainingMs, 7 * 60_000)
  assert.throws(() => timeline.review(), /already started/)
  assert.equal(timeline.hardDeadline, 45 * 60_000)
  at(22 * 60_000)
  assert.throws(() => timeline.approved(new Date(22 * 60_000).toISOString()), /deadline exhausted/)
})

test('slow polling, stale approvals and timeouts never manufacture more review or testing time', () => {
  const { timeline, at } = fixture()
  at(31 * 60_000)
  timeline.review()
  assert.equal(timeline.snapshot().remainingMs, 4 * 60_000)
  for (const time of [0, 29 * 60_000, 32 * 60_000]) {
    assert.throws(() => timeline.approved(new Date(time).toISOString()), /active review window/)
  }
  assert.throws(() => timeline.approved('invalid'), /active review window/)
  assert.equal(timeline.snapshot().phase, 'review')
  at(35 * 60_000)
  assert.throws(() => timeline.review(), /deadline exhausted/)
  assert.throws(() => timeline.approved(new Date(35 * 60_000).toISOString()), /active review window/)
  assert.equal(timeline.modelError(), 'live_test_review_deadline_exhausted')
  const expired = fixture()
  expired.at(36 * 60_000)
  assert.throws(() => expired.timeline.review(), /deadline exhausted/)
  assert.equal(expired.timeline.snapshot().remainingMs, 0)
})

test('proxy phase denials are non-retryable and approval does not reset the shared call cap', () => {
  const { timeline, at } = fixture()
  assert.deepEqual(acceptanceRequestRejection(undefined, 0, 100), { error: 'live_test_not_started', status: 403 })
  assert.equal(acceptanceRequestRejection(timeline, 99, 100), undefined)
  at(ACCEPTANCE_PHASE_MS.creation)
  assert.deepEqual(acceptanceRequestRejection(timeline, 99, 100), { error: 'live_test_creation_deadline_exhausted', status: 403 })
  timeline.review()
  assert.deepEqual(acceptanceRequestRejection(timeline, 99, 100), { error: 'live_test_review_in_progress', status: 403 })
  timeline.approved(new Date(ACCEPTANCE_PHASE_MS.creation).toISOString())
  assert.equal(acceptanceRequestRejection(timeline, 99, 100), undefined)
  assert.deepEqual(acceptanceRequestRejection(timeline, 100, 100), { error: 'live_test_call_budget_exhausted', status: 429 })
})

test('review forbids inference and phase transitions abort rather than replay in-flight requests', async () => {
  const { timeline, at } = fixture()
  let requests = 0
  const pending = timeline.model(signal => {
    requests++
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  })
  const rejected = assert.rejects(pending, /phase changed/)
  at(100)
  timeline.review()
  await rejected
  await assert.rejects(timeline.model(async () => { requests++ }), /review_in_progress/)
  timeline.approved(new Date(100).toISOString())
  assert.equal(await timeline.model(async () => { requests++; return 'author result' }), 'author result')
  assert.equal(requests, 2)
})

test('phase deadline and caller cancellation propagate to the provider signal', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { timeline } = fixture()
  const waiting = (signal: AbortSignal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  const pending = timeline.model(waiting)
  const expired = assert.rejects(pending, /creation deadline reached/)
  t.mock.timers.tick(ACCEPTANCE_PHASE_MS.creation)
  await expired
  const controller = new AbortController()
  const cancelled = timeline.model(waiting, controller.signal)
  const checked = assert.rejects(cancelled, /owner cancelled/)
  controller.abort(new Error('owner cancelled'))
  await checked
  let called = false
  await assert.rejects(timeline.model(async () => { called = true }, controller.signal), /owner cancelled/)
  assert.equal(called, false)
})

test('phase guidance preserves transcript and pairing while distinguishing creation from testing', () => {
  const { timeline, at } = fixture()
  const messages: ChatMessage[] = [
    { role: 'system', content: 'Existing policy' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'one', type: 'function', function: { name: 'read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'one', content: 'Recorded result' },
  ]
  const before = structuredClone(messages)
  const creation = timeline.prompt(messages, 70)
  assert.match(String(creation[0].content), /CREATION/)
  assert.match(String(creation[0].content), /5 separate minutes/)
  assert.match(String(creation[0].content), /10 separate minutes/)
  assert.match(String(creation[0].content), /same request cap/)
  assert.deepEqual(creation.slice(1), messages.slice(1))
  at(100)
  timeline.review()
  timeline.approved(new Date(100).toISOString())
  const testing = timeline.prompt(messages, 20)
  assert.match(String(testing[0].content), /AUTHOR TESTING/)
  assert.match(String(testing[0].content), /do not reset/)
  assert.match(String(testing[0].content), /blocked\/not_tested/)
  assert.deepEqual(messages, before)
})

test('creation cutoff waits for the real task outcome and preserves cancellation failures', async t => {
  const completed = { id: 'task', status: { state: 'TASK_STATE_COMPLETED' } }
  const working = { id: 'task', status: { state: 'TASK_STATE_WORKING' } }
  const cancelled = { id: 'task', status: { state: 'TASK_STATE_CANCELED' } }
  let calls = 0
  assert.equal(await stopAcceptanceCreation(completed, async () => { calls++; return cancelled }, async () => working), completed)
  assert.equal(calls, 0)
  assert.equal(await stopAcceptanceCreation(working, async () => cancelled, async () => working), cancelled)
  const failure = new Error('Cancellation transport failed')
  await assert.rejects(stopAcceptanceCreation(working, async () => { throw failure }, async () => working), error => error === failure)
  await assert.rejects(stopAcceptanceCreation(working, async () => working, async () => working), /has not reached a terminal/)
  const warnings: unknown[][] = []
  t.mock.method(console, 'warn', (...args: unknown[]) => warnings.push(args))
  assert.equal(await stopAcceptanceCreation(working, async () => { throw failure }, async () => completed), completed)
  assert.equal(warnings.length, 1)
})
