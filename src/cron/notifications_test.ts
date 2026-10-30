import assert from 'node:assert/strict'
import test from 'node:test'
import { Bus } from '../bus/bus.ts'
import type { SessionState } from '../sessions/session-store.ts'
import { systemAutomationRef } from './contracts.ts'
import { watchAutomationSessions } from './notifications.ts'

test('automation session starts, state transitions and removals notify only the owning project and stop on dispose', () => {
  const bus = new Bus()
  const states = new Map<string, SessionState>()
  const run: SessionState = { sessionId: 'run', segmentIndex: 0, projectId: 'a',
    automation: systemAutomationRef('work-organizer', 'run') }
  let a = 0, b = 0
  const stop = watchAutomationSessions(bus, { projectId: 'a', initial: [], state: id => states.get(id), changed: () => { a++ } })
  const stopB = watchAutomationSessions(bus, { projectId: 'b', initial: [], state: id => states.get(id), changed: () => { b++ } })
  states.set(run.sessionId, run)
  bus.emit('session.changed', { sessionId: run.sessionId })
  assert.equal(a, 1, 'Creation invalidates before a turn finishes')
  run.executionStatus = 'waiting'
  bus.emit('session.changed', { sessionId: run.sessionId })
  run.executionStatus = 'completed'
  bus.emit('session.ended', { sessionId: run.sessionId })
  assert.equal(a, 3)
  bus.emit('session.activity.changed', { sessionId: run.sessionId })
  states.set('chat', { sessionId: 'chat', segmentIndex: 0, projectId: 'a' })
  bus.emit('session.changed', { sessionId: 'chat' })
  assert.equal(a, 3, 'Unrelated activity and ordinary chats are ignored')
  states.delete(run.sessionId)
  bus.emit('session.changed', { sessionId: run.sessionId })
  assert.equal(a, 4, 'Removal invalidates even though the state is now absent')
  assert.equal(b, 0)
  stop(); stopB()
  states.set(run.sessionId, run)
  bus.emit('session.changed', { sessionId: run.sessionId })
  assert.equal(a, 4)
})

test('archived identities are seeded for historical list deletion', () => {
  const bus = new Bus()
  const archived: SessionState = { sessionId: 'archived', segmentIndex: 0,
    automation: systemAutomationRef('work-organizer', 'archived') }
  let changes = 0
  const stop = watchAutomationSessions(bus, { projectId: 'a', initial: [archived], state: () => null, changed: () => { changes++ } })
  bus.emit('session.changed', { sessionId: archived.sessionId })
  assert.equal(changes, 1)
  stop()
})
