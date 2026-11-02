import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupFolderSessions, recentSidebarSessions, type SidebarSession } from './folders-sidebar.ts'

function session(index: number, extra: Partial<SidebarSession> = {}): SidebarSession {
  return { sessionId: `web:${index}`, label: `Session ${index}`, lastActivityAt: new Date(2026, 0, index + 1).toISOString(),
    isDirectChat: true, isCurrent: true, parentSessionId: null, depth: 0, mode: 'session', ...extra }
}
test('project navigation retains ten newest rows without changing the source', () => {
  const source = Array.from({ length: 20 }, (_, i) => session(i))
  const result = recentSidebarSessions(source, '')
  assert.equal(result.length, 10)
  assert.equal(result[0].sessionId, 'web:19')
  assert.equal(source.length, 20)
  assert.equal(source[0].sessionId, 'web:0')
})
test('an older active session stays within the limit and drafts count as activity', () => {
  const source = Array.from({ length: 20 }, (_, i) => session(i))
  const result = recentSidebarSessions(source, 'web:0', 10, new Map([['web:1', Date.now()]]))
  assert.equal(result.length, 10)
  assert.equal(result[0].sessionId, 'web:1')
  assert.ok(result.some(s => s.sessionId === 'web:0'))
  assert.deepEqual(recentSidebarSessions([], ''), [])
  assert.deepEqual(recentSidebarSessions(source, '', 0), [])
})
test('one cap spans folders; non-project views keep their full list', () => {
  const source = Array.from({ length: 20 }, (_, i) => session(i, { folderId: i % 2 ? 'folder-a' : undefined }))
  assert.equal(groupFolderSessions([], source).unified.length, 20)
  const limited = groupFolderSessions([], source, { activeSessionId: 'web:0' })
  assert.equal(limited.unified.length, 10)
  assert.ok(limited.unified.some(s => s.sessionId === 'web:0'))
})

test('limiting rows preserves automation runs and excludes transient tasks', () => {
  const source = Array.from({ length: 20 }, (_, i) => session(i))
  source.push(session(30, { automation: { jobId: 'job', name: 'Scheduled', runId: 'run', startedAt: new Date().toISOString(), contextMode: 'fresh' } }))
  source.push(session(31, { mode: 'task', parentSessionId: 'web:19' }))
  const limited = groupFolderSessions([], source, { activeSessionId: '' })
  assert.equal(limited.unified.length, 10)
  assert.equal(limited.automations[0]?.sessions[0]?.sessionId, 'web:30')
  assert.ok(!limited.unified.some(s => s.sessionId === 'web:31'))
})
