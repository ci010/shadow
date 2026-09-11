import assert from 'node:assert/strict'
import test from 'node:test'
import { isWorkingStage, parseSessionStages, sessionActivity } from './session-activity.ts'

test('only LLM and tool execution animate as working', () => {
  for (const stage of ['llm', 'tool']) {
    assert.equal(isWorkingStage(stage), true)
    assert.equal(sessionActivity(stage).working, true)
  }
  for (const stage of ['idle', 'inactive', undefined, null, 'unexpected']) {
    assert.equal(isWorkingStage(stage), false)
    assert.equal(sessionActivity(stage).working, false)
  }
  assert.equal(sessionActivity('llm').label, 'Thinking')
  assert.equal(sessionActivity('tool').label, 'Using tools')
  assert.equal(sessionActivity('idle').label, 'Ready')
  assert.equal(sessionActivity(undefined).label, 'Status unavailable')
})

test('activity snapshots retain real session stages and reject malformed status rather than showing idle', () => {
  const stages = { 'web:chat-a': 'llm', 'web:chat-b': 'tool', 'web:chat-c': 'idle', 'web:chat-d': 'inactive' }
  assert.deepEqual(parseSessionStages({ stages }), stages)
  for (const value of [undefined, null, {}, { stages: [] }, { stages: null }, { stages: { a: 'working' } }, { stages: { a: 1 } }]) {
    assert.throws(() => parseSessionStages(value), /activity is unavailable/)
  }
})
