import assert from 'node:assert/strict'
import test from 'node:test'
import { canUseConversationHistory, createConversationSnapshotRefresh } from './conversation-snapshot-refresh.ts'

test('conversation refresh handles synchronous snapshots and unsupported subscriptions', async () => {
  const refresh = createConversationSnapshotRefresh()
  const signal = new AbortController().signal
  assert.equal(await refresh.wait(() => { refresh.received(); return true }, signal), true)
  assert.equal(await refresh.wait(() => false, signal), false)
  assert.equal(await refresh.wait(() => { throw new Error('disconnected') }, signal), false)
})

test('stalled or failed socket refresh and aborted owners release HTTP fallback without leaking waiters', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const refresh = createConversationSnapshotRefresh()
  const owner = new AbortController()
  const timed = refresh.wait(() => true, owner.signal)
  t.mock.timers.tick(749)
  let settled = false
  void timed.then(() => { settled = true })
  await Promise.resolve()
  assert.equal(settled, false)
  t.mock.timers.tick(1)
  assert.equal(await timed, false)
  const failed = refresh.wait(() => true, owner.signal)
  refresh.failed()
  assert.equal(await failed, false)
  const aborted = refresh.wait(() => true, owner.signal)
  owner.abort()
  assert.equal(await aborted, false)
  let dispatched = false
  assert.equal(await refresh.wait(() => { dispatched = true; return true }, owner.signal), false)
  assert.equal(dispatched, false)
  refresh.received()
})

test('recent tails cannot collapse expanded history or satisfy explicit pagination', () => {
  const recent = { currentPhysicalId: 'current', historyStart: 100 }
  assert.equal(canUseConversationHistory(recent, 'current', 50), false)
  assert.equal(canUseConversationHistory(recent, 'current', 100), true)
  assert.equal(canUseConversationHistory(recent, 'current', 150), true)
  assert.equal(canUseConversationHistory(recent, 'previous', 0), true)
  assert.equal(canUseConversationHistory(recent, undefined, 0), true)
  assert.equal(canUseConversationHistory(recent, 'current', 100, 0), false)
})
