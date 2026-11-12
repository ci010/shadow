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

test('sparse activity validates the complete envelope and restores field defaults', () => {
  assert.deepEqual(parseSessionStages({ activity: { a: { stage: 'llm' }, b: { stage: 'idle' }, c: { activeRequestId: 'turn' } } }), { a: 'llm', b: 'idle', c: 'inactive' })
  assert.deepEqual(parseSessionStages({ activity: {} }), {})
  assert.deepEqual(parseActiveRequestIds({ activity: { a: { activeRequestId: 'turn' } } }), { a: 'turn' })
  const recovery = { id: 'turn', reason: 'stopped' }
  assert.deepEqual(parseSessionRecoveries({ activity: { a: { recovery } } }), { a: recovery })
  assert.deepEqual(parseSessionStages({ activity: { a: { stage: 'waiting', waitingForCall: true }, b: { stage: 'waiting' } } }), { a: 'waiting-for-call', b: 'waiting' })
  for (const value of [undefined, null, {}, { stages: {} }, { activity: [] }, { activity: null },
    ...[null, [], { stage: 'working' }, { stage: 1 }, { activeRequestId: '' }, { activeRequestId: 12 },
      { waitingForCall: 'true' }, { waitingForCall: true }, { recovery: {} }, { recovery: { id: 'x', reason: 'completed' } }, { surprise: true }].map(a => ({ activity: { a } }))]) {
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
  assert.deepEqual(parseSessionStages({ activity: { chat: { stage: 'rate-limit' } } }), stages)
  assert.deepEqual(displayedSessionStages(stages, 'chat', true, 'llm'), stages)
})


test('failed recovery replaces resting icons but never active work or intentional stops', () => {
  const recovery = { id: 'turn', reason: 'failed', providerFailure: 'request' }
  for (const stage of ['idle', 'inactive']) {
    assert.deepEqual(parseSessionStages({ activity: { chat: { stage, recovery } } }), { chat: 'failed' })
    for (const reason of ['stopped', 'interrupted']) {
      assert.deepEqual(parseSessionStages({ activity: { chat: { stage, recovery: { id: 'turn', reason } } } }), { chat: stage })
    }
  }
  for (const stage of ['llm', 'tool', 'waiting', 'rate-limit']) {
    assert.equal(parseSessionStages({ activity: { chat: { stage, recovery } } }).chat, stage)
  }
  assert.equal(parseSessionStages({ activity: {} }).chat, undefined)
})
