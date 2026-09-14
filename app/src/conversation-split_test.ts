import assert from 'node:assert/strict'
import test from 'node:test'
import { childConversationTarget, childWidthBounds, clampChildWidth, SPLIT_MIN_WIDTH } from './conversation-split.ts'
import { groupProjectSessions, parseSessionGraph, sessionNavigationParent, visibleSessions, type SidebarSession } from './projects-sidebar.ts'
import { ownedExecutions } from './subagent-executions.ts'

const session = (sessionId: string, parentSessionId: string | null = null): SidebarSession => ({
  sessionId, parentSessionId, label: sessionId, isDirectChat: true, isCurrent: true, depth: 0,
})
const sessions = [session('main'), session('child', 'main'), session('nested', 'child'), session('other'), session('other-child', 'other')]

test('child inspection retains its open ancestor or selects the correct root', () => {
  assert.deepEqual(childConversationTarget(sessions, 'child', 'main'), { primaryId: 'main', childId: 'child' })
  assert.deepEqual(childConversationTarget(sessions, 'nested', 'main'), { primaryId: 'main', childId: 'nested' })
  assert.deepEqual(childConversationTarget(sessions, 'nested', 'child'), { primaryId: 'child', childId: 'nested' })
  assert.deepEqual(childConversationTarget(sessions, 'other-child', 'main'), { primaryId: 'other', childId: 'other-child' })
  assert.deepEqual(childConversationTarget(sessions, 'nested', ''), { primaryId: 'main', childId: 'nested' })
  assert.equal(childConversationTarget(sessions, 'main', 'child'), null)
})

test('missing and cyclic lineage does not open an unrelated or recursive pane', () => {
  assert.equal(childConversationTarget(sessions, 'missing', 'main'), null)
  assert.equal(childConversationTarget([session('child', 'missing')], 'child', 'main'), null)
  assert.equal(childConversationTarget([session('a', 'b'), session('b', 'a')], 'b', 'a'), null)
})

test('actual null-owner reusable fork wire retains side-pane and nested tree ancestry without agent ownership', () => {
  const graph = {
    sessions: [
      { sessionId: 'web:chat-root', mode: 'session', parentSessionId: null, current: 'root-new' },
      { sessionId: 'web:chat-fork', mode: 'session', parentSessionId: null, parent: { id: 'web:chat-root' }, current: 'fork' },
      { sessionId: 'web:chat-nested-fork', mode: 'session', parentSessionId: null, parent: { id: 'web:chat-fork' }, current: 'nested-fork' },
      { sessionId: 'task', mode: 'task', parentSessionId: 'web:chat-fork', current: 'task' },
      { sessionId: 'call', mode: 'call', parentSessionId: 'task', current: 'call' },
      { sessionId: 'unowned-call', mode: 'call', parentSessionId: null, current: 'unowned-call' },
    ],
    nodes: [
      { physicalId: 'root', logicalId: 'web:chat-root' },
      { physicalId: 'root-new', logicalId: 'web:chat-root', parentPhysicalId: 'root' },
      { physicalId: 'fork', logicalId: 'web:chat-fork', parentPhysicalId: 'root' },
      { physicalId: 'nested-fork', logicalId: 'web:chat-nested-fork', parentPhysicalId: 'fork' },
      { physicalId: 'task', logicalId: 'task', parentPhysicalId: 'root' },
      { physicalId: 'call', logicalId: 'call', parentPhysicalId: 'root' },
      { physicalId: 'unowned-call', logicalId: 'unowned-call', parentPhysicalId: 'root' },
    ],
  }
  const sessions = parseSessionGraph(graph)
  assert.equal(sessions.find(item => item.sessionId === 'web:chat-fork')?.parentSessionId, null)
  assert.equal(sessionNavigationParent(sessions.find(item => item.sessionId === 'web:chat-fork')), 'web:chat-root')
  assert.deepEqual(childConversationTarget(sessions, 'web:chat-fork', 'web:chat-root'), { primaryId: 'web:chat-root', childId: 'web:chat-fork' })
  assert.deepEqual(childConversationTarget(sessions, 'web:chat-nested-fork', 'web:chat-fork'), { primaryId: 'web:chat-fork', childId: 'web:chat-nested-fork' })
  assert.deepEqual(childConversationTarget(sessions, 'call', 'web:chat-fork'), { primaryId: 'web:chat-fork', childId: 'call' })
  assert.equal(childConversationTarget(sessions, 'unowned-call', 'web:chat-root'), null)
  assert.deepEqual(ownedExecutions(sessions, 'web:chat-root'), [])
  assert.deepEqual(ownedExecutions(sessions, 'web:chat-fork').map(item => item.sessionId), ['task'])
  assert.deepEqual(ownedExecutions(sessions, 'task').map(item => item.sessionId), ['call'])
  const rows = groupProjectSessions([], sessions).chats
  assert.deepEqual(rows.slice(0, 3).map(item => [item.sessionId, item.depth, item.parentSessionId]), [
    ['web:chat-root', 0, null], ['web:chat-fork', 1, null], ['web:chat-nested-fork', 2, null],
  ])
  assert.equal(visibleSessions(rows, new Set(['web:chat-root'])).some(item => item.sessionId === 'web:chat-fork'), false)
  assert.deepEqual(parseSessionGraph(structuredClone(graph)), sessions, 'Refresh preserves stable IDs and both distinct relations')
})

test('split bounds reserve readable parent and child widths and clamp dragging', () => {
  const bounds = childWidthBounds(SPLIT_MIN_WIDTH)
  assert.equal(bounds.min, 360)
  assert.ok(SPLIT_MIN_WIDTH - bounds.max - 260 - 8 >= 480)
  assert.equal(clampChildWidth(200, SPLIT_MIN_WIDTH), bounds.min)
  assert.equal(clampChildWidth(2000, SPLIT_MIN_WIDTH), bounds.max)
  assert.equal(clampChildWidth(NaN, 1400), 480)
  assert.equal(clampChildWidth(510, 1400), 510)
  assert.equal(childWidthBounds(2400).max, 800)
})
