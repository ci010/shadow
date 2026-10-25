import assert from 'node:assert/strict'
import test from 'node:test'
import { conversationLinkSession, isDirectConversation, parseTopicMetadata } from './project-coordination.ts'
import { groupFolderSessions, parseSessionGraph, visibleSessions } from './folders-sidebar.ts'
import { childConversationTarget } from './conversation-split.ts'
import { parseSessionDetails } from './session-details.ts'

const topic = { title: 'Release readiness', goal: 'Ship the desktop build', scope: 'Windows installer', nonGoals: 'Linux packages' }


test('ordinary Web sessions are listed with durable conversations and generated topics remain direct roots', () => {
  const graph = { sessions: [
    { sessionId: 'web:chat-admin', folderId: 'folder' },
    { sessionId: 'web:chat-topic', sessionKind: 'topic', parentSessionId: null, createdBySessionId: 'web:chat-admin', topic },
    { sessionId: 'web:chat-folder', sessionKind: 'topic', folderId: 'folder', parentSessionId: 'web:chat-admin', topic },
    { sessionId: 'task', parentSessionId: 'web:chat-topic', mode: 'task' },
  ], nodes: [
    { physicalId: 'admin', logicalId: 'web:chat-admin' },
    { physicalId: 'topic', logicalId: 'web:chat-topic', parentPhysicalId: 'admin' },
  ] }
  const sessions = parseSessionGraph(graph)
  const groups = groupFolderSessions([{ id: 'folder', name: 'Work', path: 'C:\\synthetic', createdAt: '' }], sessions)
  assert.deepEqual(groups.chats.map(s => s.sessionId), ['web:chat-topic'])
  assert.deepEqual(groups.folders[0]!.sessions.map(s => s.sessionId), ['web:chat-admin', 'web:chat-folder'])
  assert.ok(groups.chats[0]!.isDirectChat)
  assert.equal(groups.chats[0]!.label, topic.title)
  assert.equal(groups.chats[0]!.createdBySessionId, 'web:chat-admin')
  assert.equal(groups.chats[0]!.depth, 0)
  assert.equal(childConversationTarget(sessions, 'web:chat-topic', 'web:chat-admin'), null)
  assert.equal(visibleSessions(groups.chats, new Set(['web:chat-admin'])).length, 1)
  assert.ok(isDirectConversation('web:chat-admin'))
  assert.equal(isDirectConversation('web:chat-admin', 'task'), false)
  assert.equal(isDirectConversation('task'), false)
  assert.deepEqual(parseSessionGraph(structuredClone(graph)), sessions, 'SSE list refresh preserves metadata and navigation')
})

test('topic details validate wire metadata and retain unknown historical fields as absent', () => {
  assert.deepEqual(parseTopicMetadata(topic), topic)
  for (const invalid of [null, {}, { ...topic, scope: [] }, { ...topic, nonGoals: 2 }]) {
    assert.throws(() => parseTopicMetadata(invalid), /topic metadata/)
  }
  const parsed = parseSessionDetails({ sessionId: 'web:chat-topic', name: null, sessionKind: 'topic', topic,
    createdBySessionId: 'web:chat-admin', workdir: { kind: 'local', displayPath: null },
    usage: null, usageScope: 'session', context: { usedTokens: null, windowTokens: null } }, 'web:chat-topic')
  assert.deepEqual(parsed.topic, topic)
  assert.equal(parsed.createdBySessionId, 'web:chat-admin')
})

test('only same-project conversation receipts navigate inside the app, including Electron hash paths', () => {
  assert.equal(conversationLinkSession('/projects/project%20a/chat/web%3Achat-topic', 'project a'), 'web:chat-topic')
  assert.equal(conversationLinkSession('#/projects/a/chat/web:chat-admin', 'a'), 'web:chat-admin')
  for (const href of ['/projects/b/chat/web:chat-topic', 'https://outside.invalid/projects/a/chat/id',
    '//outside.invalid/projects/a/chat/id', '/projects/a/chat/id?child=task', '/projects/a/chat/%ZZ',
    '/projects/a/chat/%2Fetc', 'javascript:alert(1)']) assert.equal(conversationLinkSession(href, 'a'), undefined)
})
