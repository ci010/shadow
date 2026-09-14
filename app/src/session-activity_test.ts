import assert from 'node:assert/strict'
import test from 'node:test'
import { displayedSessionStages, isWorkingStage, parseSessionStages, sessionActivity, shouldRefreshReadonlyHistory } from './session-activity.ts'

test('LLM, tool execution and waiting retain working controls', () => {
  for (const stage of ['llm', 'tool', 'waiting']) {
    assert.equal(isWorkingStage(stage), true)
    assert.equal(sessionActivity(stage).working, true)
  }
  for (const stage of ['idle', 'inactive', undefined, null, 'unexpected']) {
    assert.equal(isWorkingStage(stage), false)
    assert.equal(sessionActivity(stage).working, false)
  }
  assert.equal(sessionActivity('llm').label, 'Thinking')
  assert.equal(sessionActivity('tool').label, 'Using tools')
  assert.equal(sessionActivity('waiting').label, 'Waiting for a response')
  assert.equal(sessionActivity('idle').label, 'Ready')
  assert.equal(sessionActivity(undefined).label, 'Status unavailable')
})

test('activity snapshots retain real session stages and reject malformed status rather than showing idle', () => {
  const stages = { 'web:chat-a': 'llm', 'web:chat-b': 'tool', 'web:chat-c': 'idle', 'web:chat-d': 'inactive', 'web:chat-e': 'waiting' }
  assert.deepEqual(parseSessionStages({ stages }), stages)
  for (const value of [undefined, null, {}, { stages: [] }, { stages: null }, { stages: { a: 'working' } }, { stages: { a: 1 } }]) {
    assert.throws(() => parseSessionStages(value), /activity is unavailable/)
  }
})

test('server waiting takes precedence over a running tool stream', () => {
  assert.deepEqual(displayedSessionStages({ root: 'waiting' }, 'root', true, 'tool'), { root: 'waiting' })
  assert.deepEqual(displayedSessionStages({ root: 'idle' }, 'root', true, 'tool'), { root: 'tool' })
  assert.deepEqual(displayedSessionStages({ root: 'tool' }, 'root', false, 'llm'), { root: 'tool' })
})

test('waiting retains attention but refreshes readonly history only on stage changes or the idle cadence', () => {
  assert.equal(isWorkingStage('waiting'), true)
  assert.equal(shouldRefreshReadonlyHistory('waiting', 'tool', 0), true)
  assert.equal(shouldRefreshReadonlyHistory('waiting', undefined, 0), true)
  assert.equal(shouldRefreshReadonlyHistory('waiting', 'waiting', 1500), false)
  assert.equal(shouldRefreshReadonlyHistory('waiting', 'waiting', 4999), false)
  assert.equal(shouldRefreshReadonlyHistory('waiting', 'waiting', 5000), true)
  assert.equal(shouldRefreshReadonlyHistory('idle', 'waiting', 0), true)
  assert.equal(shouldRefreshReadonlyHistory('idle', 'idle', 1500), false)
  assert.equal(shouldRefreshReadonlyHistory('idle', 'idle', 5000), true)
  assert.equal(shouldRefreshReadonlyHistory('llm', 'llm', 1500), true)
  assert.equal(shouldRefreshReadonlyHistory('tool', 'tool', 1500), true)
})
