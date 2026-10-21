import assert from 'node:assert/strict'
import test from 'node:test'
import { apiUrl, hostBase, projectBase, sessionKey } from './api-url.ts'
import { createProjectsClient, fetchProjectConversations, parseProjects, parseProjectRuntimeStatus } from './projects.ts'
import { createConversationResources } from './project-workspaces.ts'
import { groupFolderSessions, parseSessionGraph } from './folders-sidebar.ts'
import { createFoldersClient } from './folders-client.ts'
import { createRemoteChatDraft } from './remote-conversations.ts'
import { createChatDraft } from './chat-draft.ts'
import { buildMediaUrl } from './media-url.ts'
import { useSessionFiles } from './composables/useSessionFiles.ts'
import { fileWorkspaceKey } from './file-tree-state.ts'
import { createProjectSettingsClient, mergeProjectSettings, parseProjectConfig } from './project-settings.ts'
import { botDraft, botPatch, createBotSettingsClient, parseBotList, parseBotStatus } from './bot-settings.ts'
import type { BotInstanceStatus } from './bot-settings.ts'

const org = (id: string) => ({ id, name: 'Same name', createdAt: '2026-09-14T00:00:00Z' })
const folder = { id: 'same-folder-id', name: 'Same name', path: 'C:\\synthetic-folder', createdAt: '2026-09-14T00:00:00Z' }
const baseA = projectBase('http://fixture', 'a')
const baseB = projectBase('http://fixture', 'b')

test('central API resolution scopes snapshots and files to projects but shared live updates to the host', () => {
  for (const suffix of ['/api/sessions', '/api/folders', '/api/config', '/api/channels', '/v1/query/logs',
    '/api/chat/upload', '/api/media', '/debug/models', '/api/sessions/web%3Achat-a/raw']) {
    assert.equal(apiUrl(baseA, suffix).pathname, `/projects/a${suffix}`)
    assert.equal(apiUrl('http://fixture', suffix).pathname, suffix, 'Fixed root compatibility remains available')
  }
  for (const bad of ['https://other.invalid', '//other.invalid/api', '/../../api/config', '/..\\api/config']) {
    assert.throws(() => apiUrl(baseA, bad))
  }
  assert.equal(hostBase(baseA), 'http://fixture')
  assert.equal(apiUrl(hostBase(baseA), '/api/live').pathname, '/api/live')
  const files = useSessionFiles(baseA)
  assert.equal(new URL(files.rawUrl('web:chat-same', 'a #.pdf')).pathname, '/projects/a/api/sessions/web%3Achat-same/raw')
  const html = files.staticUrl('web:chat-same', 'docs/index.html')
  assert.equal(new URL('style.css', html).pathname, '/projects/a/api/sessions/web%3Achat-same/static/docs/style.css')
  assert.equal(new URL(buildMediaUrl(baseB, 'web:chat-same', 'image.png')!).pathname, '/projects/b/api/media')
})

test('catalog and tree grouping use IDs, keep scratch chats and reflection inside their owner', () => {
  assert.deepEqual(parseProjects({ projects: [org('a'), org('b')] }).map(item => item.id), ['a', 'b'])
  assert.throws(() => parseProjects({ projects: [org('a'), org('a')] }), /duplicate/)
  for (const id of ['a', 'b']) {
    const sessions = parseSessionGraph({ nodes: [], sessions: [
      { projectId: id, sessionId: 'web:chat-folder', folderId: folder.id, title: 'Same name' },
      { projectId: id, sessionId: 'web:chat-scratch', title: 'Same name' },
      { projectId: id, sessionId: 'heartbeat:reflector-123', title: 'Same name',
        automation: { jobId: 'fresh', name: 'Same name', runId: 'run', startedAt: '2026-09-16T00:00:00Z', contextMode: 'fresh' } },
    ] }, id)
    const groups = groupFolderSessions([folder], sessions)
    assert.deepEqual(groups.folders[0].sessions.map(item => item.sessionId), ['web:chat-folder'])
    assert.deepEqual(groups.chats.map(item => item.sessionId), ['web:chat-scratch'])
    assert.deepEqual(groups.automations[0].sessions.map(item => item.sessionId), ['heartbeat:reflector-123'])
  }
  assert.throws(() => parseSessionGraph({ nodes: [], sessions: [{ projectId: 'b', sessionId: 'web:chat-same' }] }, 'a'), /Cannot read/)
  assert.throws(() => parseSessionGraph({ nodes: [], sessions: [{ projectId: 'a', parentProjectId: 'b', sessionId: 'web:chat-same' }] }, 'a'), /Cannot read/)
  assert.notEqual(sessionKey({ projectId: 'a', sessionId: 'b:c' }), sessionKey({ projectId: 'a:b', sessionId: 'c' }))
})

test('failed org resources do not block concurrent graphs or erase their independent stages', async () => {
  const request: typeof fetch = async input => {
    const url = new URL(String(input))
    if (url.pathname === '/projects/a/api/sessions/graph') return new Response('', { status: 503 })
    if (url.pathname.endsWith('/graph')) return Response.json({ sessions: [{ sessionId: 'web:chat-same' }], nodes: [] })
    return Response.json({ stages: { 'web:chat-same': 'llm' } })
  }
  const [a, b] = await Promise.all(['a', 'b'].map(id => fetchProjectConversations('http://fixture', id, new AbortController().signal, request)))
  assert.match(a.sessionsError, /503/)
  assert.equal(b.sessionsError, '')
  assert.equal(b.sessions[0].sessionId, 'web:chat-same')
})

test('draft preparation remains captured to its project while another org opens or sends the same session ID', async () => {
  const registry = createConversationResources()
  const a = registry.draft('a', folder)
  const b = registry.draft('b', folder)
  assert.notEqual(a.key, b.key)
  assert.equal(registry.draft('a', folder), a)
  let release!: (response: Response) => void
  const urls: string[] = []
  const draft = createChatDraft(createFoldersClient(baseA, async input => {
    urls.push(String(input))
    return new Promise(resolve => { release = resolve })
  }), folder)
  assert.equal(urls.length, 0, 'Opening folders does not create sessions')
  const pending = draft.prepare()
  const samePending = draft.prepare()
  const openedB = registry.session({ projectId: 'b', sessionId: 'web:chat-same' })
  release(Response.json({ sessionId: 'web:chat-same', chatId: 'chat-same' }))
  const id = await pending
  assert.equal(await samePending, id)
  assert.deepEqual(urls, ['http://fixture/projects/a/api/folders/same-folder-id/sessions'])
  const adopted = registry.prepared(a.key, id)
  assert.equal(adopted.key, a.key)
  assert.equal(registry.session({ projectId: 'a', sessionId: id }), a)
  assert.notEqual(adopted, openedB)
  assert.equal(openedB.projectId, 'b')
  assert.notEqual(registry.draft('a', folder).key, adopted.key)
  assert.notEqual(fileWorkspaceKey({ apiBase: baseA, sessionId: id }), fileWorkspaceKey({ apiBase: baseB, sessionId: id }))
  assert.equal(await draft.prepare(), id, 'Retry reuses the first session')
})

test('remote preparation preserves org and opaque capability, with no local fallback', async () => {
  const target = { nodeId: 'remote', capabilityId: 'workdir', nodeName: 'Laptop', displayName: 'Same name', available: true }
  let calls = 0
  const draft = createRemoteChatDraft(baseB, target, async (input, init) => {
    calls++
    assert.equal(String(input), `${baseB}api/sessions/remote`)
    const body = JSON.parse(String(init?.body))
    assert.deepEqual(body, { nodeId: 'remote', capabilityId: 'workdir', requestId: body.requestId })
    assert.match(body.requestId, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/)
    return new Response('', { status: 503 })
  })
  assert.equal(calls, 0)
  await assert.rejects(draft.prepare(), /No local folder was used/)
})

test('project config merges only the requested owned section, preserving Home, shared credentials and unrelated settings', async () => {
  const config = parseProjectConfig({ agent: { model: 'model-a', workspace: 'C:\\org-a', temperature: .7 }, providers: { shared: { apiKey: '***' } }, channels: {}, learning: { reflectIntervalMs: 60_000 } })
  const next = mergeProjectSettings(config, 'agent', { model: 'model-next', reasoningEffort: 'high' })
  assert.equal(config.agent.model, 'model-a')
  assert.equal(next.agent.model, 'model-next')
  assert.deepEqual(next.providers, config.providers)
  assert.deepEqual(next.learning, config.learning)
  assert.throws(() => mergeProjectSettings(config, 'agent', { workspace: 'C:\\org-b' }), /not project-owned/)
  const calls: string[] = []
  const client = createProjectSettingsClient(baseA, async (input, init) => {
    calls.push(String(input))
    if (init?.method === 'PATCH') return Response.json(JSON.parse(String(init.body)))
    return Response.json(config)
  })
  const saved = await client.save('agent', { model: 'model-next' })
  assert.equal(saved.agent.model, 'model-next')
  assert.deepEqual(calls, [`${baseA}api/config`, `${baseA}api/config`])
})

const bot = (id: string, projectId = 'a'): BotInstanceStatus => ({
  id, projectId, platform: 'qq', displayName: 'Same bot name', label: 'QQ', enabled: false,
  configured: true, state: 'disabled', config: { appId: `fixture-${id}` }, secrets: { secret: true },
})

test('multiple same-platform bots have independent identities, drafts, secrets and connection updates', async () => {
  const a = bot('one'), b = bot('two')
  assert.equal(parseBotList({ channels: [a, b] }, 'a').length, 2)
  assert.throws(() => parseBotList({ channels: [a, a] }, 'a'), /duplicate/)
  assert.throws(() => parseBotStatus(bot('one', 'b'), 'a'), /ownership/)
  const drafts = { one: botDraft(a), two: botDraft(b) }
  drafts.one.displayName = 'Renamed first bot'
  drafts.one.secret = 'synthetic replacement'
  assert.equal(drafts.two.secret, '')
  const calls: string[] = []
  const client = createBotSettingsClient(baseA, 'a', async (input, init) => {
    calls.push(String(input))
    const body = JSON.parse(String(init?.body))
    assert.equal(body.displayName, 'Renamed first bot')
    assert.equal(body.config.secret, 'synthetic replacement')
    return Response.json({ channel: { ...a, displayName: body.displayName, state: 'connecting' } })
  })
  const result = await client.save(a.id, botPatch(a, drafts.one, true))
  assert.equal(result.state, 'connecting', 'Saving never fabricates Connected')
  assert.deepEqual(calls, [`${baseA}api/channels/one`])
  assert.equal(botPatch(b, drafts.two, true).config.secret, undefined)
})

test('catalog mutations use only host routes and require a matching returned identity', async () => {
  const client = createProjectsClient('http://fixture', async (input, init) => {
    assert.equal(String(input), 'http://fixture/api/projects/a')
    assert.deepEqual(JSON.parse(String(init?.body)), { name: 'Renamed' })
    return Response.json({ project: { ...org('a'), name: 'Renamed' } })
  })
  assert.equal((await client.save('Renamed', 'a')).name, 'Renamed')
})

test('runtime recovery uses the owning host catalog entry and rejects invented success states', async () => {
  const calls: Array<[string, string]> = []
  const client = createProjectsClient('http://fixture', async (input, init) => {
    calls.push([String(input), init?.method ?? 'GET'])
    return Response.json({ state: init?.method === 'POST' ? 'ready' : 'failed' })
  })
  assert.equal((await client.status('org a')).state, 'failed')
  assert.equal((await client.retry('org a')).state, 'ready')
  assert.deepEqual(calls, [
    ['http://fixture/api/projects/org%20a/status', 'GET'],
    ['http://fixture/api/projects/org%20a/retry', 'POST'],
  ])
  for (const result of [{ success: true }, { state: 'connected' }, { state: 'ready', error: 3 }]) {
    assert.throws(() => parseProjectRuntimeStatus(result), /invalid project runtime status/)
  }
})

test('project deletion uses the host, validates the exact identity and reports busy errors without success', async () => {
  const calls: string[] = []
  const client = createProjectsClient('http://fixture', async (input, init) => {
    assert.equal(init?.method, 'DELETE')
    calls.push(String(input))
    return Response.json({ deletedProjectId: 'a' })
  })
  await client.remove('a')
  assert.deepEqual(calls, ['http://fixture/api/projects/a'])
  await assert.rejects(client.remove('default'), /Default/)
  assert.equal(calls.length, 1)
  await assert.rejects(createProjectsClient('http://fixture', async () => Response.json({ deletedProjectId: 'b' })).remove('a'), /did not confirm/)
  await assert.rejects(createProjectsClient('http://fixture', async () =>
    Response.json({ message: 'Stop active work before deleting.' }, { status: 409 })).remove('a'), /Stop active work/)
})

test('deleting a project forgets only its mounted conversations and drafts', () => {
  const registry = createConversationResources()
  const a = registry.session({ projectId: 'a', sessionId: 'same' })
  registry.draft('a', folder)
  const b = registry.session({ projectId: 'b', sessionId: 'same' })
  const draftB = registry.draft('b')
  registry.removeProject('a')
  assert.deepEqual(registry.resources, [b, draftB])
  assert.equal(registry.session(b), b)
  assert.throws(() => registry.prepared(a.key, 'late-session'), /unavailable/)
})


test('deleted last conversation cannot be restored by resources or cross-Project selection', () => {
  const registry = createConversationResources()
  const sent = registry.draft('a')
  registry.prepared(sent.key, 'web:deleted')
  const other = registry.session({ projectId: 'b', sessionId: 'web:deleted' })
  registry.removeSession({ projectId: 'a', sessionId: 'web:deleted' })
  assert.equal(registry.resources.some(resource => resource.projectId === 'a'), false)
  assert.equal(registry.resources[0], other)
  const next = registry.draft('a')
  assert.equal(next.sessionId, '')
  assert.equal(registry.draft('new-project').sessionId, '')
  assert.equal(registry.draft('a'), next)
})
