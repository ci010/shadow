import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { isQuickOpenBackdropPoint, isSessionQuickOpenShortcut, matchesSessionTitle, searchQuickOpenSessions } from './session-quick-open.ts'

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

test('quick open keeps ordinary defaults and searches automation without admitting unrelated tasks or children', () => {
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
  assert.deepEqual(searchQuickOpenSessions(rows, '').map(s => s.sessionId), ['legacy', 'regular'])
  assert.deepEqual(searchQuickOpenSessions(rows, 'review').map(s => s.sessionId), ['automation', 'legacy', 'regular'])
})

test('project filter combines with title search and regular-session filtering', () => {
  const rows = [
    { projectId: 'default', sessionId: 'a', label: 'Review' },
    { projectId: 'xmcl', sessionId: 'b', label: 'Review XMCL' },
    { projectId: 'xmcl', sessionId: 'c', label: 'Other' },
    { projectId: 'xmcl', sessionId: 'd', label: 'Review task', mode: 'task' as const },
  ]
  assert.deepEqual(searchQuickOpenSessions(rows, '', ['default', 'xmcl'], 'xmcl').map(s => s.sessionId), ['b', 'c'])
  assert.deepEqual(searchQuickOpenSessions(rows, 'review', ['default', 'xmcl'], 'xmcl').map(s => s.sessionId), ['b'])
  assert.deepEqual(searchQuickOpenSessions(rows, 'review', ['default', 'xmcl'], '').map(s => s.sessionId), ['a', 'b'])
  assert.deepEqual(searchQuickOpenSessions(rows, '', ['default', 'xmcl'], 'missing'), [])
})

test('backdrop detection excludes the dialog content, padding and border', () => {
  const bounds = { left: 100, right: 700, top: 80, bottom: 500 }
  for (const point of [{ clientX: 99, clientY: 100 }, { clientX: 701, clientY: 100 },
    { clientX: 300, clientY: 79 }, { clientX: 300, clientY: 501 }]) {
    assert.equal(isQuickOpenBackdropPoint(point, bounds), true)
  }
  for (const point of [{ clientX: 100, clientY: 80 }, { clientX: 700, clientY: 500 }, { clientX: 300, clientY: 200 }]) {
    assert.equal(isQuickOpenBackdropPoint(point, bounds), false)
  }
})
