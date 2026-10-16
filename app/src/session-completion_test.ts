import assert from 'node:assert/strict'
import test from 'node:test'
import { parseSessionGraph, groupFolderSessions } from './folders-sidebar.ts'

test('explicit completion survives graph parsing and grouping without replacing inferred execution status', () => {
  const sessions = parseSessionGraph({ sessions: [
    { sessionId: 'web:done', completed: true, executionStatus: 'running' },
    { sessionId: 'web:open', completed: false, executionStatus: 'waiting' },
    { sessionId: 'web:legacy', executionStatus: 'completed' },
  ], nodes: [] })
  assert.deepEqual(sessions.map(s => [s.completed, s.executionStatus]), [
    [true, 'running'], [false, 'waiting'], [false, 'completed'],
  ])
  const chats = groupFolderSessions([], sessions).chats
  assert.equal(chats.find(s => s.sessionId === 'web:done')?.completed, true)
  assert.equal(chats.find(s => s.sessionId === 'web:legacy')?.completed, false)
})
