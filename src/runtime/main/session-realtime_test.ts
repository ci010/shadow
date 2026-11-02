import test from 'node:test'
import assert from 'node:assert/strict'
import { Bus } from '../../bus/bus.ts'
import type { RealtimePublisher } from '../../realtime/hub.ts'
import { observeSessionInvalidations } from './session-realtime.ts'

test('real lifecycle and worker metadata bus facts preserve scoped hints and cleanup', () => {
  const bus = new Bus()
  const calls: Array<Parameters<RealtimePublisher['invalidateSessions']>> = []
  const stop = observeSessionInvalidations(bus, { invalidateSessions: (...args) => { calls.push(args) } })
  bus.emit('session.ended', { sessionId: 'web:worker', agentType: 'general' })
  bus.emit('session.changed', { sessionId: 'web:worker' }) // Task lifecycle/review persistence.
  bus.emit('session.changed', { sessionId: 'web:worker', metadataOnly: true })
  bus.emit('background.task.changed', { sessionId: 'web:worker', taskId: 'task-1', status: 'completed' })
  assert.deepEqual(calls, [
    ['web:worker', undefined, undefined],
    ['web:worker', undefined, ['metadata', 'activity', 'work', 'background-tasks', 'scheduled-tasks']],
    ['web:worker', undefined, ['metadata']],
    ['web:worker', undefined, ['background-tasks']],
  ])
  stop()
  bus.emit('session.ended', { sessionId: 'web:worker' })
  assert.equal(calls.length, 4)
  bus.stopAll()
})

test('handoff always invalidates full topology even when the source row is unchanged', () => {
  const bus = new Bus()
  const calls: Array<Parameters<RealtimePublisher['invalidateSessions']>> = []
  const stop = observeSessionInvalidations(bus, { invalidateSessions: (...args) => { calls.push(args) } })
  bus.emit('session.handoff', { sessionId: 'web:source', sourceSessionId: 'web:source', targetSessionId: 'web:target' })
  assert.deepEqual(calls, [[undefined, undefined, undefined]], 'neither endpoint may be hidden by a scoped source-only probe')
  stop(); bus.stopAll()
})
