import assert from 'node:assert/strict'
import test from 'node:test'
import { isLearningSourceReady, LEARNING_SOURCE_QUIET_MS } from './source-eligibility.ts'
import type { SessionState } from '../../sessions/session-store.ts'
import { fakeSessions } from './test-fixtures.ts'
import { LearningRuntime } from './pipelines.ts'
import { physicalSessionId } from '../../sessions/session-identity.ts'
import { withTempWorkspace } from '../../testing/workspace.ts'

const now = Date.parse('2026-11-17T12:00:00.000Z')
const iso = (delta: number) => new Date(now + delta).toISOString()
const quiet: SessionState = { sessionId: 'web:a', segmentIndex: 0, lastActivityAt: iso(-LEARNING_SOURCE_QUIET_MS) }
const signal = () => new AbortController().signal

test('readiness uses latest clock, strict validity, busy and execution barriers', () => {
  const ready = (patch: Partial<SessionState> = {}, busy = false) => isLearningSourceReady({ ...quiet, ...patch }, busy, now)
  assert(ready())
  assert(!ready({}, true))
  for (const executionStatus of ['pending', 'running', 'waiting'] as const) assert(!ready({ executionStatus }))
  for (const executionStatus of ['completed', 'failed', 'cancelled'] as const) assert(ready({ executionStatus }))
  assert(!ready({ lastUserMessageAt: iso(-1) }))
  assert(!ready({ lastActivityAt: iso(-1), lastUserMessageAt: iso(-2 * LEARNING_SOURCE_QUIET_MS) }))
  assert(!ready({ lastActivityAt: undefined }))
  assert(ready({ lastActivityAt: undefined, lastUserMessageAt: iso(-LEARNING_SOURCE_QUIET_MS) }))
  for (const bad of ['bad', '', iso(1)]) {
    assert(!ready({ lastActivityAt: bad }))
    assert(!ready({ lastUserMessageAt: bad }))
  }
  assert(!isLearningSourceReady(undefined, false, now))
})

test('only fresh host completion bypasses quiet time; later input retains display but loses shortcut', () => {
  const recent = { ...quiet, completed: true, lastActivityAt: iso(-1), lastUserMessageAt: iso(-100) }
  assert(!isLearningSourceReady(recent, false, now)) // legacy completed is display-only
  assert(isLearningSourceReady({ ...recent, completedAt: iso(-50) }, false, now))
  assert(!isLearningSourceReady({ ...recent, completedAt: iso(-101) }, false, now))
  assert(!isLearningSourceReady({ ...recent, completedAt: iso(-50), lastUserMessageAt: iso(-10) }, false, now))
  for (const completedAt of ['bad', iso(1)]) assert(!isLearningSourceReady({ ...recent, completedAt }, false, now))
  assert(!isLearningSourceReady({ ...recent, completedAt: iso(-50), lastUserMessageAt: undefined }, false, now))
  assert(!isLearningSourceReady({ ...recent, completedAt: iso(-50) }, true, now))
})

function setup(workspace: string, ids = ['web:a']) {
  const f = fakeSessions(workspace, ids.map(sessionId => ({ sessionId, segmentIndex: 0, total: 5 })))
  const runtime = new LearningRuntime(f.sessions, 'a')
  const busy = new Set<string>()
  f.sessions.isSessionBusy = id => busy.has(id)
  f.onRun(async id => runtime.ledger.propose(runtime.ledger.batchFor(id)!.id, 'no_change', 'Reviewed pinned evidence.'))
  return { ...f, runtime, busy }
}

test('busy old pending waits unchanged, does not starve ready source, then resumes exact original range', async () => withTempWorkspace(async workspace => {
  const f = setup(workspace, ['web:a', 'web:b'])
  const state = f.records.get('web:a')!
  const source = { sessionId: state.sessionId, physicalId: physicalSessionId(state, 0), segmentIndex: 0, offset: 0, end: 3 }
  const old = f.runtime.ledger.create('reflector', [source], [])
  f.runtime.ledger.propose(old.id, 'partial', 'Retained unsaved candidate.', [{
    path: 'topics/retained.md', correction: 'A supported correction', action: 'Merge with current page',
    conditions: 'After rereading original evidence', evidence: [{ sessionId: source.sessionId,
      physicalId: source.physicalId, offset: source.offset, end: source.end }],
  }])
  f.runtime.ledger.defer(old.id, false)
  f.runtime.ledger.artifact(old.id, { path: 'memory/topics/retained.md', revision: 'retained', kind: 'memory' })
  const before = f.runtime.ledger.batch(old.id)
  f.busy.add(state.sessionId)
  assert(await f.runtime.run('reflector', signal(), undefined, undefined, undefined, true))
  assert.deepEqual(f.runtime.ledger.batch(old.id), before)
  assert.equal(f.runtime.ledger.cursor(source), 0)
  assert.equal(f.runtime.ledger.selectionCursor(source), 3)
  // No other fresh work can turn manual mode into a busy-source bypass.
  assert.equal(await f.runtime.run('reflector', signal(), undefined, undefined, undefined, true), false)
  assert.deepEqual(f.runtime.ledger.batch(old.id), before)
  f.busy.delete(state.sessionId)
  // Avoid testing artifact verification here: intercept admission and inspect its fixed range.
  f.onRun(async id => {
    const batch = f.runtime.ledger.batchFor(id)!
    assert.equal(batch.id, old.id)
    assert.deepEqual(batch.sources, [source])
    f.runtime.ledger.propose(batch.id, 'partial', 'Retained original range and effects.')
  })
  await assert.rejects(f.runtime.run('reflector', signal(), undefined, undefined, undefined, true), /partial/)
  assert.equal(f.runtime.ledger.cursor(source), 0)
  assert.deepEqual(f.runtime.ledger.batch(old.id).sources, [source])
}))

for (const stage of ['count', 'history', 'dispatch'] as const) {
  test(`activity during asynchronous ${stage} read prevents dispatch, then fixed pending range can recover`, async () => withTempWorkspace(async workspace => {
    const f = setup(workspace)
    const original = f.sessions.getHistory.bind(f.sessions)
    let calls = 0
    const target = { count: 1, history: 2, dispatch: 3 }[stage]
    f.sessions.getHistory = async (...args) => {
      const result = await original(...args)
      if (++calls === target) f.records.get('web:a')!.lastUserMessageAt = new Date().toISOString()
      return result
    }
    assert.equal(await f.runtime.run('reflector', signal()), false)
    assert.equal(f.started.length, 0)
    const pending = f.runtime.ledger.pending('reflector')
    if (pending) {
      assert.equal(pending.state, 'pending')
      assert.equal(pending.retry, undefined)
      assert.deepEqual(pending.attempts, [])
      assert.equal(f.runtime.ledger.cursor(pending.sources[0]), 0)
    }
    f.sessions.getHistory = original
    f.records.get('web:a')!.lastUserMessageAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()
    assert(await f.runtime.run('reflector', signal()))
    if (pending) assert.deepEqual(f.runtime.ledger.batch(pending.id).sources, pending.sources)
  }))
}

test('manual pending retry respects new user activity despite completed display and later resumes original range', async () => withTempWorkspace(async workspace => {
  const f = setup(workspace)
  const source = (await f.runtime.sources(signal()))[0]
  const batch = f.runtime.ledger.create('reflector', [source], [])
  const state = f.records.get('web:a')!
  state.completed = true
  state.completedAt = new Date(Date.now() - 10_000).toISOString()
  state.lastUserMessageAt = new Date().toISOString()
  const before = f.runtime.ledger.batch(batch.id)
  assert.equal(await f.runtime.run('reflector', signal(), undefined, undefined, undefined, true), false)
  assert.equal(state.completed, true)
  assert.equal(f.started.length, 0)
  assert.deepEqual(f.runtime.ledger.batch(batch.id), before)
  assert.equal(f.runtime.ledger.cursor(source), 0)
  state.lastActivityAt = state.lastUserMessageAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()
  assert(await f.runtime.run('reflector', signal(), undefined, undefined, undefined, true))
  assert.deepEqual(f.runtime.ledger.batch(batch.id).sources, [source])
}))

test('host busy barrier is rechecked after dispatch-history await without altering retry', async () => withTempWorkspace(async workspace => {
  const f = setup(workspace)
  const source = (await f.runtime.sources(signal()))[0]
  const batch = f.runtime.ledger.create('reflector', [source], [])
  const before = f.runtime.ledger.batch(batch.id)
  const original = f.sessions.getHistory.bind(f.sessions)
  f.sessions.getHistory = async (...args) => {
    const result = await original(...args)
    if (args[1]?.maxMessages) f.busy.add('web:a')
    return result
  }
  assert.equal(await f.runtime.run('reflector', signal(), undefined, undefined, undefined, true), false)
  assert.deepEqual(f.runtime.ledger.batch(batch.id), before)
  assert.equal(f.started.length, 0)
  f.sessions.getHistory = original
  f.busy.clear()
  assert(await f.runtime.run('reflector', signal(), undefined, undefined, undefined, true))
}))
