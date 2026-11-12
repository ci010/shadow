import test from 'node:test'
import assert from 'node:assert/strict'
import { affectsSessionResource, affectsSessionSummary } from './session-invalidation.ts'

test('session change hints narrow resource reads while legacy/unknown hints remain conservative', () => {
  const event = { event: 'invalidate', sessionId: 'web:one' }
  for (const resource of ['work', 'background-tasks', 'scheduled-tasks'] as const) {
    assert.equal(affectsSessionResource({ ...event, changes: ['history'] }, 'web:one', resource), false)
    assert.equal(affectsSessionResource({ ...event, changes: [resource] }, 'web:one', resource), true)
    assert.equal(affectsSessionResource(event, 'web:one', resource), true)
    assert.equal(affectsSessionResource({ ...event, changes: ['future-kind'] }, 'web:one', resource), true)
    assert.equal(affectsSessionResource({ ...event, changes: [] }, 'web:one', resource), true)
    assert.equal(affectsSessionResource(event, 'web:other', resource), false)
    assert.equal(affectsSessionResource({ event: 'activity', sessionId: 'web:one' }, 'web:one', resource), false)
    assert.equal(affectsSessionResource({ event: 'invalidate', changes: [resource] }, 'web:one', resource), true)
  }
  assert.equal(affectsSessionResource({ ...event, changes: ['history', 'work'] }, 'web:one', 'work'), true)
  assert.equal(affectsSessionResource({ ...event, changes: ['history', 'work'] }, 'web:one', 'scheduled-tasks'), false)
})

test('summary ignores history/tool progress and work-only hints, preserving directory dependencies', () => {
  for (const changes of [['history'], ['work'], ['history', 'work']]) {
    assert.equal(affectsSessionSummary({ event: 'invalidate', changes }), false)
  }
  for (const changes of [['metadata'], ['activity'], ['background-tasks'], ['scheduled-tasks'], [], ['future']]) {
    assert.equal(affectsSessionSummary({ event: 'invalidate', changes }), true)
  }
  assert.equal(affectsSessionSummary({ event: 'activity' }), false)
  assert.equal(affectsSessionSummary({ event: 'invalidate' }), true)
  assert.equal(affectsSessionSummary(null), true)
})
