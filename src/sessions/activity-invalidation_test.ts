import test from 'node:test'
import assert from 'node:assert/strict'
import { createActivityInvalidator, sessionActivityFingerprint } from './activity-invalidation.ts'

test('activity notifications deduplicate unchanged read-model state but preserve all visible transitions', () => {
  const active = { phase: 'llm', rateLimitWait: undefined as unknown, activeRequestId: 'turn-one' }
  let waiting = false, recovery: unknown
  const yields = new Map(), inputs = new Map()
  const source = { getActiveSession: () => active, isWaitingForCall: () => waiting,
    getSessionRecovery: () => recovery, yields, inputs } as unknown as Parameters<typeof sessionActivityFingerprint>[0]
  const notifications: string[] = []
  const invalidator = createActivityInvalidator(id => sessionActivityFingerprint(source, id), id => notifications.push(id))
  invalidator.changed('web:one')
  for (let i = 0; i < 100; i++) invalidator.changed('web:one')
  assert.equal(notifications.length, 1)
  for (const change of [
    () => { active.phase = 'tool' },
    () => { active.activeRequestId = 'turn-two' },
    () => { active.rateLimitWait = { until: 'synthetic' } },
    () => { waiting = true },
    () => { recovery = { id: 'recovery', reason: 'stopped' } },
  ]) {
    change(); invalidator.changed('web:one')
  }
  assert.equal(notifications.length, 6)
  invalidator.changed('web:two')
  assert.equal(notifications.length, 7, 'session state is isolated')
  invalidator.dispose()
  invalidator.changed('web:one')
  assert.equal(notifications.length, 8)
})

test('bounded eviction and fingerprint failures cause extra notifications, never suppressed updates', () => {
  const notifications: string[] = []
  let fail = false
  const invalidator = createActivityInvalidator(() => { if (fail) throw new Error('unavailable'); return 'same' }, id => notifications.push(id), 1)
  invalidator.changed('one'); invalidator.changed('two'); invalidator.changed('one')
  assert.deepEqual(notifications, ['one', 'two', 'one'])
  fail = true
  invalidator.changed('one')
  fail = false
  invalidator.changed('one')
  assert.equal(notifications.length, 5)
})


test('questions changing within the waiting stage still publish activity for ask subscribers', () => {
  const yields = new Map<string, unknown>(), inputs = new Map<string, unknown>()
  const source = { getActiveSession: () => undefined, isWaitingForCall: () => false,
    getSessionRecovery: () => undefined, yields, inputs } as unknown as Parameters<typeof sessionActivityFingerprint>[0]
  let notifications = 0
  const invalidator = createActivityInvalidator(id => sessionActivityFingerprint(source, id), () => { notifications++ })
  yields.set('one', { id: 'question-a', timeoutPaused: false })
  invalidator.changed('one')
  invalidator.changed('one')
  yields.set('one', { id: 'question-a', timeoutPaused: true })
  invalidator.changed('one')
  yields.set('one', { id: 'question-b', timeoutPaused: true })
  invalidator.changed('one')
  assert.equal(notifications, 3)
  yields.delete('one')
  inputs.set('one', { id: 'input-a', question: 'first' })
  invalidator.changed('one')
  inputs.set('one', { id: 'input-b', question: 'second' })
  invalidator.changed('one')
  invalidator.changed('one')
  assert.equal(notifications, 5, 'input changes still notify while stage remains waiting')
})

test('read-model wire validation requires complete replacements and validates recovery contents', async () => {
  const { parseSessionActivityReadModel } = await import('./activity-read-model.ts')
  const valid = { stage: 'tool', waitingForCall: false, activeRequestId: 'turn', recovery: null }
  assert.deepEqual(parseSessionActivityReadModel(valid), valid)
  for (const invalid of [null, [], {}, { ...valid, stage: 'unknown' }, { ...valid, waitingForCall: true },
    { ...valid, activeRequestId: '' }, { ...valid, activeRequestId: undefined },
    { ...valid, recovery: undefined }, { ...valid, recovery: { id: 'r', reason: 'failed', pendingToolCalls: -1 } }]) {
    assert.equal(parseSessionActivityReadModel(invalid), undefined)
  }
  const recovery = { id: 'r', reason: 'interrupted', userInvolved: true, pendingToolCalls: 2, providerFailure: 'network' }
  assert.deepEqual(parseSessionActivityReadModel({ ...valid, recovery })?.recovery, recovery)
})
