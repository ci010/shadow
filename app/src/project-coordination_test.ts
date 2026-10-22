import assert from 'node:assert/strict'
import test from 'node:test'
import { conversationLinkSession, isDirectConversation, parseTopicMetadata } from './project-coordination.ts'
import { ensureProjectOrchestrator } from './projects.ts'
import { groupFolderSessions, parseSessionGraph, visibleSessions } from './folders-sidebar.ts'
import { childConversationTarget } from './conversation-split.ts'
import { parseSessionDetails } from './session-details.ts'

const topic = { title: 'Release readiness', goal: 'Ship the desktop build', scope: 'Windows installer', nonGoals: 'Linux packages' }

test('coordination ensure is scoped, empty, abortable, and validates canonical identity', async () => {
  const controller = new AbortController()
  const result = await ensureProjectOrchestrator('http://fixture', 'project a', controller.signal, async (url, init) => {
    assert.equal(String(url), 'http://fixture/projects/project%20a/api/orchestrator')
    assert.equal(init?.method, 'POST')
    assert.equal(init?.body, '{}', 'No selected folder, model turn, or draft is sent')
    controller.abort()
    assert.equal(init?.signal?.aborted, true)
    return Response.json({ projectId: 'project a', sessionId: 'web:orchestrator', chatId: 'orchestrator' })
  })
  assert.equal(result, 'web:orchestrator')
  for (const fields of [{ projectId: 'b' }, { sessionId: 'web:chat-other' }, { chatId: 'other' }]) {
    await assert.rejects(ensureProjectOrchestrator('http://fixture', 'a', new AbortController().signal, async () =>
      Response.json({ projectId: 'a', sessionId: 'web:orchestrator', chatId: 'orchestrator', ...fields })), /different Project coordinator/)
  }
  await assert.rejects(ensureProjectOrchestrator('http://fixture', 'a', new AbortController().signal, async () =>
    Response.json({}, { status: 503 })), /503/)
})

test('coordinator is writable but excluded from folder and unfiled lists, generated topics remain direct roots', () => {
  const graph = { sessions: [
    { sessionId: 'web:orchestrator', sessionKind: 'orchestrator', folderId: 'folder' },
    { sessionId: 'web:chat-topic', sessionKind: 'topic', parentSessionId: null, createdBySessionId: 'web:orchestrator', topic },
    { sessionId: 'web:chat-folder', sessionKind: 'topic', folderId: 'folder', parentSessionId: 'web:orchestrator', topic },
    { sessionId: 'task', parentSessionId: 'web:chat-topic', mode: 'task' },
  ], nodes: [
    { physicalId: 'coordinator', logicalId: 'web:orchestrator' },
    { physicalId: 'topic', logicalId: 'web:chat-topic', parentPhysicalId: 'coordinator' },
  ] }
  const sessions = parseSessionGraph(graph)
  const groups = groupFolderSessions([{ id: 'folder', name: 'Work', path: 'C:\\synthetic', createdAt: '' }], sessions)
  assert.deepEqual(groups.chats.map(s => s.sessionId), ['web:chat-topic'])
  assert.deepEqual(groups.folders[0]!.sessions.map(s => s.sessionId), ['web:chat-folder'])
  assert.ok(groups.chats[0]!.isDirectChat)
  assert.equal(groups.chats[0]!.label, topic.title)
  assert.equal(groups.chats[0]!.createdBySessionId, 'web:orchestrator')
  assert.equal(groups.chats[0]!.depth, 0)
  assert.equal(childConversationTarget(sessions, 'web:chat-topic', 'web:orchestrator'), null)
  assert.equal(visibleSessions(groups.chats, new Set(['web:orchestrator'])).length, 1)
  assert.ok(isDirectConversation('web:orchestrator'))
  assert.equal(isDirectConversation('web:orchestrator', 'task'), false)
  assert.equal(isDirectConversation('task'), false)
  assert.deepEqual(parseSessionGraph(structuredClone(graph)), sessions, 'SSE list refresh preserves metadata and navigation')
})

test('topic details validate wire metadata and retain unknown historical fields as absent', () => {
  assert.deepEqual(parseTopicMetadata(topic), topic)
  for (const invalid of [null, {}, { ...topic, scope: [] }, { ...topic, nonGoals: 2 }]) {
    assert.throws(() => parseTopicMetadata(invalid), /topic metadata/)
  }
  const parsed = parseSessionDetails({ sessionId: 'web:chat-topic', name: null, sessionKind: 'topic', topic,
    createdBySessionId: 'web:orchestrator', workdir: { kind: 'local', displayPath: null },
    usage: null, usageScope: 'session', context: { usedTokens: null, windowTokens: null } }, 'web:chat-topic')
  assert.deepEqual(parsed.topic, topic)
  assert.equal(parsed.createdBySessionId, 'web:orchestrator')
})

test('only same-project conversation receipts navigate inside the app, including Electron hash paths', () => {
  assert.equal(conversationLinkSession('/projects/project%20a/chat/web%3Achat-topic', 'project a'), 'web:chat-topic')
  assert.equal(conversationLinkSession('#/projects/a/chat/web:orchestrator', 'a'), 'web:orchestrator')
  for (const href of ['/projects/b/chat/web:chat-topic', 'https://outside.invalid/projects/a/chat/id',
    '//outside.invalid/projects/a/chat/id', '/projects/a/chat/id?child=task', '/projects/a/chat/%ZZ',
    '/projects/a/chat/%2Fetc', 'javascript:alert(1)']) assert.equal(conversationLinkSession(href, 'a'), undefined)
})
