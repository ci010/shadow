import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { isSessionQuickOpenShortcut, matchesSessionTitle, searchQuickOpenSessions } from './session-quick-open.ts'

test('title matching uses every case-insensitive token across title and label, not IDs', () => {
  const session = { title: 'Release Review', label: 'Worker Alpha' }
  assert.equal(matchesSessionTitle(session, '  REVIEW alpha '), true)
  assert.equal(matchesSessionTitle(session, 'review missing'), false)
  assert.equal(matchesSessionTitle(session, '  '), true)
  assert.equal(matchesSessionTitle({ label: 'Fallback' }, 'fall'), true)
})

test('within each project prefix precedes recency; blank queries put recent first and missing timestamps last', () => {
  const rows = [
    { projectId: 'a', sessionId: 'task', label: 'Review task', lastActivityAt: '2026-01-01' },
    { projectId: 'b', sessionId: 'chat', label: 'A review', lastActivityAt: '2026-02-01' },
    { projectId: 'a', sessionId: 'old', title: 'Review notes', label: 'Other' },
  ]
  assert.deepEqual(searchQuickOpenSessions(rows, 'review').map(row => row.sessionId), ['task', 'old', 'chat'])
  assert.deepEqual(searchQuickOpenSessions(rows, '').map(row => row.sessionId), ['task', 'old', 'chat'])
  assert.equal(rows[0]?.sessionId, 'task', 'does not mutate source snapshots')
  assert.deepEqual(searchQuickOpenSessions(rows, 'absent'), [])
})

test('shortcut accepts Ctrl or Meta Shift R and rejects unsafe events', () => {
  const event = { key: 'r', ctrlKey: true, metaKey: false, shiftKey: true, altKey: false, repeat: false, defaultPrevented: false, isComposing: false }
  assert.equal(isSessionQuickOpenShortcut(event), true)
  assert.equal(isSessionQuickOpenShortcut({ ...event, key: 'R', ctrlKey: false, metaKey: true }), true)
  for (const patch of [{ repeat: true }, { defaultPrevented: true }, { isComposing: true }, { altKey: true }, { shiftKey: false }, { ctrlKey: false }, { key: 'x' }]) {
    assert.equal(isSessionQuickOpenShortcut({ ...event, ...patch }), false)
  }
})

test('project order matches sidebar even when other projects have newer or prefix matches', () => {
  const rows = [
    { projectId: 'other', sessionId: 'new', label: 'Review', lastActivityAt: '2026-03-01' },
    { projectId: 'default', sessionId: 'old', label: 'A review', lastActivityAt: '2026-01-01' },
    { projectId: 'default', sessionId: 'newer', label: 'Another review', lastActivityAt: '2026-02-01' },
  ]
  const order = ['default', 'other']
  assert.deepEqual(searchQuickOpenSessions(rows, '', order).map(s => s.sessionId), ['newer', 'old', 'new'])
  assert.deepEqual(searchQuickOpenSessions(rows, 'review', order).map(s => s.sessionId), ['newer', 'old', 'new'])
  assert.deepEqual(searchQuickOpenSessions(rows, '', ['other', 'default']).map(s => s.sessionId), ['new', 'newer', 'old'])
})

test('quick open excludes tasks, calls, child sessions, spawned agents and automation even for exact title matches', () => {
  const base = { projectId: 'default', label: 'Review' }
  const rows = [
    { ...base, sessionId: 'regular', mode: 'session' as const, parentSessionId: null },
    { ...base, sessionId: 'legacy' },
    { ...base, sessionId: 'task', mode: 'task' as const },
    { ...base, sessionId: 'call', mode: 'call' as const },
    { ...base, sessionId: 'child', mode: 'session' as const, parentSessionId: 'regular' },
    { ...base, sessionId: 'spawned', mode: 'session' as const, createdBySessionId: 'regular' },
    { ...base, sessionId: 'automation', automation: { jobId: 'job' } },
  ]
  for (const query of ['', 'review']) {
    assert.deepEqual(searchQuickOpenSessions(rows, query).map(s => s.sessionId), ['legacy', 'regular'])
  }
})
