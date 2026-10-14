import assert from 'node:assert/strict'
import test from 'node:test'
import { displayedSessionStages, isAnimatingStage, isWorkingStage, prominentWorkingStage, parseSessionStages, parseActiveRequestIds, parseSessionRecoveries, sessionActivity, shouldRefreshReadonlyHistory } from './session-activity.ts'

test('sidebar groups prioritize yields over active work without confusing blocking calls with requests for a reply', () => {
  assert.equal(prominentWorkingStage(['llm', 'waiting-for-call', 'waiting']), 'waiting')
  assert.equal(prominentWorkingStage(['waiting', 'tool']), 'waiting')
  assert.equal(prominentWorkingStage(['idle', 'tool', 'llm']), 'tool')
  assert.equal(prominentWorkingStage(['waiting-for-call', 'completed']), 'waiting-for-call')
  assert.equal(prominentWorkingStage([undefined, 'idle', 'inactive']), undefined)
})

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

test('restored activity requires validated server input identities, never session IDs or inferred tokens', () => {
  const activeRequestIds = { 'web:chat-one': 'input-one', 'web:chat-two': 'input-two' }
  assert.deepEqual(parseActiveRequestIds({ activeRequestIds }), activeRequestIds)
  assert.deepEqual(parseActiveRequestIds({ stages: { 'web:chat-one': 'tool' } }), {})
  for (const activeRequestIds of [null, [], 1, { 'web:chat-one': '' }, { 'web:chat-one': 12 }]) {
    assert.throws(() => parseActiveRequestIds({ activeRequestIds }), /identity is unavailable/)
  }
})

test('call-wait metadata distinguishes blocking calls from yields without inventing activity', () => {
  const stages = { task: 'waiting', reusable: 'waiting', yield: 'waiting', idle: 'idle', finished: 'completed' }
  assert.deepEqual(parseSessionStages({ stages, waitingForCalls: { task: true, reusable: true, yield: false, idle: true, finished: true, absent: true } }), {
    task: 'waiting-for-call', reusable: 'waiting-for-call', yield: 'waiting', idle: 'idle', finished: 'completed',
  })
  assert.deepEqual(parseSessionStages({ stages, waitingForCalls: { task: false } }), stages)
  assert.deepEqual(parseSessionStages({ stages }), stages, 'Older snapshots retain their original stage meanings')
  for (const waitingForCalls of [null, [], 1, { task: 'true' }, { task: null }]) {
    assert.throws(() => parseSessionStages({ stages, waitingForCalls }), /activity is unavailable/)
  }
})

test('only validated persisted recovery advertises Resume; idle, finished, legacy status and drafts do not fabricate it', () => {
  const recoveries = { 'web:chat-one': { id: 'paused', reason: 'stopped' }, 'web:chat-two': { id: 'crashed', reason: 'interrupted' } }
  assert.deepEqual(parseSessionRecoveries({ recoveries }), recoveries)
  assert.deepEqual(parseSessionRecoveries({ stages: { 'web:chat-one': 'idle' } }), {})
  assert.deepEqual(parseSessionRecoveries({ recoveries: {} }), {})
  for (const recoveries of [null, [], { root: null }, { root: {} }, { root: { id: 'x', reason: 'completed' } }]) {
    assert.throws(() => parseSessionRecoveries({ recoveries }))
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

test('working animations distinguish computation from waiting and terminal states', () => {
  for (const stage of ['llm', 'tool', 'running']) assert.equal(isAnimatingStage(stage), true)
  for (const stage of ['waiting', 'waiting-for-call', 'pending', 'idle', 'inactive', 'completed', 'failed', 'cancelled', undefined, null]) {
    assert.equal(isAnimatingStage(stage), false)
  }
})

test('rate-limit waiting remains cancellable working status without spinning or Continue', () => {
  assert.equal(isWorkingStage('rate-limit'), true)
  assert.equal(isAnimatingStage('rate-limit'), false)
  assert.equal(sessionActivity('rate-limit').label, 'Waiting for model rate limit (automatic retry)')
  const stages = { chat: 'rate-limit' as const }
  assert.deepEqual(parseSessionStages({ stages }), stages)
  assert.deepEqual(displayedSessionStages(stages, 'chat', true, 'llm'), stages)
})
