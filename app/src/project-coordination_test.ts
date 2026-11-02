import assert from 'node:assert/strict'
import test from 'node:test'
import { conversationMicroAppLink, conversationLinkSession, isDirectConversation, parseConversationTopic } from './project-coordination.ts'
import { groupFolderSessions, parseSessionGraph, visibleSessions } from './folders-sidebar.ts'
import { childConversationTarget } from './conversation-split.ts'
import { parseSessionDetails, sessionDisplayFocus } from './session-details.ts'

const topic = 'Release readiness'


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
  assert.equal(groups.chats[0]!.label, topic)
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
  assert.deepEqual(parseConversationTopic(topic), topic)
  for (const invalid of [null, {}, [], 2]) {
    assert.throws(() => parseConversationTopic(invalid), /topic metadata/)
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

test('current focus falls back to topic while sidebar labels remain stable', () => {
  const session = { sessionId: 'web:chat-topic', topic: 'Overall topic', focus: 'Debugging a subtask', name: 'Old name' }
  assert.equal(sessionDisplayFocus(session), 'Debugging a subtask')
  assert.equal(sessionDisplayFocus({ ...session, focus: '' }), 'Overall topic')
  assert.equal(sessionDisplayFocus({ ...session, focus: undefined }), 'Overall topic')
  const parsed = parseSessionGraph({ sessions: [session], nodes: [] })
  assert.equal(parsed[0].label, 'Overall topic')
  assert.equal(parsed[0].focus, 'Debugging a subtask')
})

test('app review links preserve the app query for in-workbench navigation', () => {
  const path = '/projects/project%20a/chat/web%3Achat-topic'
  for (const prefix of ['', '#']) {
    assert.deepEqual(conversationMicroAppLink(`${prefix}${path}?microApp=7bcbc32d-c255-4ea1-bc25-3624a4f66300`, 'project a'), {
      path, query: { microApp: '7bcbc32d-c255-4ea1-bc25-3624a4f66300' },
    })
  }
  for (const href of [
    `${path}?microApp=`, `${path}?microApp=a&microApp=b`, `${path}?microApp=%2Fetc`,
    `https://example.com${path}?microApp=a`, '/projects/other/chat/web:chat-topic?microApp=a',
    '/projects/project%20a/chat/%2Fetc?microApp=a', `${path}?other=a`,
  ]) assert.equal(conversationMicroAppLink(href, 'project a'), undefined)
})
