import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, session, type NativeImage } from 'electron'
import { Hono } from 'hono'
import { uiPlugin } from '../../../src/gateway/ui.ts'
import type { ConfiguredProvider, ProviderSetupStatus } from '../../../app/src/provider-setup.ts'
import type { GitDiff, GitStatus } from '../../../app/src/git-files.ts'
import { installDocumentTabShortcuts } from '../../src/document-tabs.js'
import { LiveFixture } from './live-fixture.ts'
import { activeWorkspaceScript } from './active-workspace.ts'

function argument(name: string): string {
  const value = process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
  assert.ok(value, `Missing ${name}`)
  return resolve(value)
}
const assets = argument('layout-assets')
const layoutMode = process.argv.find(value => value.startsWith('--conversation-layout='))?.split('=')[1]
const messageSourceMode = process.argv.includes('--message-source')
const conversationSummaryMode = process.argv.includes('--conversation-summary')
let devServer: { close(): Promise<void> } | undefined
const ui = new Hono()
uiPlugin(assets)(ui)
const directory = argument('layout-root')
for (const name of ['userData', 'sessionData', 'logs', 'crashDumps'] as const) {
  mkdirSync(join(directory, name), { recursive: true })
  app.setPath(name, join(directory, name))
}
app.setPath('home', directory)
app.commandLine.appendSwitch('disable-background-networking')
app.commandLine.appendSwitch('disable-component-update')
app.on('window-all-closed', () => {})

const idA = 'web:chat-diagnosis-a'
let providerStatus: ProviderSetupStatus = { ready: true, provider: 'custom', model: 'synthetic-model', authMode: 'none', hasApiKey: false }
const savedProviders = new Map<string, ConfiguredProvider>([
  ['custom', { provider: 'custom', authMode: 'none', hasApiKey: false, selected: true, baseUrl: 'http://127.0.0.1:11434/v1' }],
  ['openai', { provider: 'openai', authMode: 'api-key', hasApiKey: true, selected: false, baseUrl: 'https://api.openai.com/v1' }],
  ['copilot', { provider: 'copilot', authMode: 'copilot', hasApiKey: false, selected: false }],
])
let failProviderInventory = false
let failProviderSave = false
const providerSaves: Record<string, string>[] = []
let providerSaveGate: Promise<void> | undefined
const cancelledProviderLogins = new Set<string>()
const idB = 'web:chat-diagnosis-b'
const idGroup = 'test:group-authors'
const idChild = 'web:chat-split-child'
const idAgent = 'agent:split-analysis'
const idEmpty = 'web:chat-empty-root'
const idLong = `web:chat-long-label-${'identifier-'.repeat(20)}`
const longSessionTitle = '审查跨平台对话与文件目录的布局边界'.repeat(12) + ' https://example.invalid/' + 'unbroken-path-segment'.repeat(35)
const longSessionDescription = 'A synthetic long conversation description. '.repeat(100)
let sidebarEdgeCases = false
let sessionStageRequests = 0
const emptyWorkdir = 'C:\\synthetic\\managed\\empty-free-workdir'
const reflectionHome = 'C:\\synthetic\\ShadowHome'
const reflectionIds = new Set(['heartbeat:reflector-fixture', 'heartbeat:soul-reflector-fixture', 'agent:reflection-child'])
const sessionWorkdir = (id: string) => id === idEmpty ? emptyWorkdir : id === idLong ? 'C:\\synthetic\\managed\\long-conversation' : reflectionIds.has(id) ? 'C:\\synthetic\\managed\\reflection-session' : 'C:\\synthetic\\shadow'
const sidebarRelatedSessions = Array.from({ length: 12 }, (_, index) => ({
  sessionId: `agent:long-related-${index}`, title: `Related conversation ${index + 1}`, current: `physical-long-related-${index}`,
}))
const sidebarSessions = [
  { sessionId: idEmpty, title: 'Empty free conversation', current: 'physical-empty' },
  { sessionId: idLong, title: longSessionTitle, description: longSessionDescription, current: 'physical-long' },
  { sessionId: 'web:chat-reflect-named', title: 'Reflect: normal conversation', current: 'physical-normal-reflect' },
  { sessionId: 'heartbeat:reflector-fixture', title: 'Reflection fixture', current: 'physical-reflection' },
  { sessionId: 'heartbeat:soul-reflector-fixture', title: 'Soul reflection fixture', current: 'physical-soul-reflection' },
  { sessionId: 'agent:reflection-child', title: 'Reflection child fixture', current: 'physical-reflection-child' },
  ...sidebarRelatedSessions,
]
const base = Date.now() - 20000
const timestamp = (offset: number) => new Date(base + offset).toISOString()
const htmlPreviewSource = '<!doctype html>\n<html><head><title>Shortcut preview</title></head>\n<body>\n<input autofocus aria-label="Preview input" value="Preserved iframe text">\n</body>\n</html>'
const typescriptPreviewSource = '// src/main.ts\r\nexport const answer: number = 42\r\n\tconsole.log("🙂", answer)\r\n'
const editHistory = [
  { role: 'assistant', content: '', tool_calls: [
    { id: 'edit-a', function: { name: 'write', arguments: JSON.stringify({ path: 'src\\conversation.ts', match: 'old line', content: 'new line\nsecond line' }) } },
    { id: 'edit-b', function: { name: 'write', arguments: JSON.stringify({ path: 'app\\src\\components\\ToolActivityGroup.vue', content: '<template>Updated</template>' }) } },
    { id: 'edit-c', function: { name: 'invoke_tool', arguments: JSON.stringify({ name: 'write', args: { path: 'src\\conversation.ts', flag: 'a', content: 'more\n' } }) } },
    { id: 'edit-check', function: { name: 'exec', arguments: JSON.stringify({ command: 'pnpm exec node --import tsx --test app\\src\\tool-activity_test.ts', description: 'Check tool activity grouping' }) } },
  ] },
  { role: 'tool', tool_call_id: 'edit-a', content: 'Success: edit src\\conversation.ts\nUTF-8 bytes written: 42; result lines: 4.\nLine changes: +2 -1.\nL1: new line' },
  { role: 'tool', tool_call_id: 'edit-b', content: 'Success: write app\\src\\components\\ToolActivityGroup.vue\nUTF-8 bytes written: 90; result lines: 6.\nLine changes: +4 -2.\nL1: <template>Updated</template>' },
  { role: 'tool', tool_call_id: 'edit-c', content: 'Success: append src\\conversation.ts\nUTF-8 bytes written: 5; result lines: 5.\nLine changes: +1 -0.\nL5: more' },
  { role: 'tool', tool_call_id: 'edit-check', content: 'Tool activity checks passed.' },
]
const messagesA = [
  { role: 'user', name: '__compaction_summary__', content: conversationSummaryMode
    ? '## Recent Transcript Excerpt\n\n' + '- Synthetic earlier context preserved for the next turn.\n'.repeat(24)
      + '\n## Current Objective\n\nKeep the complete summary readable without an inner scrollbar.\n\n'
      + '[Reference](https://example.invalid/' + 'long-reference-'.repeat(35) + ')\n\n'
      + '## Continuation Instruction\n\nPreserve **decisions** and `inline code`.\n\n'
      + '| Item | State |\n| --- | --- |\n| Summary | Preserved |\n\n```ts\nconst summary = "safe"\n```\n\n'
      + '<span onclick="window.unsafeSummary = true">Safe content</span><script>window.unsafeSummary = true</script>'
    : 'Earlier synthetic context.' },
  { role: 'user', name: 'Direct user', content: '<sender id="direct" name="Direct user" chat="direct" />Inspect the folder and explain the result.', timestamp: timestamp(100) },
  { role: 'assistant', content: 'I will inspect the folder files.', timestamp: timestamp(1800) },
  { role: 'assistant', content: '', tool_calls: [{ id: 'call-a', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }], timestamp: timestamp(2000) },
  { role: 'tool', name: 'read_file', tool_call_id: 'call-a', content: 'Synthetic README result: the folder uses Vue.', timestamp: timestamp(3000) },
  ...editHistory,
  { role: 'user', name: 'scheduler', content: '<event type="completed" title="Background task completed" status="completed" />Synthetic event details.' },
  { role: 'assistant', content: 'The folder is a Vue application.\n\n' + 'A synthetic response, not provider output. '.repeat(60), reasoning_text: 'Synthetic reasoning', timestamp: timestamp(7000) },
  { role: 'user', content: 'Now check its architecture.', timestamp: timestamp(9000) },
  { role: 'assistant', content: 'The backend owns agent execution.\n\n' + 'More synthetic explanation. '.repeat(50) +
    '\n\n## Rendering compatibility\n\n**Strong text** and `inline code`.\n\n[Folder docs](https://example.invalid/docs)\n\n| Name | Value |\n| --- | --- |\n| Fixture | 42 |\n\n- First item\n- Second item\n\n```ts\nconst answer = 42\n```\n\nInline $x^2$.\n\n$$\\frac{1}{2}$$\n\n<span onclick="window.unsafeMarkup = true">Safe span</span><script>window.unsafeMarkup = true</script>',
    timestamp: timestamp(10000) },
]
const groupMessages = [
  { role: 'user', name: 'Alice', content: '<sender id="alice" name="Alice" chat="group" />Please check the folder structure.', timestamp: timestamp(100) },
  { role: 'assistant', name: 'Shadow', content: 'I will inspect the files and summarize the result.', timestamp: timestamp(1800) },
  messagesA[3], messagesA[4], messagesA[5 + editHistory.length],
  { role: 'user', content: '<sender id="bob" name="Bob &amp; the &lt;frontend&gt; team" chat="group" />Include the UI components, too.', timestamp: timestamp(8000) },
  { role: 'assistant', name: 'Shadow', content: 'The backend owns execution; Vue renders the conversation.\n\nThe shared corner tokens also apply to events and tool results.', usage: { promptTokens: 100, completionTokens: 25, totalTokens: 125 }, timestamp: timestamp(10000) },
]
const childMessages = [
  { role: 'user', content: 'A child-only question.', timestamp: timestamp(100) },
  { role: 'assistant', content: 'This response belongs only to the child.', timestamp: timestamp(1800) },
]
const agentMessages = [{ role: 'user', content: 'Read-only agent task.' }, { role: 'assistant', content: 'The agent is examining the files.' }]
let agentWorking = false
let agentHistoryGate: Promise<void> | undefined
let releaseAgentHistory: (() => void) | undefined
let agentHistoryRequests = 0
const chatHistoryRequests: string[] = []
const fileRequests: Array<{ sessionId: string; path: string }> = []
const previewRequests: Array<{ sessionId: string; path: string; aborted: boolean }> = []
const folderFileRequests: Array<{ folderId: string; kind: string; path: string; aborted: boolean }> = []
const folderSessionRequests: string[] = []
let failFolderSessionCreate = false
let folderPreviewGate: Promise<void> | undefined
let releaseFolderPreview: (() => void) | undefined
let folderListGate: Promise<void> | undefined
let releaseFolderList: (() => void) | undefined
const gitStates = new Map<string, GitStatus | 'error'>()
const gitDiffs = new Map<string, GitDiff>()
const gitFixtureScopes = new Set<string>()
const gitRequests: Array<{ scope: string; operation: string; path: string; aborted: boolean }> = []
let gitGate: { scope: string; operation: string; promise: Promise<void> } | undefined
let releaseGit: (() => void) | undefined
let failFiles = false
let groupTreeSessions = false
let filePreviewGate: Promise<void> | undefined
let releaseFilePreview: (() => void) | undefined
let live = false
let fail = false
let gate: Promise<void> | undefined
let release: (() => void) | undefined
let completeSend: (() => void) | undefined
let emitStreamEdit: ((done: boolean) => void) | undefined
let inventoryState: 'ready' | 'error' | 'empty' | 'changed' = 'ready'
let inventoryGate: Promise<void> | undefined
let releaseInventory: (() => void) | undefined
let inventoryRequests = 0
const settings = new Map<string, Record<string, unknown>>()
const settingsPatches: Array<{ sessionId: string; patch: Record<string, unknown> }> = []
const sentMessages: Array<{ chatId: string; content: string; media?: string[]; config?: Record<string, unknown> }> = []
const uploadedImages = new Map<string, Uint8Array>()
let uploadAttempts = 0
let failUpload = false
const extraSessions: Array<{ sessionId: string; title: string }> = []
let failSettings = false
let settingsGate: Promise<void> | undefined
let failDetails = false
let detailsRequests = 0
const inventory = () => ({
  version: 1,
  nodes: [
    {
      nodeId: 'layout-fixture', displayName: 'Synthetic Main', role: 'main', connection: 'connected',
      capabilities: [
        { capabilityId: 'fixture-source', kind: 'workdir', displayName: 'Synthetic source', displayPath: 'C:\\synthetic\\source', online: true },
        { capabilityId: 'fixture-shell', kind: 'shell', displayName: 'Local shell', online: true },
      ],
    },
    {
      nodeId: 'synthetic-child', displayName: 'Synthetic Child with a deliberately long device name', role: 'child',
      connection: inventoryState === 'changed' ? 'connected' : 'offline',
      capabilities: [{ capabilityId: 'fixture-archive', kind: 'workdir', displayName: 'Folder archive', online: inventoryState === 'changed' }],
    },
    {
      nodeId: 'synthetic-revoked', displayName: 'Revoked Child', role: 'child', connection: 'revoked', capabilities: [],
    },
  ],
})
const realtime = new LiveFixture()
const traceQueries: URL[] = []
const unexpected: string[] = []
const tools = [{ name: 'read_file', description: 'Read a file in the effective workdir.', parameters: { properties: { path: { type: 'string', description: 'File path' } }, required: ['path'] } }]
const span = (spanId: string, name: string, start: number, end: number, extra: Record<string, unknown> = {}) => ({
  id: end, spanId, traceId: 'trace-a', parentSpanId: 'root', name, startTime: base + start, endTime: base + end,
  live: false, attributes: {}, events: [], ...extra,
})
const trace = () => [
  span('root', 'session.processMessage', 0, 7000, { parentSpanId: undefined }),
  span('model', 'agent.chat', 200, 1800, { attributes: { model: 'synthetic-model' } }),
  span('tool', 'agent.tool', 2000, 3000, { attributes: { 'tool.name': 'read_file', 'tool.call_id': 'call-a' } }),
  span('answer', 'agent.chat', 3100, 7000, { id: live ? null : 7100, live, endTime: live ? undefined : base + 7000 }),
]
const server = createServer(async (request, response) => {
  try {
    if (realtime.handle(request, response)) return
    const url = new URL(request.url!, 'http://127.0.0.1')
    const path = url.pathname.replace(/^\/projects\/default(?=\/)/, '')
    const json = (data: unknown, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(data)) }
    if (path === '/api/projects') return json({ projects: [{ id: 'default', name: 'Default', createdAt: '2026-09-16T00:00:00Z' }] })
    if (path === '/api/automations') return json({ automations: [] })
    if (path === '/api/agent-resources/publication-requests') return json({ request: null })
    if (path === '/api/agent-resources/probe-requests') return json({ requests: [] })
    const background = path.match(/^\/api\/sessions\/([^/]+)\/background-tasks$/)
    if (background) return json({ sessionId: decodeURIComponent(background[1]), total: 0, tasks: [] })
    const gitRoute = path.match(/^\/api\/(sessions|folders)\/([^/]+)\/git\/(status|diff)$/)
    if (gitRoute) {
      const scope = `${gitRoute[1]}:${decodeURIComponent(gitRoute[2])}`
      const operation = gitRoute[3]
      const filePath = url.searchParams.get('path') || ''
      const record = { scope, operation, path: filePath, aborted: false }
      gitRequests.push(record)
      response.on('close', () => { if (!response.writableEnded) record.aborted = true })
      const status = gitStates.get(scope) ?? { available: false, reason: 'not_repository', entries: [] }
      const payload = structuredClone(operation === 'status' ? status : gitDiffs.get(`${scope}\0${filePath}`))
      if (gitGate?.scope === scope && gitGate.operation === operation) {
        const waiting = gitGate.promise
        gitGate = undefined
        await waiting
      }
      if (payload === 'error') return json({ error: 'git_status_failed', message: 'Synthetic Git status failed. Retry explicitly.' }, 503)
      if (!payload) return json({ error: 'git_diff_failed', message: 'Synthetic Git diff unavailable. Retry explicitly.' }, 404)
      return json(payload)
    }
    if (path === '/nodes/v1') {
      inventoryRequests += 1
      const waiting = inventoryGate
      inventoryGate = undefined
      const payload = inventoryState === 'empty' ? { version: 1, nodes: [] } : inventory()
      if (waiting) await waiting
      if (inventoryState === 'error') return json({ error: 'Synthetic unavailable' }, 503)
      return json(payload)
    }
    if (path === '/api/provider/configured') {
      if (failProviderInventory) return json({ error: 'Synthetic inventory unavailable' }, 503)
      return json({ providers: [...savedProviders.values()].map(item => ({
        ...item, selected: item.provider === providerStatus.provider,
        model: item.provider === providerStatus.provider ? providerStatus.model : undefined,
      })) })
    }
    if (path === '/api/provider/setup') {
      if (request.method === 'POST') {
        let body = ''
        for await (const chunk of request) body += chunk
        const input = JSON.parse(body)
        providerSaves.push(input)
        const waiting = providerSaveGate
        providerSaveGate = undefined
        if (waiting) await waiting
        if (failProviderSave) return json({ error: 'Synthetic save unavailable' }, 503)
        providerStatus = {
          ready: true, provider: input.provider, model: input.model,
          authMode: savedProviders.get(input.provider)?.authMode ?? (input.apiKey ? 'api-key' : 'none'),
          hasApiKey: !!input.apiKey || !!savedProviders.get(input.provider)?.hasApiKey,
          baseUrl: input.baseUrl || undefined,
        }
        savedProviders.set(input.provider, { ...providerStatus, selected: true })
      }
      return json(providerStatus)
    }
    if (path === '/api/auth/login') {
      let body = ''
      for await (const chunk of request) body += chunk
      const input = JSON.parse(body)
      return json({ loginId: input.attemptId, state: 'pending', userCode: 'TEST-CODE', verificationUri: 'https://github.com/login/device', expiresAt: Date.now() + 600_000, intervalMs: 5000 })
    }
    if (path.startsWith('/api/auth/login/')) {
      const loginId = path.slice('/api/auth/login/'.length)
      if (request.method === 'DELETE') cancelledProviderLogins.add(loginId)
      return json({ loginId, state: 'cancelled' })
    }
    if (path === '/api/folders') return json({ folders: [
      { id: 'synthetic-folder', name: 'Synthetic folder', path: 'C:\\synthetic\\folder', createdAt: timestamp(0) },
      { id: 'synthetic-folder-two', name: 'Second folder', path: 'C:\\synthetic\\second', createdAt: timestamp(0) },
    ] })
    const folderFileRoute = path.match(/^\/api\/folders\/([^/]+)\/(files|preview|raw|static\/.*|sessions)$/)
    if (folderFileRoute) {
      const folderId = decodeURIComponent(folderFileRoute[1])
      const kind = folderFileRoute[2]
      if (kind === 'sessions' && request.method === 'POST') {
        if (failFolderSessionCreate) return json({ error: 'Synthetic folder session unavailable' }, 503)
        folderSessionRequests.push(folderId)
        const chatId = `chat-folder-created-${folderSessionRequests.length}`
        extraSessions.push({ sessionId: `web:${chatId}`, title: 'Folder conversation' })
        return json({ chatId, sessionId: `web:${chatId}` })
      }
      const entry = { folderId, kind, path: url.searchParams.get('path') || '', aborted: false }
      folderFileRequests.push(entry)
      response.on('close', () => { if (!response.writableEnded) entry.aborted = true })
      if (kind === 'files') {
        const waiting = folderListGate
        folderListGate = undefined
        if (waiting) await waiting
        return json({ path: entry.path, workdir: { kind: 'local', displayPath: folderId === 'synthetic-folder' ? 'C:\\synthetic\\folder' : 'C:\\synthetic\\second' }, entries: [
          { name: 'README.md', type: 'file', ext: '.md', size: 42, mtime: timestamp(0) },
          { name: `${folderId}.txt`, type: 'file', ext: '.txt', size: 42, mtime: timestamp(0) },
        ] })
      }
      if (kind === 'preview') {
        const waiting = folderPreviewGate
        folderPreviewGate = undefined
        if (waiting) await waiting
        const content = `# ${folderId}\n\nUnsent folder preview: ${entry.path}\n\n[Relative file](${folderId}.txt)`
        return json({ binary: false, size: Buffer.byteLength(content), content, truncated: false })
      }
      response.writeHead(200, { 'Content-Type': 'text/plain' })
      response.end(`Raw file from ${folderId}`)
      return
    }
    if (path === '/api/config') return json({ agent: { model: 'synthetic-model', workspace: directory, temperature: 0.7 } })
    if (path === '/debug/models') return json({ models: ['synthetic-model', 'synthetic-other'] })
    if (path === '/api/sessions/graph') return json({
      sessions: [{ sessionId: idA, title: 'Trace preview', current: 'physical-a' }, { sessionId: idB, title: 'Second conversation', current: 'physical-b' }, { sessionId: idGroup, title: 'Group conversation', current: 'physical-group' },
        { sessionId: idChild, title: 'Child conversation', current: 'physical-child' }, { sessionId: idAgent, title: 'Analysis agent', current: 'physical-agent' }, ...extraSessions, ...(sidebarEdgeCases ? sidebarSessions : [])].map(item => ({
          ...item, config: settings.get(item.sessionId),
          folderId: (groupTreeSessions && [idA, idChild, idAgent].includes(item.sessionId)) || (sidebarEdgeCases && item.sessionId === 'heartbeat:reflector-fixture') ? 'synthetic-folder' : undefined,
        })),
      nodes: [{ physicalId: 'physical-a', logicalId: idA }, { physicalId: 'physical-child', logicalId: idChild, parentPhysicalId: 'physical-a' }, { physicalId: 'physical-agent', logicalId: idAgent, parentPhysicalId: 'physical-a' },
        ...(sidebarEdgeCases ? [
          { physicalId: 'physical-reflection', logicalId: 'heartbeat:reflector-fixture' },
          { physicalId: 'physical-soul-reflection', logicalId: 'heartbeat:soul-reflector-fixture' },
          { physicalId: 'physical-reflection-child', logicalId: 'agent:reflection-child', parentPhysicalId: 'physical-reflection' },
          { physicalId: 'physical-long', logicalId: idLong },
          ...sidebarRelatedSessions.map(item => ({ physicalId: item.current, logicalId: item.sessionId, parentPhysicalId: 'physical-long' })),
        ] : []),
      ],
    })
    if (path === '/api/sessions/stages') {
      sessionStageRequests++
      return json({
        stages: { [idA]: live ? 'llm' : 'idle', [idB]: 'idle', [idChild]: 'idle', [idAgent]: messageSourceMode ? 'waiting' : agentWorking ? 'llm' : 'idle',
          ...Object.fromEntries([...realtime.activeRequests.keys()].map(id => [id, 'llm'])) },
        activeRequestIds: Object.fromEntries(realtime.activeRequests),
      })
    }
    if (path === '/api/chat/upload') {
      uploadAttempts++
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const form = await new Response(new Uint8Array(Buffer.concat(chunks)), {
        headers: { 'Content-Type': String(request.headers['content-type']) },
      }).formData()
      const file = form.get('file')
      assert.ok(file instanceof File)
      assert.equal(file.name, 'red.png')
      assert.match(String(form.get('chatId')), /^chat-/)
      if (failUpload) return json({ error: 'Synthetic upload failure' }, 503)
      const mediaPath = `C:\\synthetic\\uploads\\${form.get('chatId')}\\red.png`
      const bytes = new Uint8Array(await file.arrayBuffer())
      assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], 'Uploads carry the actual synthetic PNG, not a reference placeholder')
      uploadedImages.set(mediaPath, bytes)
      return json({ path: mediaPath })
    }
    if (path === '/api/media') {
      const image = uploadedImages.get(url.searchParams.get('path') ?? '')
      if (!image) return json({ error: 'Missing image' }, 404)
      response.writeHead(200, { 'Content-Type': 'image/png' })
      response.end(image)
      return
    }
    if (path === '/api/chat/send') {
      let body = ''
      for await (const chunk of request) body += chunk
      const input = JSON.parse(body) as typeof sentMessages[number]
      if ('stream' in input && input.stream === true) return json({ error: 'stream_removed' }, 410)
      assert.ok(realtime.hub.stats.clients > 0, 'Subscribe before admission')
      sentMessages.push(input)
      if (input.content === 'Failed timestamp') return json({ error: 'Synthetic send failure' }, 503)
      if (input.config) settings.set(`web:${input.chatId}`, input.config)
      if (![idA, idB].includes(`web:${input.chatId}`) && !extraSessions.some(item => item.sessionId === `web:${input.chatId}`)) extraSessions.push({ sessionId: `web:${input.chatId}`, title: input.content })
      const acknowledgement = realtime.admit(input.chatId)
      const sessionId = `web:${input.chatId}`
      realtime.history(sessionId).push({
        role: 'user', timestamp: new Date().toISOString(),
        content: input.media?.length ? [
          { type: 'text', text: input.content },
          ...input.media.map(path => {
            const image = uploadedImages.get(path)
            assert.ok(image)
            return { type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.from(image).toString('base64')}` } }
          }),
        ] : input.content,
      })
      realtime.chat(sessionId, { event: 'response', content: 'A streamed response.', done: false })
      if (input.content === 'Interrupted timestamp') {
        realtime.finish(sessionId, 'failed')
        return json(acknowledgement)
      }
      emitStreamEdit = done => realtime.chat(sessionId, done
        ? { event: 'tool_result', content: 'Success: edit streamed.ts\nUTF-8 bytes written: 12; result lines: 2.\nLine changes: +2 -1.\nL1: new' }
        : { event: 'tool_call', content: 'write', toolCall: { name: 'write', arguments: { path: 'streamed.ts', match: 'old', content: 'new\nline' } } })
      completeSend = () => {
        for (const payload of [
          { event: 'tool_call', content: 'read_file', toolCall: { name: 'read_file', arguments: { path: 'fixture.txt' } } },
          { event: 'tool_result', content: 'Synthetic tool result' },
          { event: 'response', content: 'Final timestamped response.', done: true },
        ] as const) realtime.chat(sessionId, payload)
        realtime.finish(sessionId)
      }
      return json(acknowledgement)
    }
    const historyFor = (id: string) => {
      if (layoutMode && (id === idEmpty || `web:${id}` === idEmpty)) return []
      const history = id === idAgent ? agentMessages : id.includes('split-child') ? childMessages : id === idGroup ? groupMessages : id.includes('diagnosis-b') ? [{ role: 'user', content: 'Only the second session.' }] : id === 'physical-older' ? [{ role: 'user', content: 'Historical segment only.' }] : messagesA
      return [...history, ...(messageSourceMode ? [{
        role: 'user', name: 'admin', timestamp: timestamp(11000), content: [
          { type: 'text', text: '<sender id="web:orchestrator" name="admin" source="session" intent="handoff" />' },
          { type: 'text', text: 'Delegated inspection from coordinator. Use the published revision.' },
        ],
      }] : []), ...realtime.history(id.startsWith('chat-') ? `web:${id}` : id)]
    }
    if (path === '/api/chat/session') {
      chatHistoryRequests.push(url.searchParams.get('chatId') || '')
      return json({ history: historyFor(url.searchParams.get('chatId') || ''), systemPrompt: '# Synthetic system prompt\n\nUse the folder workdir. Inline $x^2$.\n\n$$\\frac{1}{2}$$', tools, previousPhysicalId: 'physical-older' })
    }
    if (path.startsWith('/api/sessions/')) {
      const key = decodeURIComponent(path.slice('/api/sessions/'.length))
      if (key.endsWith('/static/preview.html')) {
        response.writeHead(200, { 'Content-Type': 'text/html' })
        response.end(htmlPreviewSource)
        return
      }
      if (key.endsWith('/files')) {
        const sessionId = key.slice(0, -'/files'.length)
        const folder = url.searchParams.get('path') || ''
        fileRequests.push({ sessionId, path: folder })
        if (failFiles) return json({ error: 'workdir_unavailable' }, 503)
        const names = reflectionIds.has(sessionId) ? ['agents', 'skills', 'memory.md'] : sessionId === idEmpty ? [] : sessionId === idChild ? ['child-only.txt'] : folder === 'src' ? ['main.ts'] : ['src', 'README.md', 'preview.html', '.node-version', 'settings.arbitrary-suffix', 'binary.unknown',
          ...(gitFixtureScopes.has(`sessions:${sessionId}`) ? ['new.ts', 'renamed.ts', 'conflict.ts', 'added.ts', 'typechanged.ts', 'binary.dat', 'large.ts', 'clean.txt'] : [])]
        const displayPath = reflectionIds.has(sessionId) ? reflectionHome : sessionWorkdir(sessionId)
        return json({ path: folder, workdir: { kind: 'local', displayPath, ...(reflectionIds.has(sessionId) && { scope: 'home' }) }, entries: names.map(name => ({ name, type: ['src', 'agents', 'skills'].includes(name) ? 'dir' : 'file', ext: name.lastIndexOf('.') <= 0 ? '' : name.slice(name.lastIndexOf('.')), size: 42, mtime: timestamp(0) })) })
      }
      if (key.endsWith('/preview')) {
        const preview = { sessionId: key.slice(0, -'/preview'.length), path: url.searchParams.get('path') || '', aborted: false }
        previewRequests.push(preview)
        response.on('close', () => { if (!response.writableEnded) preview.aborted = true })
        const waiting = filePreviewGate
        filePreviewGate = undefined
        if (waiting) await waiting
        if (preview.path === 'binary.unknown') return json({ binary: true, size: 42 })
        const content = reflectionIds.has(preview.sessionId) && preview.path === 'memory.md' ? 'Synthetic Home memory fixture.' : preview.path === 'preview.html' ? htmlPreviewSource : preview.path === 'src/main.ts' ? typescriptPreviewSource : preview.path === 'settings.arbitrary-suffix'
          ? 'Preview for settings.arbitrary-suffix\r\n  repeat excerpt\r\nmiddle one\r\n  repeat excerpt\r\n    middle two\r\nfinal\r\n'
          : url.searchParams.get('path') === 'README.md'
          ? '# README.md\n\nA **rendered** document with `inline code`.\n\n## Getting started\n\n- First item\n- Second item\n\n> A useful note.\n\n```ts\nconst ready = true\n```\n\n| Name | Value |\n| --- | --- |\n| Preview | Markdown |\n\n[Source](src/main.ts)\n\n[Unsafe](javascript:alert(1))\n\n<script>window.markdownExecuted = true</script><style>body { display:none }</style>'
          : `Preview for ${key.slice(0, -'/preview'.length)}: ${url.searchParams.get('path')}`
        return json({ binary: false, size: Buffer.byteLength(content), content, truncated: preview.path === '.node-version', ...(reflectionIds.has(preview.sessionId) && { sourcePath: `${reflectionHome}\\${preview.path}` }) })
      }
      if (key.endsWith('/details')) {
        detailsRequests++
        if (failDetails) return json({ error: 'Synthetic details failure' }, 503)
        const sessionId = key.slice(0, -'/details'.length)
        return json({
          sessionId, name: sessionId === idA ? 'Trace preview' : sessionId === idB ? 'Second conversation' : sessionId === idGroup ? 'Group conversation' : sessionId === idChild ? 'Child conversation' : sessionId === idAgent ? 'Analysis agent' : 'Draft settings regression',
          workdir: { kind: 'local', displayPath: sessionWorkdir(sessionId) },
          usage: { promptTokens: 40_000, completionTokens: 5_000, totalTokens: 45_000 }, usageScope: 'session',
          context: { usedTokens: 20_000, windowTokens: 100_000 },
        })
      }
      if (key.endsWith('/config') && request.method === 'PATCH') {
        let body = ''
        for await (const chunk of request) body += chunk
        const patch = JSON.parse(body) as Record<string, unknown>
        const sessionId = key.slice(0, -'/config'.length)
        settingsPatches.push({ sessionId, patch })
        const waiting = settingsGate
        settingsGate = undefined
        if (waiting) await waiting
        if (failSettings) return json({ error: 'Synthetic config failure' }, 503)
        const config = { ...settings.get(sessionId) }
        for (const [name, value] of Object.entries(patch)) {
          if (value === null) delete config[name]
          else config[name] = value
        }
        settings.set(sessionId, config)
        return json({ key: sessionId, config })
      }
      if (key === `${idGroup}/context` || key === `${idAgent}/context`) return json({ systemPrompt: 'Synthetic group context.', tools })
      if (key === idAgent) {
        agentHistoryRequests++
        const waiting = agentHistoryGate
        agentHistoryGate = undefined
        const snapshot = [...agentMessages]
        if (waiting) await waiting
        return json({ messages: snapshot, currentPhysicalId: 'physical-agent', previousPhysicalId: null })
      }
      return json({ messages: historyFor(key), currentPhysicalId: key === idB ? 'physical-b' : key === idChild ? 'physical-child' : 'physical-a', previousPhysicalId: key === idA ? 'physical-older' : null })
    }
    if (path === '/v1/query/session-spans') {
      traceQueries.push(url)
      const waiting = gate
      gate = undefined
      if (waiting) await waiting
      if (fail) return json({ error: 'Synthetic unavailable' }, 503)
      return json({ sessionId: url.searchParams.get('sessionId'), physicalSessionId: url.searchParams.get('physicalSessionId'), entries: url.searchParams.get('physicalSessionId') === 'physical-a' ? trace() : [], hasMore: false })
    }
    if (path.startsWith('/api/') || path.startsWith('/v1/') || path.startsWith('/nodes/') || path.startsWith('/local/') || path.startsWith('/debug/')) {
      unexpected.push(path)
      return json({ error: 'Unstubbed endpoint' }, 404)
    }
    const resource = await ui.request(url.toString())
    response.writeHead(resource.status, {
      'Content-Type': resource.headers.get('Content-Type') || 'application/octet-stream',
      'Content-Security-Policy': "default-src 'self' data:; img-src 'self' data: blob:; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; font-src 'self' data:",
    })
    response.end(Buffer.from(await resource.arrayBuffer()))
  } catch (error) {
    unexpected.push(String(error))
    response.writeHead(500).end()
  }
})

let window: BrowserWindow | undefined
let disposeDocumentShortcuts: (() => void) | undefined
let focusEmulated = false
const evaluate = <T = unknown>(source: string): Promise<T> => window!.webContents.executeJavaScript(activeWorkspaceScript(source))
async function waitFor(source: string): Promise<void> {
  const end = Date.now() + 12000
  while (Date.now() < end) {
    if (await evaluate(source)) return
    await new Promise(resolve => setTimeout(resolve, 40))
  }
  throw new Error(`Timed out: ${source}`)
}
async function click(selector: string): Promise<void> {
  assert.equal(await evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`), true, `Missing click target: ${selector}`)
  await evaluate(`(() => {
    const target = document.querySelector(${JSON.stringify(selector)});
    target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true, cancelable: true, pointerType: 'mouse' }));
    target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, composed: true, cancelable: true, pointerType: 'mouse' }));
    target.click();
  })()`)
}
async function selectSession(id: string): Promise<void> {
  const labels: Record<string, string> = {
    [idA]: 'Trace preview', [idB]: 'Second conversation', [idChild]: 'Child conversation',
    [idGroup]: 'Group conversation (read-only)', [idAgent]: 'Analysis agent (read-only)',
  }
  assert.ok(labels[id], `Missing synthetic session label for ${id}`)
  await click(`.session-select[aria-label="${labels[id]}"]`)
}
async function captureVisibleInfo(name: string, mobile = false): Promise<void> {
  const visible = `(() => { const popup = document.querySelector('.hover-info-popup'); if (!popup) return false;
    const rect = popup.getBoundingClientRect(); return getComputedStyle(popup).visibility === 'visible'
      && rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight; })()`
  await waitFor(visible)
  await assertSquareUi()
  await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
  await new Promise<void>((resolve, reject) => {
    const contents = window!.webContents
    const painted = () => { clearTimeout(timeout); resolve() }
    const timeout = setTimeout(() => { contents.removeListener('paint', painted); reject(new Error(`${name}: information popup did not paint`)) }, 5000)
    contents.once('paint', painted)
    contents.invalidate()
  })
  assert.equal(await evaluate(visible), true, `${name} captures the actual bounded information popup`)
  await writeFile(join(directory, name), (await window!.webContents.capturePage(mobile ? { x: 0, y: 0, width: 390, height: 844 } : undefined)).toPNG())
}
async function assertSquareUi(): Promise<void> {
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.mouse-glow')).borderRadius`), '50%', 'Mouse highlight stays circular')
  const rounded = await evaluate(`Array.from(document.querySelectorAll('*')).filter(node => node.getClientRects().length).flatMap(node =>
    [null, '::before', '::after'].flatMap(pseudo => {
      const style = getComputedStyle(node, pseudo);
      if (pseudo && (style.content === 'none' || style.content === 'normal')) return [];
      const circular = !pseudo && node.matches('.mouse-glow, .composer-send, .activity-spinner')
        || pseudo === '::after' && node.matches('.working:not(.waiting):not(.waiting-for-call) .activity-symbol');
      const expected = circular ? '50%' : '0px';
      return ['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius'].some(corner => style[corner] !== expected)
        ? [{ tag: node.tagName, classes: node.getAttribute('class'), pseudo, radius: style.borderRadius }] : [];
    })).slice(0, 12)`)
  assert.deepEqual(rounded, [], 'Visible app corners stay square except for the mouse highlight, send button and loading indicator')
}
async function assertConversationCaps(checkNaturalWidth = false): Promise<void> {
  const caps = await evaluate<Record<string, string>>(`Object.fromEntries(['.chat-assistant', '.system-event', '.compaction-summary', '.tool-activity'].map(selector => [selector, getComputedStyle(document.querySelector(selector)).maxWidth]))`)
  for (const [selector, cap] of Object.entries(caps)) assert.equal(cap, caps['.chat-assistant'], `${selector} shares the assistant maximum width, not necessarily its natural width`)
  assert.notEqual(caps['.chat-assistant'], 'none')
  if (checkNaturalWidth) {
    assert.equal(await evaluate(`(() => {
      const replies = Array.from(document.querySelectorAll('.chat-assistant')).map(node => node.getBoundingClientRect());
      const user = document.querySelector('.chat-user').getBoundingClientRect();
      return Math.max(...replies.map(rect => rect.width)) - Math.min(...replies.map(rect => rect.width)) > 40
        && user.right > Math.min(...replies.map(rect => rect.right)) + 20;
    })()`), true, 'Short assistant replies keep natural width and user bubbles remain right-aligned')
  }
}
async function assertConversationAlignment(label: string, expectedPanes = 1): Promise<void> {
  const panes = await evaluate<Array<{
    width: number; historyWidth: number; scrollWidth: number; left: number; right: number; scrollbar: number
    railLeft: number; railRight: number; railOffset: number; flexGrow: string; overflow: string
    users: number[]; assistants: number[]; overflowWidth: number; contentWidth: number
    rowWidths: number[]; composerOffset: number; navigatorLeft: number
  }>>(`Array.from(document.querySelectorAll('.chat-panel')).filter(pane => pane.getClientRects().length && pane.querySelector('.chat-messages')).map(pane => {
    const scroll = pane.querySelector('.chat-messages'), history = pane.querySelector('.chat-history');
    const r = scroll.getBoundingClientRect(), css = getComputedStyle(scroll), rail = scroll.querySelector('.chat-message-list').getBoundingClientRect();
    return { width: pane.getBoundingClientRect().width, historyWidth: history.getBoundingClientRect().width, scrollWidth: r.width,
      left: r.left, right: r.right, scrollbar: scroll.offsetWidth - scroll.clientWidth,
      railLeft: rail.left, railRight: rail.right, railOffset: (rail.left + rail.right - r.left - r.right) / 2,
      flexGrow: css.flexGrow, overflow: css.overflowY, overflowWidth: scroll.scrollWidth - scroll.clientWidth,
      contentWidth: rail.width,
      rowWidths: Array.from(scroll.querySelectorAll('.chat-bubble, .tool-activity, .system-event, .compaction-summary')).map(node => node.getBoundingClientRect().width),
      composerOffset: (() => { const r = pane.closest('.file-workbench').querySelector('.chat-composer').getBoundingClientRect(); const p = pane.getBoundingClientRect(); return (r.left + r.right - p.left - p.right) / 2; })(),
      navigatorLeft: pane.querySelector('.message-history-rail').getBoundingClientRect().left,
      users: Array.from(scroll.querySelectorAll('.chat-user')).map(node => node.getBoundingClientRect().right),
      assistants: Array.from(scroll.querySelectorAll('.chat-assistant, .tool-activity, .system-event, .compaction-summary')).map(node => node.getBoundingClientRect().left) };
  })`)
  console.log(`LAYOUT_GEOMETRY ${JSON.stringify({ label, panes })}`)
  assert.equal(panes.length, expectedPanes, `${label}: expected visible conversation panes`)
  for (const pane of panes) {
    assert.ok(Math.abs(pane.scrollWidth - pane.historyWidth) <= 1, `${label}: message scroller fills history`)
    assert.equal(pane.flexGrow, '1', `${label}: message scroller grows with the pane`)
    assert.equal(pane.overflow, 'auto', `${label}: history owns vertical scrolling`)
    assert.ok(pane.railLeft - pane.left >= 55, `${label}: message gutter mirrors the navigator clearance`)
    assert.ok(Math.abs(pane.railOffset) <= 1, `${label}: message rail stays centered with and without scrollbars`)
    assert.ok(Math.abs(pane.contentWidth - (pane.width - 112)) <= 1, `${label}: message rail fills its pane with fixed navigator gutters instead of a desktop width cap`)
    if (pane.width > 1200) assert.ok(Math.max(...pane.rowWidths) > 860 * .8 + 40, `${label}: long bubbles expand beyond the former desktop cap`)
    assert.ok(pane.overflowWidth <= 1, `${label}: no horizontal overflow`)
    assert.ok(Math.abs(pane.composerOffset) <= 1, `${label}: composer remains centered in its own pane`)
    for (const width of pane.rowWidths) assert.ok(width <= pane.contentWidth * .8 + 1, `${label}: row keeps its 80% cap`)
    for (const left of pane.assistants) assert.ok(Math.abs(left - pane.railLeft) <= 1, `${label}: assistant/tool left alignment`)
    for (const right of pane.users) {
      assert.ok(Math.abs(right - pane.railRight) <= 1, `${label}: user right alignment`)
      assert.ok(right <= pane.navigatorLeft, `${label}: history navigator never obscures a user bubble`)
    }
  }
}
async function showSessionView(diagnosis: boolean, scope = '.primary-conversation'): Promise<void> {
  const selector = `${scope} .${diagnosis ? 'diagnosis' : 'conversation'}-tab [role="tab"]`
  await click(selector)
  await waitFor(`document.querySelector(${JSON.stringify(selector)}).getAttribute('aria-selected') === 'true'`)
}
async function selectMessage(scope: string): Promise<string> {
  await evaluate(`(() => {
    document.activeElement?.blur();
    const content = document.querySelector(${JSON.stringify(`${scope} .chat-assistant .chat-content`)});
    content.scrollIntoView({ block: 'center' });
  })()`)
  await new Promise(resolve => setTimeout(resolve, 100))
  await evaluate(`(() => {
    const content = document.querySelector(${JSON.stringify(`${scope} .chat-assistant .chat-content`)});
    content.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    const range = document.createRange(); range.selectNodeContents(content);
    const native = getSelection(); native.removeAllRanges(); native.addRange(range);
    content.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
    document.dispatchEvent(new Event('selectionchange'));
  })()`)
  await waitFor(`document.querySelector('.selection-menu')?.getClientRects().length > 0`)
  return evaluate<string>(`getSelection().toString()`)
}
async function captureSelectionMenu(name: string, mobile = false, file = false): Promise<void> {
  if (!file) await selectMessage('.primary-conversation')
  await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
  await new Promise(resolve => setTimeout(resolve, 250))
  const visibleSelection = `(() => {
    const menu = document.querySelector('.selection-menu');
    const native = getSelection();
    if (!menu || !menu.getClientRects().length || !native?.rangeCount || native.isCollapsed) return false;
    const rect = menu.getBoundingClientRect();
    const selection = native.getRangeAt(0).getBoundingClientRect();
    const messages = ${file ? "Array.from(document.querySelectorAll('.file-modal-body')).find(node => node.getClientRects().length)" : "document.querySelector('.primary-conversation .chat-messages')"}.getBoundingClientRect();
    const buttons = Array.from(menu.querySelectorAll('[role="menuitem"]'));
    return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight
      && selection.top >= messages.top && selection.bottom <= messages.bottom
      && menu.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2))
      && buttons.length === 2 && buttons[0].textContent.includes('Quote') && buttons[0].querySelector('kbd').textContent === '\u0060'
      && buttons[1].textContent.includes('Copy') && buttons[1].querySelector('kbd').textContent === 'c';
  })()`
  assert.equal(await evaluate(visibleSelection), true, `${name}: menu and native text selection must remain visible after layout settles`)
  await new Promise<void>((resolve, reject) => {
    const contents = window!.webContents
    const painted = () => { clearTimeout(timeout); resolve() }
    const timeout = setTimeout(() => { contents.removeListener('paint', painted); reject(new Error(`${name}: offscreen selection frame did not paint`)) }, 5000)
    contents.once('paint', painted)
    contents.invalidate()
  })
  assert.equal(await evaluate(visibleSelection), true, `${name}: capture must contain the visible Quote/Copy menu, not the quoted composer`)
  const image = await window!.webContents.capturePage(mobile ? { x: 0, y: 0, width: 390, height: 844 } : undefined)
  await writeFile(join(directory, name), image.toPNG())
}
async function selectFileText(selector: string, start = 0, end?: number): Promise<string> {
  await evaluate(`(() => {
    document.activeElement?.blur();
    Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(node => node.getClientRects().length).scrollIntoView({ block: 'nearest' });
  })()`)
  await new Promise(resolve => setTimeout(resolve, 150))
  await evaluate(`(() => {
    const content = Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(node => node.getClientRects().length);
    content.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    const nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode);
    const point = offset => {
      for (const node of nodes) {
        if (offset <= node.textContent.length) return [node, offset];
        offset -= node.textContent.length;
      }
      return [nodes.at(-1), nodes.at(-1).textContent.length];
    };
    const range = document.createRange();
    range.setStart(...point(${start})); range.setEnd(...point(${end ?? 'content.textContent.length'}));
    const native = getSelection(); native.removeAllRanges(); native.addRange(range);
    content.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
    document.dispatchEvent(new Event('selectionchange'));
  })()`)
  await waitFor(`document.querySelector('.selection-menu')?.getClientRects().length > 0`)
  return evaluate<string>(`getSelection().toString()`)
}
async function assertFileComposer(): Promise<void> {
  await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
  assert.equal(await evaluate(`(() => {
    const file = Array.from(document.querySelectorAll('.file-document')).find(node => node.getClientRects().length);
    const input = document.querySelector('.composer-input textarea');
    const box = document.querySelector('.composer-box');
    const hint = box.querySelector('.composer-submit .composer-hint');
    const send = box.querySelector('.composer-send');
    if (!file || !input?.getClientRects().length || !hint) return false;
    const preview = file.getBoundingClientRect(), composer = box.getBoundingClientRect();
    const body = file.querySelector('.file-modal-body'), dock = document.querySelector('.conversation-dock');
    const content = document.querySelector('.workbench-content').getBoundingClientRect();
    return document.querySelectorAll('.composer-input textarea').length === 1
      && getComputedStyle(dock).position === 'absolute' && preview.height >= 100
      && Math.abs(preview.bottom - content.bottom) < 2 && Math.abs(body.getBoundingClientRect().bottom - content.bottom) < 2
      && body.getBoundingClientRect().bottom > composer.top
      && parseFloat(getComputedStyle(body).paddingBottom) >= dock.getBoundingClientRect().height
      && composer.bottom <= innerHeight && composer.left >= 0 && composer.right <= innerWidth
      && hint.getBoundingClientRect().right <= send.getBoundingClientRect().left + 1
      && document.querySelectorAll('.composer-hint').length === 1
      && !file.querySelector('[aria-label="Close file preview"]')
      && document.documentElement.scrollWidth <= innerWidth;
  })()`), true, 'The single composer overlays the full-height file body, with scroll clearance and its hint inside the box')
}
async function assertFileEndAboveOverlay(): Promise<void> {
  await evaluate(`(() => { const body = Array.from(document.querySelectorAll('.file-modal-body')).find(node => node.getClientRects().length); body.scrollTop = body.scrollHeight; })()`)
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(await evaluate(`(() => {
    const file = Array.from(document.querySelectorAll('.file-document')).find(node => node.getClientRects().length);
    const body = file.querySelector('.file-modal-body'), pre = file.querySelector('.file-modal-text');
    let bottom;
    if (pre) {
      const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT); let last;
      while (walker.nextNode()) if (walker.currentNode.textContent.trimEnd()) last = walker.currentNode;
      const end = last.textContent.trimEnd().length, range = document.createRange();
      range.setStart(last, end - 1); range.setEnd(last, end); bottom = range.getBoundingClientRect().bottom;
    } else bottom = Array.from(file.querySelectorAll('.file-source-block')).filter(node => node.textContent.trim()).at(-1).getBoundingClientRect().bottom;
    const truncated = Array.from(file.querySelectorAll('.file-modal-note')).find(node => node.textContent.includes('Preview truncated'));
    if (truncated) bottom = Math.max(bottom, truncated.getBoundingClientRect().bottom);
    return bottom <= document.querySelector('.conversation-dock').getBoundingClientRect().top + 1
      && bottom >= body.getBoundingClientRect().top;
  })()`), true, 'At scroll end the last source line and truncation notice remain above the overlay')
}
async function pasteFixture(options: { images?: string[]; text?: string; nonImage?: boolean; fallback?: boolean; unavailable?: boolean; noData?: boolean } = {}): Promise<boolean> {
  return evaluate<boolean>(`(async () => {
    const options = ${JSON.stringify(options)};
    if (!window.revokedPasteUrls) {
      window.revokedPasteUrls = [];
      const revoke = URL.revokeObjectURL.bind(URL);
      URL.revokeObjectURL = url => { window.revokedPasteUrls.push(url); revoke(url); };
    }
    const data = new DataTransfer();
    if (options.text !== undefined) data.setData('text/plain', options.text);
    if (options.images?.length) {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d'); context.fillStyle = '#ff0000'; context.fillRect(0, 0, 1, 1);
      const image = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      for (const name of options.images) data.items.add(new File([image], name, { type: 'image/png', lastModified: 42 }));
    }
    if (options.nonImage) data.items.add(new File(['Synthetic text'], 'not-image.txt', { type: 'text/plain' }));
    const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, ...(!options.noData && { clipboardData: data }) });
    if (options.fallback || options.unavailable) Object.defineProperty(event, 'clipboardData', { value: {
      files: [], getData: type => data.getData(type),
      items: options.unavailable ? [{ kind: 'file', type: 'image/png', getAsFile: () => null }] : Array.from(data.items),
    } });
    document.querySelector('.composer-input textarea').dispatchEvent(event);
    return event.defaultPrevented;
  })()`)
}
async function chooseSetting(value: string): Promise<void> {
  await click('.composer-controls [aria-label="Choose model"]')
  await click('.model-menu-effort')
  await evaluate(`Array.from(document.querySelectorAll('.effort-option')).find(button => button.querySelector('.setting-option-copy > span').textContent.trim() === ${JSON.stringify(value)}).click()`)
  await waitFor(`!document.querySelector('.composer-popover') && !document.querySelector('.composer-controls [aria-label="Choose model"]').disabled && document.querySelector('.composer-controls [aria-label="Choose model"]').getAttribute('aria-busy') !== 'true'`)
}
async function closeDetails(): Promise<void> {
  await evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`)
  await waitFor(`!document.querySelector('.session-details')`)
}

async function main(): Promise<void> {
  await app.whenReady()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`
  let rendererOrigin = origin
  if (layoutMode === 'dev') {
    const appRoot = resolve(assets, '..')
    const require = createRequire(join(appRoot, 'package.json'))
    const { createServer: createViteServer } = await import(pathToFileURL(require.resolve('vite')).href)
    const vite = await createViteServer({
      root: appRoot, configFile: join(appRoot, 'vite.config.ts'), envFile: false,
      cacheDir: join(directory, 'vite-cache'), logLevel: 'error',
      plugins: [{ name: 'synthetic-api-only', configResolved(config: { server: { proxy: Record<string, { target?: string }> } }) {
        for (const proxy of Object.values(config.server.proxy)) proxy.target = origin
      } }],
      server: { host: '127.0.0.1', port: 0, strictPort: false, proxy: {
        '^/projects/[^/]+/(?:api|debug|nodes|v1)(?:/|$)': { target: origin },
        '/api': { target: origin }, '/debug': { target: origin }, '/nodes/v1': { target: origin }, '/v1': { target: origin },
      } },
    })
    devServer = vite
    await vite.listen()
    rendererOrigin = vite.resolvedUrls.local[0].replace(/\/$/, '')
  }
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const allowed = details.url.startsWith(origin + '/') || details.url.startsWith(rendererOrigin + '/') || details.url.startsWith(rendererOrigin.replace('http:', 'ws:') + '/') || details.url.startsWith(`blob:${origin}/`) || details.url.startsWith('devtools:') || details.url.startsWith('data:')
    if (!allowed) unexpected.push(`External request: ${details.url}`)
    callback({ cancel: !allowed })
  })
  window = new BrowserWindow({ width: 1400, height: 1000, show: false, webPreferences: { offscreen: true, backgroundThrottling: false, preload: join(directory, 'layout-preload.cjs'), additionalArguments: [`--layout-api-base=${rendererOrigin}`] } })
  disposeDocumentShortcuts = installDocumentTabShortcuts(window)
  await window.loadURL(`${rendererOrigin}/chat`)
  await waitFor(`document.querySelectorAll('.session-select').length === 5`)
  await selectSession(idA)
  await waitFor(`document.querySelectorAll('.chat-bubble').length >= 4`)
  await waitFor(`document.querySelector('.file-workbench.explorer-docked .tree-row[data-path="README.md"]')`)
  if (conversationSummaryMode) {
    assert.equal(await evaluate(`document.querySelector('.compaction-summary').tagName`), 'DETAILS')
    assert.equal(await evaluate(`document.querySelector('.compaction-summary').open`), false)
    assert.equal(await evaluate(`document.querySelector('.compaction-summary-body')`), null, 'Collapsed summaries do not render Markdown')
    for (const width of [1400, 390]) {
      window.setContentSize(width, width === 390 ? 844 : 1000)
      for (const dark of [false, true]) {
        await evaluate(`document.documentElement.classList.toggle('dark', ${dark})`)
        await evaluate(`document.querySelector('.compaction-summary-header').click()`)
        await waitFor(`!!document.querySelector('.compaction-summary-body h2')`)
        const layout = await evaluate<{ maxHeight: string; overflow: string; opacity: string; heading: number; body: number; border: string; bounded: boolean; scrolls: boolean }>(`(() => {
          const summary = document.querySelector('.compaction-summary');
          const body = summary.querySelector('.compaction-summary-body');
          const style = getComputedStyle(body);
          const rect = summary.getBoundingClientRect();
          return {
            maxHeight: style.maxHeight, overflow: style.overflowY, opacity: style.opacity,
            heading: parseFloat(getComputedStyle(body.querySelector('h2')).fontSize),
            body: parseFloat(style.fontSize), border: getComputedStyle(summary).borderTopStyle,
            bounded: rect.left >= 0 && rect.right <= innerWidth && body.scrollWidth <= body.clientWidth + 1,
            scrolls: body.scrollHeight > body.clientHeight + 1,
          };
        })()`)
        assert.deepEqual(layout, {
          maxHeight: 'none', overflow: 'visible', opacity: '1', heading: 14, body: 13,
          border: 'none', bounded: true, scrolls: false,
        }, `Readable summary at ${width}px, dark=${dark}`)
        assert.equal(await evaluate(`document.querySelectorAll('.compaction-summary-body li').length`), 24)
        assert.equal(await evaluate(`document.querySelector('.compaction-summary-body strong').textContent`), 'decisions')
        assert.equal(await evaluate(`document.querySelector('.compaction-summary-body a').target`), '_blank')
        assert.equal(await evaluate(`document.querySelector('.compaction-summary-body a').rel`), 'noopener noreferrer')
        assert.equal(await evaluate(`Boolean(window.unsafeSummary || document.querySelector('.compaction-summary-body script, .compaction-summary-body [onclick]'))`), false)
        await evaluate(`document.querySelector('.compaction-summary-header').click()`)
        await waitFor(`!document.querySelector('.compaction-summary-body')`)
        assert.ok(await evaluate(`document.querySelector('.compaction-summary').getBoundingClientRect().height <= 60`))
      }
    }
    assert.deepEqual(unexpected, [])
    console.log(`LAYOUT_RESULT ${JSON.stringify({ ok: true, mode: 'conversation-summary' })}`)
    return
  }
  if (messageSourceMode) {
    const captureSource = async (name: string) => {
      const contents = window!.webContents
      const png = await new Promise<Buffer>((resolve, reject) => {
        const painted = (_event: unknown, _rect: unknown, image: NativeImage) => { clearTimeout(timeout); resolve(image.toPNG()) }
        const timeout = setTimeout(() => { contents.removeListener('paint', painted); reject(new Error(`${name}: no fixture frame painted`)) }, 5000)
        contents.once('paint', painted)
        contents.invalidate()
      })
      await writeFile(join(directory, name), png)
    }
    for (const width of [1400, 390]) {
      window.setContentSize(width, width === 390 ? 844 : 1000)
      await showSessionView(false)
      await waitFor(`!!document.querySelector('.chat-session')`)
      await evaluate(`document.querySelector('.chat-session').scrollIntoView({ block: 'center' })`)
      await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
      assert.equal(await evaluate(`document.querySelectorAll('.chat-user').length`), 2, 'Only human input uses user bubbles')
      assert.equal(await evaluate(`document.querySelectorAll('.history-marker').length`), 2, 'Handoffs are not human history markers')
      for (const ordinal of [0, 1]) {
        await evaluate(`document.querySelectorAll('.history-marker')[${ordinal}].click()`)
        await waitFor(`(() => {
          const pane = document.querySelector('.primary-conversation');
          const container = pane.querySelector('.chat-messages');
          const target = pane.querySelectorAll('.chat-user')[${ordinal}];
          return Math.abs(target.getBoundingClientRect().top - container.getBoundingClientRect().top) < 32;
        })()`).catch(async cause => {
          const geometry = await evaluate(`(() => {
            const container = document.querySelector('.chat-messages');
            return { scrollTop: container.scrollTop, height: container.clientHeight, scrollHeight: container.scrollHeight,
              top: container.getBoundingClientRect().top,
              targets: Array.from(container.querySelectorAll('.chat-user')).map(row => ({ index: row.dataset.msgIdx, top: row.getBoundingClientRect().top })),
              markers: Array.from(document.querySelectorAll('.history-marker')).map(row => ({ current: row.getAttribute('aria-current'), label: row.getAttribute('aria-label') })) };
          })()`)
          throw new Error(`History jump geometry: ${JSON.stringify(geometry)}`, { cause })
        })
      }
      await evaluate(`document.querySelector('.chat-session').scrollIntoView({ block: 'center' })`)
      assert.equal(await evaluate(`document.querySelector('.resend-btn')`), null, 'A handoff cannot be resent as human input')
      assert.match(await evaluate<string>(`document.querySelector('.chat-session').getAttribute('aria-label')`), /Session handoff from web:orchestrator/)
      assert.equal(await evaluate(`getComputedStyle(document.querySelector('.chat-session')).alignSelf`), 'flex-start')
      assert.equal(await evaluate(`getComputedStyle(document.querySelector('.chat-session')).borderTopStyle`), 'dashed')
      assert.doesNotMatch(await evaluate<string>(`document.querySelector('.chat-session .chat-content').textContent`), /<sender/)
      assert.equal(await evaluate(`(() => { const r = document.querySelector('.chat-session').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth; })()`), true)
      await captureSource(`message-source-chat-${width}.png`)
      await showSessionView(true)
      await waitFor(`!!document.querySelector('.event-kind.SESSION')`)
      await evaluate(`[...document.querySelectorAll('.event-filters button')].find(button => button.textContent.trim() === 'session').click()`)
      await waitFor(`document.querySelectorAll('.trace-event').length === 1`)
      await evaluate(`(() => { const header = document.querySelector('.trace-event-header'); if (header.getAttribute('aria-expanded') !== 'true') header.click(); header.scrollIntoView({ block: 'start' }); })()`)
      await waitFor(`!!document.querySelector('.message-source')`)
      assert.match(await evaluate<string>(`document.querySelector('.trace-event-header').textContent`), /SESSION.*Session handoff.*web:orchestrator/s)
      assert.equal(await evaluate(`document.querySelector('.event-preview').textContent`), 'Delegated inspection from coordinator. Use the published revision.')
      assert.match(await evaluate<string>(`document.querySelector('.trace-event-detail').textContent`), /protocol role, not a human author/)
      assert.match(await evaluate<string>(`document.querySelector('.trace-event-detail details pre').textContent`), /source="session"/)
      assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), true)
      await captureSource(`message-source-trace-${width}.png`)
      console.log(`LAYOUT_SOURCE ${JSON.stringify({ width, humanMessages: 2, sessionMessages: 1, rawEvidence: true })}`)
    }
    window.setContentSize(1400, 1000)
    await showSessionView(false)
    await waitFor(`!!document.querySelector('.folder-session-row.needs-reply .session-activity.waiting')`)
    assert.match(await evaluate<string>(`document.querySelector('.folder-session-row.needs-reply').textContent`), /Needs reply/)
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('.folder-session-row.needs-reply')).boxShadow !== 'none'`), true)
    const progress = {
      role: 'user', name: 'Peer', timestamp: timestamp(12000),
      content: [
        { type: 'text', text: `<sender id="${idB}" name="Peer" source="session" intent="progress" />` },
        { type: 'text', text: '**First live progress** before history refresh.' },
      ],
    }
    // Keep history unchanged until the live-only presentation has been asserted.
    realtime.publisher.chat(idA, { event: 'session_message', message: progress })
    await waitFor(`Array.from(document.querySelectorAll('.chat-session')).some(row => row.textContent.includes('First live progress'))`)
    assert.equal(await evaluate(`Array.from(document.querySelectorAll('.chat-assistant')).some(row => row.textContent.includes('First live progress'))`), false)
    assert.equal(await evaluate(`document.querySelector('.chat-session:last-of-type .chat-content strong')?.textContent`), 'First live progress')
    assert.equal(await evaluate(`document.querySelectorAll('.history-marker').length`), 2)
    realtime.history(idA).push(progress)
    window.webContents.reload()
    await waitFor(`Array.from(document.querySelectorAll('.chat-session')).some(row => row.textContent.includes('First live progress'))`)
    assert.equal(await evaluate(`Array.from(document.querySelectorAll('.chat-session')).filter(row => row.textContent.includes('First live progress')).length`), 1)
    await evaluate(`Array.from(document.querySelectorAll('button.chat-session-source')).find(button => button.textContent.includes(${JSON.stringify(idB)})).click()`)
    await waitFor(`Array.from(document.querySelectorAll('.chat-user')).some(row => row.textContent.includes('Only the second session.'))`)
    assert.equal(await evaluate(`!!document.querySelector('.composer-input textarea')?.getClientRects().length`), true, 'The source heading opens the destination conversation with its composer')
    assert.equal(sentMessages.length, 0, 'Navigation does not send a message')
    assert.deepEqual(unexpected, [])
    console.log(`LAYOUT_RESULT ${JSON.stringify({ ok: true, mode: 'message-source' })}`)
    return
  }
  if (layoutMode) {
    for (const [width, height] of [[1400, 1000], [1920, 1080], [2560, 1080], [390, 844]]) {
      window.setContentSize(width, height)
      await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
      await assertConversationAlignment(`${layoutMode}-${width}`)
      await assertConversationCaps(width > 700)
      for (const dark of [false, true]) {
        assert.equal(await evaluate(`(() => {
          document.documentElement.classList.toggle('dark', ${dark});
          const dock = document.querySelector('.primary-conversation .conversation-dock');
          const fade = getComputedStyle(dock, '::before');
          const input = dock.querySelector('textarea');
          const rect = input.getBoundingClientRect();
          const surface = getComputedStyle(document.body).backgroundColor;
          return fade.content === '""' && fade.pointerEvents === 'none' && fade.zIndex === '-1'
            && fade.top === '-16px' && fade.backgroundImage.startsWith('linear-gradient(')
            && fade.backgroundImage.includes(surface + ' 160px')
            && ['32px', '80px', '128px'].every(stop => fade.backgroundImage.includes(stop))
            && getComputedStyle(dock).maskImage === 'none'
            && document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === input;
        })()`), true, `${layoutMode}-${width}-${dark ? 'dark' : 'light'}: the backdrop fades to the theme surface behind interactive controls`)
      }
      await evaluate(`document.querySelectorAll('.chat-messages').forEach(node => node.scrollTop = node.scrollHeight)`)
      assert.equal(await evaluate(`(() => {
        const pane = document.querySelector('.primary-conversation');
        const messages = pane.querySelectorAll('.chat-bubble');
        return messages[messages.length - 1].getBoundingClientRect().bottom <= pane.querySelector('.conversation-dock').getBoundingClientRect().top;
      })()`), true, `${layoutMode}-${width}: the last reply can scroll above the composer`)
      await evaluate(`document.querySelectorAll('.chat-messages').forEach(node => node.scrollTop = 0)`)
      await new Promise(resolve => setTimeout(resolve, 250))
      await writeFile(join(directory, `conversation-${layoutMode}-${width}.png`), (await window.webContents.capturePage()).toPNG())
    }
    await evaluate(`document.querySelectorAll('.chat-messages').forEach(node => node.className = 'chat-messages')`)
    await assertConversationAlignment(`${layoutMode}-without-layout-utilities`)
    await selectMessage('.primary-conversation')
    await evaluate(`getSelection().removeAllRanges()`)
    window.setContentSize(1920, 1080)
    await window.loadURL(`${rendererOrigin}/chat/${encodeURIComponent(idA)}?child=${encodeURIComponent(idChild)}`)
    await waitFor(`document.querySelector('.child-conversation .chat-messages')?.textContent.includes('child-only')`)
    await waitFor(`document.querySelector('.conversation-workspace.is-split') && document.querySelector('.primary-conversation .chat-assistant')`)
    await assertConversationAlignment(`${layoutMode}-split`, 2)
    await new Promise(resolve => setTimeout(resolve, 250))
    await writeFile(join(directory, `conversation-${layoutMode}-split.png`), (await window.webContents.capturePage()).toPNG())
    window.setContentSize(390, 844)
    await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
    await assertConversationAlignment(`${layoutMode}-split-mobile`)
    sidebarEdgeCases = true
    await window.loadURL(`${rendererOrigin}/chat/${encodeURIComponent(idEmpty)}`)
    await waitFor(`document.querySelector('.chat-message-list')?.textContent.includes('No messages yet.')`)
    assert.equal(await evaluate(`(() => {
      const rail = document.querySelector('.chat-message-list').getBoundingClientRect();
      const pane = document.querySelector('.chat-history').getBoundingClientRect();
      return rail.width > 0 && Math.abs(rail.left + rail.right - pane.left - pane.right) <= 1;
    })()`), true, 'An empty transcript keeps the same centered rail')
    console.log(`LAYOUT_RESULT ${JSON.stringify({ ok: true, mode: layoutMode })}`)
    return
  }
  assert.equal(await evaluate(`!document.querySelector('.diagnosis-toggle') && document.querySelector('.diagnosis-tab [role="tab"]').getAttribute('aria-selected') === 'false' && document.querySelector('.chat-history').getAttribute('role') === 'region'`), true, 'Diagnosis is a permanent document tab beside Conversation')
  assert.equal(await evaluate(`(() => {
    const folders = document.querySelector('.folders-sidebar').getBoundingClientRect();
    const explorer = document.querySelector('.workbench-explorer').getBoundingClientRect();
    const editor = document.querySelector('.workbench-editor').getBoundingClientRect();
    return explorer.width >= 180 && explorer.left >= folders.right - 1 && explorer.right <= editor.left + 1;
  })()`), true, 'Persistent explorer must sit between Folders and the document editor')
  await waitFor(`Boolean(document.querySelector('.chat-user .message-time'))`)
  assert.equal(await evaluate(`document.querySelector('.chat-user .message-time').dateTime`), timestamp(100))
  assert.equal(await evaluate(`document.querySelector('.chat-assistant .message-time').dateTime`), timestamp(1800))
  const spacing = await evaluate<{ margin: string; footerGap: number; bottomGap: number }>(`(() => {
    const bubble = document.querySelector('.chat-user');
    const content = bubble.querySelector('.chat-content > :last-child');
    const footer = bubble.querySelector('.chat-footer');
    return { margin: getComputedStyle(content).marginBottom, footerGap: footer.getBoundingClientRect().top - content.getBoundingClientRect().bottom, bottomGap: bubble.getBoundingClientRect().bottom - footer.getBoundingClientRect().bottom };
  })()`)
  assert.equal(spacing.margin, '0px', 'Markdown paragraph margin must not add empty padding below the text')
  assert.ok(spacing.footerGap >= 0 && spacing.footerGap <= 10)
  assert.ok(spacing.bottomGap >= 0 && spacing.bottomGap <= 10)
  assert.equal(await evaluate(`document.querySelectorAll('.chat-role, .chat-sender').length`), 0, 'Direct chat must not display role or sender labels')
  assert.match(await evaluate<string>(`document.querySelector('.chat-content h2').textContent`), /Rendering compatibility/)
  assert.equal(await evaluate(`document.querySelector('.chat-content strong').textContent`), 'Strong text')
  assert.equal(await evaluate(`document.querySelector('.chat-content table td').textContent`), 'Fixture')
  assert.equal(await evaluate(`document.querySelectorAll('.chat-content ul li').length`), 2)
  assert.match(await evaluate<string>(`document.querySelector('.chat-content pre code').textContent`), /const answer = 42/)
  assert.equal(await evaluate(`document.querySelector('.chat-content a').target`), '_blank')
  assert.equal(await evaluate(`document.querySelector('.chat-content a').rel`), 'noopener noreferrer')
  assert.equal(await evaluate(`document.querySelectorAll('.chat-content .katex math').length`), 2)
  assert.equal(await evaluate(`Boolean(document.querySelector('.chat-content .katex-display'))`), true)
  assert.equal(await evaluate(`Boolean(window.unsafeMarkup || document.querySelector('.chat-content [onclick], .chat-content script'))`), false)
  for (const selector of ['.theme-toggle span', '.model-chevron', '.composer-send span', '.diagnosis-tab .document-icon']) {
    assert.equal(await evaluate(`(() => { const icon = document.querySelector(${JSON.stringify(selector)}); const css = getComputedStyle(icon); return icon.getAttribute('aria-hidden') === 'true' && css.maskImage.includes('data:image/svg+xml') && icon.getBoundingClientRect().width >= 12; })()`), true, `Missing generated icon: ${selector}`)
  }
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.chat-content > :first-child')).marginTop`), '0px')
  await assertConversationCaps(true)
  for (const selector of ['.chat-bubble', '.tool-group', '.system-event', '.compaction-summary']) {
    assert.equal(await evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(selector)})).borderRadius`), '0px', selector)
  }
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.composer-box')).borderRadius`), '0px')
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.btn')).borderRadius`), '0px')
  assert.equal(await evaluate(`(() => { const style = getComputedStyle(document.documentElement); const tokens = Array.from(style).filter(name => name.startsWith('--radius-')); return tokens.length >= 6 && tokens.every(name => style.getPropertyValue(name).trim() === '0px'); })()`), true, 'All shared radius tokens default to zero')
  await evaluate(`document.documentElement.style.setProperty('--radius-surface', '22px')`)
  for (const selector of ['.chat-bubble', '.tool-group', '.system-event', '.compaction-summary']) {
    assert.equal(await evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(selector)})).borderRadius`), '22px', `${selector}: changing --radius-surface must update the conversation surface`)
  }
  await evaluate(`document.documentElement.style.removeProperty('--radius-surface')`)
  await assertSquareUi()
  assert.equal(traceQueries.length, 0, 'Opening conversation must not eagerly fetch diagnosis')
  await waitFor(`document.querySelector('.heading-folder')?.textContent === 'shadow'`)
  assert.equal(await evaluate(`document.querySelector('.session-heading').textContent.includes(${JSON.stringify(idA)}) || Boolean(document.querySelector('.session-config-badges, .chat-header'))`), false)
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.folder-session-row .tree-icon span')).maskImage.includes('data:image/svg+xml')`), true)
  assert.equal(await evaluate(`(() => {
    const rows = [document.querySelector('.folder-folder-row'), document.querySelector('.folder-session-row'), document.querySelector('.file-tree .tree-item')];
    const heights = rows.map(row => row.getBoundingClientRect().height);
    return rows.every(row => row.classList.contains('tree-item') && getComputedStyle(row.querySelector('.tree-label')).textOverflow === 'ellipsis'
      && getComputedStyle(row.querySelector('.tree-label')).whiteSpace === 'nowrap')
      && heights.every(height => height === heights[0] && height >= 34)
      && rows.every(row => { const icon = row.querySelector('.tree-icon').getBoundingClientRect(); const label = row.querySelector('.tree-label').getBoundingClientRect();
        return icon.width === 16 && icon.height === 16 && Math.abs(icon.top + icon.height / 2 - label.top - label.height / 2) < 1; })
      && !document.querySelector('.tree-item button button, .session-description');
  })()`), true, 'Folders, conversations and files share compact single-line rows, icon alignment and truncation without nested buttons')
  const childTreeSelector = '.folders-sidebar .session-select[aria-label="Child conversation"]'
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(childTreeSelector)}).closest('.tree-item').style.getPropertyValue('--tree-depth')`), '1')
  await click('.folder-session-row.active .lineage-toggle')
  assert.equal(await evaluate(`Boolean(document.querySelector(${JSON.stringify(childTreeSelector)}))`), false, 'Shared disclosure hides descendants without selecting another conversation')
  await click('.folder-session-row.active .lineage-toggle')
  await waitFor(`Boolean(document.querySelector(${JSON.stringify(childTreeSelector)}))`)
  await waitFor(`document.querySelector('.tool-activity-summary .lines-added')?.textContent === '+7'`)
  assert.equal(await evaluate(`document.querySelector('.tool-activity-summary .lines-removed').textContent`), '-3')
  assert.equal(await evaluate(`document.querySelector('.tool-activity-summary').textContent.includes('4 other tool calls')`), true)
  assert.equal(await evaluate(`document.querySelector('.tool-activity').open`), false)
  await click('.tool-activity-summary')
  await waitFor(`document.querySelector('.tool-activity').open`)
  assert.equal(await evaluate(`document.querySelector('.activity-files').textContent.includes('2 files edited')`), true)
  assert.equal(await evaluate(`document.querySelectorAll('.tool-entry').length`), 5)
  const assertToolAlignment = async () => {
    const offsets = await evaluate<number[]>(`Array.from(document.querySelectorAll('.tool-call-header'), row => {
      const icon = row.querySelector('.tool-icon').getBoundingClientRect();
      const text = row.querySelector('.tool-name').getBoundingClientRect();
      return Math.abs(icon.y + icon.height / 2 - text.y - text.height / 2);
    })`)
    assert.ok(offsets.every(offset => offset < 1), `Tool icon/text center offsets: ${offsets}`)
    const missing = await evaluate<string[]>(`Array.from(document.querySelectorAll('.tool-icon')).filter(icon => !getComputedStyle(icon).maskImage.includes('data:image/svg+xml')).map(icon => icon.className)`)
    assert.deepEqual(missing, [], 'Every activity row must render its icon')
  }
  await assertToolAlignment()
  await evaluate(`document.querySelector('.tool-activity').scrollIntoView({ block: 'center' })`)
  await new Promise(resolve => setTimeout(resolve, 200))
  await writeFile(join(directory, 'tool-activity-desktop.png'), (await window.webContents.capturePage()).toPNG())
  window.webContents.enableDeviceEmulation({ screenPosition: 'desktop', screenSize: { width: 390, height: 844 }, viewPosition: { x: 0, y: 0 }, viewSize: { width: 390, height: 844 }, deviceScaleFactor: 1, scale: 1 })
  await waitFor(`innerWidth === 390`)
  await new Promise(resolve => setTimeout(resolve, 200))
  await assertToolAlignment()
  assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth && document.querySelector('.tool-activity-summary .line-changes').getBoundingClientRect().right <= innerWidth`), true)
  await evaluate(`document.querySelector('.tool-activity').scrollIntoView({ block: 'center' })`)
  await writeFile(join(directory, 'tool-activity-mobile.png'), (await window.webContents.capturePage({ x: 0, y: 0, width: 390, height: 844 })).toPNG())
  window.webContents.disableDeviceEmulation()
  await waitFor(`innerWidth > 1280`)
  await click('.tool-activity-summary')
  await evaluate(`document.querySelector('.chat-messages').scrollTop = 0`)
  await evaluate(`(() => {
    const input = document.querySelector('.composer-input textarea');
    input.value = 'Keep draft and selection';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
    input.setSelectionRange(2, 8);
    window.stableComposerInput = input;
    window.stableMessage = document.querySelector('.chat-bubble');
  })()`)
  const historyBeforeRepeat = chatHistoryRequests.length
  await click('.session-select[aria-current="page"]')
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(chatHistoryRequests.length, historyBeforeRepeat, 'Selecting the current conversation must not fetch history again')
  assert.equal(await evaluate(`document.querySelector('.chat-bubble') === window.stableMessage && document.querySelector('.composer-input textarea') === window.stableComposerInput && window.stableComposerInput.value === 'Keep draft and selection' && window.stableComposerInput.selectionStart === 2`), true)
  await click('.folder-folder')
  await waitFor(`document.querySelector('.folder-toggle').getAttribute('aria-expanded') === 'true'`)
  assert.equal(await evaluate(`!document.querySelector('.folder-folder-row.selected') && !!document.querySelector('.folder-session-row.active.selected')`), true, 'Selecting a folder header does not duplicate the active conversation highlight')
  await click('.folder-folder')
  assert.equal(await evaluate(`document.querySelector('.folder-toggle').getAttribute('aria-expanded')`), 'true', 'Selecting the current folder must not toggle its contents')
  assert.equal(chatHistoryRequests.length, historyBeforeRepeat)
  assert.equal(await evaluate(`window.stableComposerInput.value`), 'Keep draft and selection')
  await click('.folder-toggle')
  assert.equal(await evaluate(`document.querySelector('.folder-toggle').getAttribute('aria-expanded')`), 'false', 'Folder disclosure remains independently operable')

  const composerBounds = () => evaluate(`(() => { const box = document.querySelector('.composer-box'); const rect = box.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, border: getComputedStyle(box).borderColor }; })()`)
  let releaseSettings!: () => void
  settingsGate = new Promise(resolve => { releaseSettings = resolve })
  await click('.composer-controls [aria-label="Choose model"]')
  await click('.model-menu-effort')
  await new Promise(resolve => setTimeout(resolve, 200))
  const boundsBeforeSettings = await composerBounds()
  await evaluate(`Array.from(document.querySelectorAll('.effort-option')).find(button => button.querySelector('.setting-option-copy > span').textContent.trim() === 'High').click()`)
  await waitFor(`document.querySelector('.composer-controls [aria-label="Choose model"]').getAttribute('aria-busy') === 'true'`)
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.deepEqual(await composerBounds(), boundsBeforeSettings, 'Saving settings must not insert a row or move the input box')
  assert.equal(await evaluate(`document.activeElement === document.querySelector('.composer-controls [aria-label="Choose model"]') && getComputedStyle(document.activeElement).opacity === '1'`), true, 'Saving must retain focus without dimming the control')
  await click('.composer-controls [aria-label="Choose model"]')
  assert.equal(await evaluate(`Boolean(document.querySelector('.composer-popover'))`), false, 'Busy controls must not reopen or submit duplicates')
  releaseSettings()
  await waitFor(`document.querySelector('.composer-controls [aria-label="Choose model"]').getAttribute('aria-busy') !== 'true'`)
  assert.deepEqual(await composerBounds(), boundsBeforeSettings)
  const patchesBeforeRepeat = settingsPatches.length
  await chooseSetting('High')
  assert.equal(settingsPatches.length, patchesBeforeRepeat, 'Choosing the current setting must not save again')
  assert.deepEqual(settingsPatches.at(-1), { sessionId: idA, patch: { thinking: { type: 'enabled' }, reasoningEffort: 'high' } })
  await chooseSetting('Max')
  assert.deepEqual(settings.get(idA), { thinking: { type: 'enabled' }, reasoningEffort: 'max' })
  await chooseSetting('Low')
  assert.deepEqual(settingsPatches.at(-1)?.patch, { thinking: { type: 'enabled' }, reasoningEffort: 'low' })
  await chooseSetting('Max')
  failSettings = true
  await chooseSetting('High')
  assert.equal(await evaluate(`document.querySelector('.model-effort').textContent.includes('Max')`), true)
  assert.equal(await evaluate(`document.querySelector('.composer-error').textContent.includes('Could not save')`), true)
  failSettings = false
  await chooseSetting('Default')
  assert.deepEqual(settingsPatches.at(-1)?.patch, { thinking: null, reasoningEffort: null })
  assert.equal(settings.get(idA)?.reasoningEffort, undefined)
  assert.equal(await evaluate(`Boolean(document.querySelector('.composer-error'))`), false)
  let releaseModel!: () => void
  providerSaveGate = new Promise(resolve => { releaseModel = resolve })
  await click('.composer-controls [aria-label="Choose model"]')
  await click('.model-menu-model')
  await new Promise(resolve => setTimeout(resolve, 200))
  const boundsBeforeModel = await composerBounds()
  await evaluate(`Array.from(document.querySelectorAll('.model-option')).find(button => button.textContent.trim() === 'synthetic-other').click()`)
  await waitFor(`document.querySelector('.composer-controls [aria-label="Choose model"]').getAttribute('aria-busy') === 'true'`)
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.deepEqual(await composerBounds(), boundsBeforeModel)
  assert.equal(await evaluate(`document.querySelector('.model-label').textContent`), 'synthetic-model', 'The selected model label must stay visible during saves')
  assert.equal(await evaluate(`document.activeElement === document.querySelector('.composer-controls [aria-label="Choose model"]') && getComputedStyle(document.activeElement).opacity === '1'`), true)
  releaseModel()
  await waitFor(`document.querySelector('.model-label').textContent === 'synthetic-other' && document.querySelector('.composer-controls [aria-label="Choose model"]').getAttribute('aria-busy') !== 'true'`)
  assert.deepEqual(await composerBounds(), boundsBeforeModel)
  assert.equal(await evaluate(`document.querySelector('.composer-input textarea') === window.stableComposerInput && window.stableComposerInput.value === 'Keep draft and selection' && window.stableComposerInput.selectionStart === 2`), true)
  const savesBeforeRepeat = providerSaves.length
  await click('.composer-controls [aria-label="Choose model"]')
  await click('.model-menu-model')
  await evaluate(`Array.from(document.querySelectorAll('.model-option')).find(button => button.textContent.trim() === 'synthetic-other').click()`)
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(providerSaves.length, savesBeforeRepeat, 'Choosing the current model must not reconfigure the provider')
  await click('.composer-controls [aria-label="Choose model"]')
  await click('.model-menu-model')
  await evaluate(`Array.from(document.querySelectorAll('.model-option')).find(button => button.textContent.trim() === 'synthetic-model').click()`)
  await waitFor(`document.querySelector('.model-label').textContent === 'synthetic-model' && document.querySelector('.composer-controls [aria-label="Choose model"]').getAttribute('aria-busy') !== 'true'`)
  await evaluate(`window.stableComposerInput.value = ''; window.stableComposerInput.dispatchEvent(new Event('input', { bubbles: true }))`)
  await click('[aria-label="Session details"]')
  await waitFor(`document.querySelector('.session-details progress')?.value === 20 && !document.querySelector('.session-details [role="status"]')`)
  assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('.session-details dt'), node => node.textContent)`), ['Path', 'Session name', 'Session ID', 'Tokens'])
  assert.equal(await evaluate(`document.querySelector('.session-details').textContent.includes('C:\\\\synthetic\\\\shadow')`), true)
  assert.equal(await evaluate(`document.querySelector('.session-details').textContent.includes('100K limit')`), true)
  assert.equal(await evaluate(`document.querySelectorAll('.session-details button').length`), 0)
  assert.equal(await evaluate(`document.activeElement.getAttribute('aria-label')`), 'Session details')
  await writeFile(join(directory, 'session-heading-desktop.png'), (await window.webContents.capturePage()).toPNG())
  await closeDetails()
  assert.equal(await evaluate(`document.activeElement.getAttribute('aria-label')`), 'Session details')
  failDetails = true
  await click('[aria-label="Session details"]')
  await waitFor(`Boolean(document.querySelector('.details-error'))`)
  assert.equal(await evaluate(`Boolean(document.querySelector('.session-details progress'))`), false)
  await closeDetails()
  failDetails = false
  window.webContents.enableDeviceEmulation({ screenPosition: 'desktop', screenSize: { width: 390, height: 844 }, viewPosition: { x: 0, y: 0 }, viewSize: { width: 390, height: 844 }, deviceScaleFactor: 1, scale: 1 })
  await waitFor(`innerWidth === 390`)
  await new Promise(resolve => setTimeout(resolve, 200))
  await click('[aria-label="Session details"]')
  await waitFor(`Boolean(document.querySelector('.session-details progress'))`)
  assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth && document.querySelector('.composer-box').getBoundingClientRect().bottom <= innerHeight && document.querySelector('.composer-popover').getBoundingClientRect().right <= innerWidth`), true)
  await writeFile(join(directory, 'session-heading-mobile.png'), (await window.webContents.capturePage({ x: 0, y: 0, width: 390, height: 844 })).toPNG())
  await assertConversationCaps()
  await assertSquareUi()
  await closeDetails()
  window.webContents.disableDeviceEmulation()
  await waitFor(`innerWidth > 700`)
  await new Promise(resolve => setTimeout(resolve, 150))
  const keyboard = window.webContents.debugger
  keyboard.attach('1.3')
  const nativeKey = async (key: string, code: string, keyCode: number, text?: string, modifiers = 0) => {
    await keyboard.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyDown', key, code, modifiers, windowsVirtualKeyCode: keyCode, ...(text ? { text, unmodifiedText: text } : {}),
    })
    await keyboard.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyUp', key, code, modifiers, windowsVirtualKeyCode: keyCode,
    })
  }
  const dragSidebar = async (selector: string, delta: number, end: 'up' | 'cancel' | 'blur' | 'lost' = 'up') => {
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).addEventListener('pointerdown', event => { window.sidebarPointerId = event.pointerId; }, { once: true })`)
    const point = await evaluate<{ x: number; y: number }>(`(() => { const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + 100 }; })()`)
    await keyboard.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 })
    await keyboard.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x + delta, y: point.y, button: 'left', buttons: 1 })
    await waitFor(`document.querySelector(${JSON.stringify(selector)}).classList.contains('is-resizing') && document.querySelector(${JSON.stringify(selector)}).hasPointerCapture(window.sidebarPointerId)`)
    if (end === 'cancel') await evaluate(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new PointerEvent('pointercancel', { pointerId: window.sidebarPointerId, bubbles: true }))`)
    if (end === 'blur') await evaluate(`window.dispatchEvent(new Event('blur'))`)
    if (end === 'lost') await evaluate(`document.querySelector(${JSON.stringify(selector)}).releasePointerCapture(window.sidebarPointerId)`)
    await keyboard.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x + delta, y: point.y, button: 'left', buttons: 0, clickCount: 1 })
    await waitFor(`!document.querySelector('.sidebar-resizer.is-resizing') && !document.documentElement.classList.contains('sidebar-pointer-resizing')`)
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(selector)}).hasPointerCapture(window.sidebarPointerId)`), false, `${end} releases sidebar pointer capture`)
  }
  const historyBeforeResize = chatHistoryRequests.length
  await evaluate(`window.sidebarStableInput = document.querySelector('.composer-input textarea'); window.sidebarStableMessage = document.querySelector('.chat-bubble')`)
  for (const side of [
    { selector: '.folders-resizer', root: '.folders-sidebar', label: 'Resize folders', initial: 260, min: 200, max: 400 },
    { selector: '.files-resizer', root: '.workbench-explorer', label: 'Resize files', initial: 220, min: 180, max: 360 },
  ]) {
    await waitFor(`document.querySelector(${JSON.stringify(side.selector)})?.getClientRects().length > 0`)
    assert.equal(await evaluate(`(() => { const separator = document.querySelector(${JSON.stringify(side.selector)}); return separator.getAttribute('role') === 'separator' && separator.getAttribute('aria-label') === ${JSON.stringify(side.label)} && separator.getAttribute('aria-orientation') === 'vertical' && document.getElementById(separator.getAttribute('aria-controls')) === document.querySelector(${JSON.stringify(side.root)}); })()`), true)
    assert.equal(await evaluate(`Number(document.querySelector(${JSON.stringify(side.selector)}).getAttribute('aria-valuenow'))`), side.initial)
    await dragSidebar(side.selector, 48)
    await waitFor(`Math.abs(document.querySelector(${JSON.stringify(side.root)}).getBoundingClientRect().width - ${side.initial + 48}) < 2`)
    for (const end of ['cancel', 'blur', 'lost'] as const) await dragSidebar(side.selector, 8, end)
    await evaluate(`document.querySelector(${JSON.stringify(side.selector)}).focus()`)
    await nativeKey('Home', 'Home', 36)
    assert.equal(await evaluate(`Number(document.querySelector(${JSON.stringify(side.selector)}).getAttribute('aria-valuenow'))`), side.min)
    await nativeKey('End', 'End', 35)
    assert.equal(await evaluate(`Number(document.querySelector(${JSON.stringify(side.selector)}).getAttribute('aria-valuenow'))`), side.max)
    await nativeKey('ArrowRight', 'ArrowRight', 39)
    assert.equal(await evaluate(`Number(document.querySelector(${JSON.stringify(side.selector)}).getAttribute('aria-valuenow'))`), side.max, 'Sidebar keyboard resize clamps to its maximum')
    await nativeKey('ArrowLeft', 'ArrowLeft', 37)
    assert.equal(await evaluate(`Number(document.querySelector(${JSON.stringify(side.selector)}).getAttribute('aria-valuenow'))`), side.max - 24)
    await nativeKey('Home', 'Home', 36)
    await dragSidebar(side.selector, side.initial - side.min)
  }
  await click('[aria-label="Collapse files"]')
  assert.equal(await evaluate(`Boolean(document.querySelector('.files-resizer'))`), false, 'Collapsed explorer must not retain a resize target')
  await click('.explorer-toggle')
  await waitFor(`document.querySelector('.files-resizer')`)
  window.webContents.enableDeviceEmulation({ screenPosition: 'desktop', screenSize: { width: 720, height: 900 }, viewPosition: { x: 0, y: 0 }, viewSize: { width: 720, height: 900 }, deviceScaleFactor: 1, scale: 1 })
  await waitFor(`innerWidth === 720 && !document.querySelector('.files-resizer')`)
  await evaluate(`document.querySelector('.folders-resizer').focus()`)
  await nativeKey('End', 'End', 35)
  assert.equal(await evaluate(`(() => { const separator = document.querySelector('.folders-resizer'); const workspace = document.querySelector('.chat-workspace').getBoundingClientRect(); return Number(separator.getAttribute('aria-valuenow')) === Number(separator.getAttribute('aria-valuemax')) && Number(separator.getAttribute('aria-valuemax')) <= workspace.width - 360 && document.documentElement.scrollWidth <= innerWidth; })()`), true, 'Folders width respects remaining editor space on smaller desktop viewports')
  window.webContents.enableDeviceEmulation({ screenPosition: 'desktop', screenSize: { width: 390, height: 844 }, viewPosition: { x: 0, y: 0 }, viewSize: { width: 390, height: 844 }, deviceScaleFactor: 1, scale: 1 })
  await waitFor(`innerWidth === 390 && !document.querySelector('.folders-resizer, .files-resizer')`)
  window.webContents.disableDeviceEmulation()
  await waitFor(`innerWidth > 1280 && document.querySelector('.folders-resizer')`)
  await evaluate(`document.querySelector('.folders-resizer').focus()`)
  await nativeKey('Home', 'Home', 36)
  await dragSidebar('.folders-resizer', 60)
  await waitFor(`document.querySelector('.files-resizer') && Math.abs(document.querySelector('.workbench-explorer').getBoundingClientRect().width - 220) < 2`)
  assert.equal(chatHistoryRequests.length, historyBeforeResize)
  assert.equal(await evaluate(`document.querySelector('.composer-input textarea') === window.sidebarStableInput && document.querySelector('.chat-bubble') === window.sidebarStableMessage`), true, 'Resizing and responsive transitions preserve conversation DOM')
  const prepareComposer = async (value: string, start = value.length, end = start) => {
    await evaluate(`(() => {
      const input = document.querySelector('.composer-input textarea');
      input.focus(); input.value = ${JSON.stringify(value)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.setSelectionRange(${start}, ${end}); input.blur();
    })()`)
  }
  await prepareComposer('')
  await nativeKey('a', 'KeyA', 65, 'a')
  assert.equal(await evaluate(`document.querySelector('.composer-input textarea').value`), 'a', 'Native first key must be inserted exactly once after focus')
  await evaluate(`document.activeElement.blur()`)
  await nativeKey('Backspace', 'Backspace', 8)
  assert.equal(await evaluate(`document.querySelector('.composer-input textarea').value`), '', 'Backspace must focus and delete on the same press')
  await prepareComposer('A\u{1F642}')
  await nativeKey('Backspace', 'Backspace', 8)
  assert.equal(await evaluate(`document.querySelector('.composer-input textarea').value`), 'A', 'Native deletion must not split a surrogate pair')
  await prepareComposer('abcde', 1, 4)
  await nativeKey('Backspace', 'Backspace', 8)
  assert.equal(await evaluate(`document.querySelector('.composer-input textarea').value`), 'ae', 'Backspace should respect the retained selection')
  await nativeKey('z', 'KeyZ', 90, undefined, process.platform === 'darwin' ? 4 : 2)
  assert.equal(await evaluate(`document.querySelector('.composer-input textarea').value`), 'abcde', 'Redirected deletion must remain undoable')
  await evaluate(`(() => { const input = document.createElement('input'); input.id = 'keyboard-focus-fixture'; input.value = 'safe'; document.body.append(input); input.focus(); })()`)
  await nativeKey('Backspace', 'Backspace', 8)
  assert.equal(await evaluate(`document.querySelector('#keyboard-focus-fixture').value`), 'saf')
  assert.equal(await evaluate(`document.querySelector('.composer-input textarea').value`), 'abcde')
  await evaluate(`document.querySelector('#keyboard-focus-fixture').remove()`)
  await prepareComposer('')
  await nativeKey('Backspace', 'Backspace', 8)
  assert.equal(await evaluate(`document.activeElement === document.querySelector('.composer-input textarea') && document.activeElement.value === ''`), true)
  await prepareComposer('')
  await nativeKey('Process', 'KeyN', 229)
  assert.equal(await evaluate(`document.activeElement === document.querySelector('.composer-input textarea') && document.activeElement.value === ''`), true, 'IME start focuses without inserting an English key')
  await evaluate(`(() => {
    window.keyboardImeEvents = [];
    const input = document.querySelector('.composer-input textarea');
    for (const name of ['compositionstart', 'compositionend']) input.addEventListener(name, () => window.keyboardImeEvents.push(name), { once: true });
  })()`)
  await keyboard.sendCommand('Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 })
  await evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }))`)
  await keyboard.sendCommand('Input.insertText', { text: '\u4f60' })
  assert.equal(await evaluate(`document.querySelector('.composer-input textarea').value`), '\u4f60')
  assert.deepEqual(await evaluate(`window.keyboardImeEvents`), ['compositionstart', 'compositionend'])
  assert.equal(await evaluate(`document.querySelector('.composer-send').disabled`), false, 'Committed IME text must update the Vue draft')
  await evaluate(`(() => {
    window.copiedSelections = [];
    window.rejectSelectionCopy = false;
    Object.defineProperty(navigator.clipboard, 'writeText', {
      configurable: true,
      value: async text => {
        if (window.rejectSelectionCopy) throw new Error('Synthetic clipboard unavailable');
        window.copiedSelections.push(text);
      },
    });
  })()`)
  const sendsBeforeSelection = sentMessages.length
  const sessionsBeforeSelection = extraSessions.length
  await prepareComposer('before after', 7)
  await selectMessage('.primary-conversation')
  assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('.selection-menu [role="menuitem"]'), item => item.querySelector('span:nth-child(2)').textContent)`), ['Quote', 'Copy'])
  assert.equal(await evaluate(`document.querySelector('textarea').value`), 'before after', 'Selecting text must not alter the composer')
  assert.equal(await evaluate(`!document.querySelector('.selection-highlight-overlay, .has-selection, .selection-indicator') && getSelection().toString().length > 0`), true, 'Selection retains only the native browser highlight')
  for (const key of ['q', 'c']) {
    for (const modifiers of [{ ctrlKey: true }, { shiftKey: true }, { isComposing: true }, { repeat: true }]) {
      await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true, ...${JSON.stringify(modifiers)} }))`)
      assert.equal(await evaluate(`document.querySelector('textarea').value`), 'before after')
      assert.equal(await evaluate(`Boolean(document.querySelector('.selection-menu'))`), true)
    }
  }
  const quoteText = await evaluate<string>(`getSelection().toString()`)
  await nativeKey('q', 'KeyQ', 81, 'q')
  await waitFor(`!document.querySelector('.selection-menu') && document.activeElement === document.querySelector('textarea')`)
  assert.equal(await evaluate(`document.querySelector('textarea').value`), `before \n\n> ${quoteText.split(/\r?\n/).join('\n> ')}\n\nafter`)
  assert.equal(sentMessages.length, sendsBeforeSelection)
  assert.equal(extraSessions.length, sessionsBeforeSelection, 'Quote inserts into the current composer without forking a session')
  await captureSelectionMenu('selection-menu-desktop.png')
  const selectedForCopy = await evaluate<string>(`getSelection().toString()`)
  await nativeKey('c', 'KeyC', 67, 'c')
  await waitFor(`!document.querySelector('.selection-menu')`)
  assert.equal(await evaluate(`window.copiedSelections.at(-1)`), selectedForCopy, 'Bare c passes selected text to the isolated clipboard stub')
  await selectMessage('.primary-conversation')
  const copiesBeforeRejection = await evaluate<number>(`window.copiedSelections.length`)
  await evaluate(`window.rejectSelectionCopy = true`)
  await nativeKey('c', 'KeyC', 67, 'c')
  await waitFor(`document.querySelector('.selection-menu-error')?.textContent.includes('Synthetic clipboard unavailable') && !document.querySelector('.selection-menu button:last-of-type').disabled`)
  assert.equal(await evaluate(`window.copiedSelections.length`), copiesBeforeRejection)
  assert.equal(await evaluate(`getSelection().toString()`), selectedForCopy, 'Failed Copy keeps the native selection available for retry')
  await evaluate(`window.rejectSelectionCopy = false`)
  await click('.selection-menu button:last-of-type')
  await waitFor(`!document.querySelector('.selection-menu')`)
  assert.equal(await evaluate(`window.copiedSelections.length`), copiesBeforeRejection + 1)
  assert.equal(await evaluate(`window.copiedSelections.at(-1)`), selectedForCopy)
  await selectMessage('.primary-conversation')
  await evaluate(`document.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true }))`)
  await waitFor(`!document.querySelector('.selection-menu')`)
  await selectMessage('.primary-conversation')
  await evaluate(`window.dispatchEvent(new Event('blur'))`)
  await waitFor(`!document.querySelector('.selection-menu')`)
  await selectMessage('.primary-conversation')
  await nativeKey('Escape', 'Escape', 27)
  await waitFor(`!document.querySelector('.selection-menu')`)
  await selectMessage('.primary-conversation')
  await evaluate(`document.querySelector('.chat-messages').dispatchEvent(new Event('scroll'))`)
  await waitFor(`!document.querySelector('.selection-menu')`)
  await selectMessage('.primary-conversation')
  const outsideSelection = await evaluate<{ x: number; y: number }>(`(() => { const rect = document.querySelector('.document-toolbar').getBoundingClientRect(); return { x: rect.right - 10, y: rect.y + rect.height / 2 }; })()`)
  await keyboard.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...outsideSelection, button: 'left', buttons: 1, clickCount: 1 })
  await keyboard.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', ...outsideSelection, button: 'left', buttons: 0, clickCount: 1 })
  await waitFor(`!document.querySelector('.selection-menu')`)
  await evaluate(`getSelection().removeAllRanges()`)
  await evaluate(`document.querySelector('.chat-assistant .chat-content').scrollIntoView({ block: 'center' })`)
  await new Promise(resolve => setTimeout(resolve, 100))
  const dragSelection = await evaluate<{ start: { x: number; y: number }; end: { x: number; y: number } }>(`(() => {
    const text = document.querySelector('.chat-assistant .chat-content p').firstChild;
    const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 1);
    const first = range.getBoundingClientRect();
    range.setStart(text, Math.min(20, text.length - 1)); range.setEnd(text, Math.min(21, text.length));
    const last = range.getBoundingClientRect();
    return { start: { x: first.left + 1, y: first.top + first.height / 2 }, end: { x: last.right - 1, y: last.top + last.height / 2 } };
  })()`)
  await keyboard.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...dragSelection.start, button: 'left', buttons: 1, clickCount: 1 })
  await keyboard.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...dragSelection.end, button: 'left', buttons: 1 })
  await keyboard.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', ...dragSelection.end, button: 'left', buttons: 0, clickCount: 1 })
  await waitFor(`document.querySelector('.selection-menu') && getSelection().toString().trim().length > 0`)
  await nativeKey('Escape', 'Escape', 27)
  await selectMessage('.primary-conversation')
  await showSessionView(true)
  await waitFor(`!document.querySelector('.selection-menu')`)
  await showSessionView(false)
  await evaluate(`getSelection().removeAllRanges()`)
  window.webContents.enableDeviceEmulation({ screenPosition: 'desktop', screenSize: { width: 390, height: 844 }, viewPosition: { x: 0, y: 0 }, viewSize: { width: 390, height: 844 }, deviceScaleFactor: 1, scale: 1 })
  await waitFor(`innerWidth === 390`)
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(await evaluate(`!!document.querySelector('[aria-label="Switch view"]') && !document.querySelector('.diagnosis-toggle')`), true, 'Mobile view selection replaces the title-row diagnosis action')
  await captureSelectionMenu('selection-menu-mobile.png', true)
  await nativeKey('Escape', 'Escape', 27)
  window.webContents.disableDeviceEmulation()
  await waitFor(`innerWidth > 1280`)
  await prepareComposer('\u4f60')
  await waitFor(`document.querySelector('.file-workbench.explorer-docked') && document.querySelector('.workbench-explorer').getClientRects().length > 0`)
  assert.ok(fileRequests.some(request => request.sessionId === idA), 'The visible persistent explorer loads the selected session')
  const historyBeforeDocuments = chatHistoryRequests.length
  await evaluate(`(() => {
    window.documentInput = document.querySelector('.composer-input textarea');
    window.documentMessage = document.querySelector('.chat-bubble');
    const scroll = document.querySelector('.chat-messages');
    scroll.scrollTop = 120; window.documentScroll = scroll.scrollTop;
    window.expandedEditorWidth = document.querySelector('.workbench-editor').getBoundingClientRect().width;
  })()`)
  await click('[aria-label="Collapse files"]')
  await waitFor(`!document.querySelector('.workbench-explorer').getClientRects().length`)
  assert.equal(await evaluate(`document.querySelector('.workbench-editor').getBoundingClientRect().width > window.expandedEditorWidth + 180 && document.querySelector('.composer-input textarea') === window.documentInput && document.querySelector('.chat-bubble') === window.documentMessage`), true, 'Collapsing the explorer expands horizontally without remounting chat')
  await click('.explorer-toggle')
  await waitFor(`document.querySelector('.tree-row[data-path="README.md"]')`)
  await click('.tree-row[data-path="src"]')
  await waitFor(`document.querySelector('.tree-row[data-path="src/main.ts"]')`)
  assert.equal(await evaluate(`document.querySelector('.tree-row[data-path="src/main.ts"]').closest('.tree-item').style.getPropertyValue('--tree-depth')`), '1', 'File and conversation children use the same indentation depth')
  assert.equal(await evaluate(`document.querySelector('.tree-row[data-path="src/main.ts"]').hasAttribute('aria-expanded')`), false, 'File leaves must not expose a disclosure state')
  await click('.tree-row[data-path="src/main.ts"]')
  await waitFor(`document.querySelector('.file-modal-text')?.textContent.includes('src/main.ts')`)
  await waitFor(`Array.from(document.querySelectorAll('.file-modal-text .file-syntax-token')).filter(token => token.style.getPropertyValue('--file-token-light') && token.style.getPropertyValue('--file-token-dark')).length > 1`)
  assert.equal(await evaluate(`document.querySelector('.file-modal-text').textContent`), typescriptPreviewSource, 'Shiki preserves CRLF, tabs, UTF-16 characters and the trailing newline without adding line-number text')
  const originalTheme = await evaluate<boolean>(`document.documentElement.classList.contains('dark')`)
  await evaluate(`document.documentElement.classList.add('dark')`)
  const darkTokens = await evaluate<string[]>(`Array.from(document.querySelectorAll('.file-modal-text .file-syntax-token'), token => getComputedStyle(token).color)`)
  await evaluate(`document.documentElement.classList.remove('dark')`)
  const lightTokens = await evaluate<string[]>(`Array.from(document.querySelectorAll('.file-modal-text .file-syntax-token'), token => getComputedStyle(token).color)`)
  assert.notDeepEqual(lightTokens, darkTokens, 'Syntax token colors follow both light and dark themes')
  await evaluate(`document.documentElement.classList.toggle('dark', ${originalTheme})`)
  const highlightedSelection = await selectFileText('.file-modal-text', typescriptPreviewSource.indexOf('export'), typescriptPreviewSource.length)
  assert.equal(await evaluate(`getSelection().getRangeAt(0).toString()`), typescriptPreviewSource.slice(typescriptPreviewSource.indexOf('export')), 'Ranges across styled tokens preserve exact source offsets and bytes represented by DOM text')
  assert.equal(await evaluate(`getSelection().getRangeAt(0).startContainer.parentNode !== getSelection().getRangeAt(0).endContainer.parentNode`), true, 'Highlighted source selection spans distinct token nodes')
  await nativeKey('c', 'KeyC', 67, 'c')
  await waitFor(`!document.querySelector('.selection-menu')`)
  assert.equal(await evaluate(`window.copiedSelections.at(-1)`), highlightedSelection, 'Copy from highlighted source uses exact native selected text')
  assert.equal(await evaluate(`document.querySelector('.file-modal-text').textContent`), typescriptPreviewSource)
  assert.deepEqual(fileRequests.at(-1), { sessionId: idA, path: 'src' })
  assert.equal(await evaluate(`document.querySelector('.file-modal-backdrop').classList.contains('inline') && document.querySelector('.file-tree-list').getBoundingClientRect().right <= document.querySelector('.file-modal').getBoundingClientRect().left + 1`), true)
  await evaluate(`document.activeElement.blur()`)
  await nativeKey('a', 'KeyA', 65, 'a')
  await nativeKey('Backspace', 'Backspace', 8)
  assert.equal(await evaluate(`window.documentInput.value`), '\u4f60', 'Keys outside the file composer must not redirect into it')
  assert.equal(await evaluate(`window.documentInput === document.querySelector('.composer-input textarea') && window.documentInput.getClientRects().length > 0`), true, 'Opening a file keeps the same composer visible')
  await assertFileComposer()
  await click('.tree-row[data-path="src/main.ts"]')
  assert.equal(await evaluate(`document.querySelectorAll('.document-tablist [role="tab"][aria-label="src/main.ts"]').length`), 1, 'Opening the same file must deduplicate its document tab')
  filePreviewGate = new Promise(resolve => { releaseFilePreview = resolve })
  const pendingPreviewStart = previewRequests.length
  await click('.tree-row[data-path="README.md"]')
  await waitFor(`Array.from(document.querySelectorAll('.file-modal-text-wrap')).some(node => node.getClientRects().length && node.textContent.includes('Loading'))`)
  for (let attempt = 0; attempt < 100 && !previewRequests.slice(pendingPreviewStart).some(request => request.path === 'README.md'); attempt++) await new Promise(resolve => setTimeout(resolve, 20))
  const pendingFilePreview = previewRequests.slice(pendingPreviewStart).find(request => request.path === 'README.md')
  assert.ok(pendingFilePreview, 'The gated preview must reach the fixture before testing cancellation')
  await click('.tree-row[data-path="src/main.ts"]')
  await waitFor(`document.querySelector('.document-tablist [aria-label="src/main.ts"]').getAttribute('aria-selected') === 'true'`)
  for (let attempt = 0; attempt < 100 && !pendingFilePreview.aborted; attempt++) await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(pendingFilePreview.aborted, true, 'Switching away aborts an in-flight file preview')
  releaseFilePreview!()
  await waitFor(`document.querySelector('.file-modal-text')?.textContent.includes('src/main.ts')`)
  await click('.document-tablist [aria-label="Close src/main.ts"]')
  await waitFor(`document.querySelector('.document-tablist [aria-label="README.md"]').getAttribute('aria-selected') === 'true' && document.querySelector('.file-markdown h1')?.textContent === 'README.md'`)
  assert.equal(await evaluate(`document.activeElement.getAttribute('aria-label')`), 'README.md', 'Closing the active file selects and focuses its next neighbour')
  failFiles = true
  await click('[aria-label="Refresh files"]')
  await waitFor(`document.querySelector('.file-tree [role="alert"]')?.textContent.includes('workdir is unavailable')`)
  failFiles = false
  await click('.file-tree [role="alert"] button')
  await waitFor(`document.querySelector('.tree-row[data-path="README.md"]')`)
  await click('.tree-row[data-path="README.md"]')
  await waitFor(`document.querySelector('.file-markdown h1')?.textContent === 'README.md'`)
  assert.equal(await evaluate(`document.querySelector('.file-markdown strong').textContent`), 'rendered')
  assert.equal(await evaluate(`document.querySelectorAll('.file-markdown li').length === 2 && !!document.querySelector('.file-markdown pre code') && !!document.querySelector('.file-markdown table')`), true)
  assert.equal(await evaluate(`!document.querySelector('.file-markdown script, .file-markdown style, .file-markdown [href^="javascript:"]') && !window.markdownExecuted`), true)
  assert.equal(await evaluate(`document.querySelector('.file-markdown a').getAttribute('href')`), `${origin}/api/sessions/${encodeURIComponent(idA)}/static/src/main.ts`)
  await writeFile(join(directory, 'session-files-desktop.png'), (await window.webContents.capturePage()).toPNG())
  await click('.tree-row[data-path="src"]')
  await waitFor(`document.querySelector('.tree-row[data-path="src/main.ts"]')`)
  await click('.tree-row[data-path="src/main.ts"]')
  assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('.document-tablist [role="tab"]'), node => node.getAttribute('aria-label') || node.textContent.trim())`), ['Conversation', 'Diagnosis', 'README.md', 'src/main.ts'])
  await nativeKey('Tab', 'Tab', 9, undefined, 2)
  await waitFor(`document.querySelector('.document-tablist [aria-selected="true"]').textContent.trim() === 'Conversation'`)
  await evaluate(`document.querySelector('.composer-input textarea').focus()`)
  await nativeKey('Tab', 'Tab', 9, undefined, 2)
  await waitFor(`document.querySelector('.diagnosis-tab [role="tab"]').getAttribute('aria-selected') === 'true'`)
  await nativeKey('Tab', 'Tab', 9, undefined, 2)
  await waitFor(`document.querySelector('.document-tablist [aria-label="README.md"]').getAttribute('aria-selected') === 'true'`)
  await nativeKey('Tab', 'Tab', 9, undefined, 10)
  await waitFor(`document.querySelector('.diagnosis-tab [role="tab"]').getAttribute('aria-selected') === 'true'`)
  await nativeKey('Tab', 'Tab', 9, undefined, 10)
  await waitFor(`document.querySelector('.document-tablist [aria-selected="true"]').textContent.trim() === 'Conversation'`)
  await nativeKey('Tab', 'Tab', 9, undefined, 10)
  await waitFor(`document.querySelector('.document-tablist [aria-label="src/main.ts"]').getAttribute('aria-selected') === 'true'`)
  await evaluate(`document.querySelector('.folder-folder').focus()`)
  await nativeKey('Tab', 'Tab', 9, undefined, 2)
  await waitFor(`document.querySelector('.document-tablist [aria-selected="true"]').textContent.trim() === 'Conversation'`)
  await nativeKey('Tab', 'Tab', 9)
  await nativeKey('Tab', 'Tab', 9, undefined, 8)
  assert.equal(await evaluate(`document.querySelector('.document-tablist [aria-selected="true"]').textContent.trim()`), 'Conversation', 'Plain Tab and Shift+Tab only move focus')
  await click('.composer-controls [aria-label="Choose model"]')
  await waitFor(`Boolean(document.querySelector('.composer-popover'))`)
  await nativeKey('Tab', 'Tab', 9, undefined, 2)
  assert.equal(await evaluate(`document.querySelector('.document-tablist [aria-selected="true"]').textContent.trim()`), 'Conversation', 'Ctrl+Tab must not switch documents beneath an open dialog')
  await nativeKey('Escape', 'Escape', 27)
  await click('.document-tablist [aria-label="src/main.ts"]')
  await evaluate(`document.querySelector('.document-tablist [aria-label="src/main.ts"]').focus()`)
  await nativeKey('Home', 'Home', 36)
  await waitFor(`document.querySelector('.document-tablist [aria-selected="true"]').textContent.trim() === 'Conversation'`)
  assert.equal(await evaluate(`document.querySelector('.composer-input textarea') === window.documentInput && window.documentInput.value === '\\u4f60' && document.querySelector('.chat-bubble') === window.documentMessage && document.querySelector('.chat-messages').scrollTop === window.documentScroll`), true, 'Returning to Conversation preserves input DOM, draft, message DOM and scroll')
  await nativeKey('End', 'End', 35)
  assert.equal(await evaluate(`document.activeElement.getAttribute('aria-label')`), 'src/main.ts')
  await nativeKey('ArrowLeft', 'ArrowLeft', 37)
  assert.equal(await evaluate(`document.activeElement.getAttribute('aria-label')`), 'README.md')
  await nativeKey('ArrowRight', 'ArrowRight', 39)
  await nativeKey('Delete', 'Delete', 46)
  assert.equal(await evaluate(`document.activeElement.getAttribute('aria-label')`), 'README.md', 'Deleting the last file selects its previous neighbour')
  assert.equal(await evaluate(`document.querySelectorAll('.document-tablist [role="tab"][tabindex="0"]').length`), 1)
  await writeFile(join(directory, 'workbench-desktop.png'), (await window.webContents.capturePage()).toPNG())
  assert.equal(chatHistoryRequests.length, historyBeforeDocuments, 'Explorer and document changes must not reload conversation history')
  await selectSession(idB)
  await waitFor(`document.querySelector('.chat-messages')?.textContent.includes('Only the second session')`)
  assert.equal(await evaluate(`document.querySelectorAll('.document-tablist [role="tab"]').length`), 2, 'Another session starts with its two fixed views')
  assert.equal(await evaluate(`document.querySelectorAll('.file-document .file-modal').length`), 0, 'Inactive sessions must not keep mounted file previews')
  await selectSession(idA)
  await waitFor(`document.querySelector('.document-tablist [aria-label="README.md"]')?.getAttribute('aria-selected') === 'true' && document.querySelector('.file-markdown h1')?.textContent === 'README.md'`)
  assert.equal(await evaluate(`document.querySelectorAll('.document-tablist [role="tab"]').length`), 3, 'Returning to a session restores its open documents and selected file')
  await click('.document-tablist [aria-label="Close README.md"]')
  assert.equal(await evaluate(`document.activeElement.textContent.trim()`), 'Conversation', 'Closing the final file returns to Conversation')
  await click('.tree-row[data-path="preview.html"]')
  await waitFor(`Boolean(document.querySelector('.file-document iframe'))`)
  const frameDeadline = Date.now() + 12000
  while (!window.webContents.mainFrame.frames.some(frame => frame.url.endsWith('/static/preview.html')) && Date.now() < frameDeadline) await new Promise(resolve => setTimeout(resolve, 40))
  const previewFrame = window.webContents.mainFrame.frames.find(frame => frame.url.endsWith('/static/preview.html'))
  assert.ok(previewFrame, 'Synthetic HTML preview must load in its sandboxed frame')
  await previewFrame.executeJavaScript('document.querySelector("input").focus()')
  await waitFor(`document.activeElement === document.querySelector('.file-document iframe')`)
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab', modifiers: ['control'] })
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab', modifiers: ['control'] })
  await waitFor(`document.querySelector('.document-tablist [aria-selected="true"]').textContent.trim() === 'Conversation'`)
  await nativeKey('Tab', 'Tab', 9, undefined, 10)
  await waitFor(`document.querySelector('.document-tablist [aria-label="preview.html"]').getAttribute('aria-selected') === 'true'`)
  assert.equal(await evaluate(`document.querySelector('.file-document iframe').sandbox.contains('allow-same-origin')`), false, 'HTML selection must not relax the preview sandbox')
  await evaluate(`Array.from(document.querySelectorAll('.file-modal-actions button')).find(button => button.textContent.trim() === 'Source').click()`)
  await waitFor(`document.querySelector('.file-modal-text')?.textContent.includes('Preserved iframe text') && !document.querySelector('.file-document iframe')`)
  await prepareComposer('')
  const htmlStart = htmlPreviewSource.indexOf('<input')
  const htmlEnd = htmlPreviewSource.indexOf('\n', htmlStart)
  const htmlSelectedText = await selectFileText('.file-modal-text', htmlStart, htmlEnd)
  await click('.selection-menu button:first-of-type')
  await waitFor(`!document.querySelector('.selection-menu')`)
  assert.equal(await evaluate(`document.querySelector('.composer-input textarea').value`), `> File: preview.html\n> Lines: 4\n> \n> ${htmlSelectedText}\n\n`, 'HTML Source quotes literal source with line context without executing it')
  assert.equal(await evaluate(`document.querySelector('.document-tablist [aria-selected="true"]').getAttribute('aria-label')`), 'preview.html')
  await prepareComposer('\u4f60')
  await click('.document-tablist [aria-label="Close preview.html"]')
  await click('.tree-row[data-path="settings.arbitrary-suffix"]')
  await waitFor(`document.querySelector('.file-modal-text')?.textContent.includes('middle two')`)
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('.file-modal-text .file-syntax-token')).every(token => !token.style.getPropertyValue('--file-token-light') && !token.style.getPropertyValue('--file-token-dark'))`), true, 'Unknown suffixes remain uncolored plaintext')
  await prepareComposer('prefix suffix', 7)
  await evaluate(`(() => {
    window.fileComposer = document.querySelector('.composer-input textarea');
    window.fileControls = document.querySelector('.composer-controls').textContent;
    const transfer = new DataTransfer();
    transfer.items.add(new File(['Synthetic pending context'], 'context.txt', { type: 'text/plain' }));
    const picker = document.querySelector('.composer-file-input');
    picker.files = transfer.files; picker.dispatchEvent(new Event('change', { bubbles: true }));
  })()`)
  await waitFor(`document.querySelector('[aria-label="Remove context.txt"]')`)
  const excerptOffsets = await evaluate<{ start: number; end: number }>(`(() => {
    const text = document.querySelector('.file-modal-text').textContent;
    return { start: text.lastIndexOf('repeat excerpt') - 2, end: text.indexOf('final') };
  })()`)
  const requestsBeforeFileQuote = { files: fileRequests.length, previews: previewRequests.length, history: chatHistoryRequests.length, sends: sentMessages.length }
  const selectedFileText = await selectFileText('.file-modal-text', excerptOffsets.start, excerptOffsets.end)
  assert.equal(selectedFileText.replace(/\r\n/g, '\n'), '  repeat excerpt\n    middle two\n')
  assert.equal(await evaluate(`window.fileComposer.value`), 'prefix suffix', 'Selecting file text must not mutate the draft')
  await nativeKey('q', 'KeyQ', 81, 'q')
  const fileQuote = `File: settings.arbitrary-suffix\nLines: 4-5\n\n${selectedFileText}`
  const quotedDraft = `prefix \n\n${fileQuote.split(/\r?\n/).map(line => `> ${line}`).join('\n')}\n\nsuffix`
  await waitFor(`document.activeElement === window.fileComposer && !document.querySelector('.selection-menu')`)
  assert.equal(await evaluate(`window.fileComposer.value`), quotedDraft, 'File quotes use the selected occurrence and exclude a next-line-only ending from CRLF source line numbers')
  assert.equal(await evaluate(`document.querySelector('.document-tablist [aria-selected="true"]').getAttribute('aria-label')`), 'settings.arbitrary-suffix', 'Quoting keeps the file document open')
  assert.deepEqual({ files: fileRequests.length, previews: previewRequests.length, history: chatHistoryRequests.length, sends: sentMessages.length }, requestsBeforeFileQuote, 'Quoting a loaded file creates no requests or sends')
  await selectFileText('.file-modal-text', excerptOffsets.start, excerptOffsets.end)
  await assertFileComposer()
  await captureSelectionMenu('file-selection-desktop.png', false, true)
  await nativeKey('c', 'KeyC', 67, 'c')
  await waitFor(`!document.querySelector('.selection-menu')`)
  assert.equal(await evaluate(`window.copiedSelections.at(-1)`), selectedFileText, 'File Copy contains only selected text, without path or source line metadata')
  const pasteSideEffects = { uploads: uploadAttempts, sends: sentMessages.length, sessions: extraSessions.length, history: chatHistoryRequests.length }
  assert.equal(await pasteFixture({ images: ['first.png', 'second.png'] }), true, 'Pure image paste prevents the native default')
  await waitFor(`document.querySelectorAll('.attachment-thumb').length === 2 && Array.from(document.querySelectorAll('.attachment-thumb')).every(image => image.naturalWidth === 1 && image.src.startsWith('blob:'))`)
  const pastedUrls = await evaluate<string[]>(`Array.from(document.querySelectorAll('.attachment-thumb'), image => image.src)`)
  assert.equal(await pasteFixture({ images: ['first.png', 'second.png'] }), true)
  assert.equal(await evaluate(`document.querySelectorAll('.attachment-thumb').length`), 2, 'The files/items views and repeated paste must not duplicate images')
  await click('[aria-label="Remove first.png"]')
  await click('[aria-label="Remove second.png"]')
  assert.equal(await evaluate(`${JSON.stringify(pastedUrls)}.every(url => window.revokedPasteUrls.includes(url))`), true, 'Removing pasted images revokes their blob URLs')
  assert.equal(await pasteFixture({ images: ['mixed.png'], text: 'Native text remains available' }), false, 'Mixed text/image paste leaves native text insertion and undo unprevented')
  await waitFor(`document.querySelector('.attachment-thumb')?.naturalWidth === 1`)
  assert.equal(await evaluate(`window.fileComposer.value`), quotedDraft, 'An untrusted synthetic mixed paste must not emulate or duplicate native text insertion')
  await click('[aria-label="Remove mixed.png"]')
  assert.equal(await pasteFixture({ text: 'Plain clipboard text' }), false)
  assert.equal(await pasteFixture({ nonImage: true }), false)
  assert.equal(await pasteFixture({ noData: true }), false)
  assert.equal(await evaluate(`document.querySelectorAll('.attachment-thumb').length`), 0)
  assert.equal(await pasteFixture({ unavailable: true }), true)
  await waitFor(`document.querySelector('.composer-error')?.textContent.includes('Could not read the clipboard image')`)
  assert.equal(await pasteFixture({ images: ['fallback.png'], fallback: true }), true)
  await waitFor(`document.querySelector('.attachment-thumb')?.naturalWidth === 1 && !document.querySelector('.composer-error')`)
  await click('[aria-label="Remove fallback.png"]')
  assert.equal(await pasteFixture({ images: ['red.png'] }), true)
  await waitFor(`document.querySelector('.attachment-thumb')?.naturalWidth === 1`)
  assert.deepEqual({ uploads: uploadAttempts, sends: sentMessages.length, sessions: extraSessions.length, history: chatHistoryRequests.length }, pasteSideEffects, 'Pasting images must remain entirely local until Send')
  if (!await evaluate(`Boolean(document.querySelector('.tree-row[data-path="src/main.ts"]'))`)) await click('.tree-row[data-path="src"]')
  await waitFor(`document.querySelector('.tree-row[data-path="src/main.ts"]')`)
  await click('.tree-row[data-path="src/main.ts"]')
  await waitFor(`Array.from(document.querySelectorAll('.file-modal-text')).some(node => node.getClientRects().length && node.textContent === ${JSON.stringify(typescriptPreviewSource)})`)
  await waitFor(`Array.from(document.querySelectorAll('.file-modal-text .file-syntax-token')).some(token => token.getClientRects().length && token.style.getPropertyValue('--file-token-light'))`)
  await assertFileComposer()
  await assertFileEndAboveOverlay()
  await new Promise(resolve => setTimeout(resolve, 200))
  await writeFile(join(directory, 'file-overlay-desktop.png'), (await window.webContents.capturePage()).toPNG())
  await click('.document-tablist [aria-label="settings.arbitrary-suffix"]')
  await evaluate(`window.fileComposer.setSelectionRange(3, 3)`)
  await click('.document-tablist [role="tab"]')
  assert.equal(await evaluate(`document.querySelector('.composer-input textarea') === window.fileComposer && window.fileComposer.value === ${JSON.stringify(quotedDraft)} && window.fileComposer.selectionStart === 3 && !!document.querySelector('[aria-label="Remove context.txt"]') && document.querySelector('.attachment-thumb')?.naturalWidth === 1 && document.querySelector('.composer-controls').textContent === window.fileControls`), true, 'Conversation and file share the input node, caret, draft, pending/pasted attachments, model and reasoning controls')
  await click('.document-tablist [aria-label="settings.arbitrary-suffix"]')
  await selectFileText('.file-modal-text', excerptOffsets.start, excerptOffsets.end)
  await click('.document-tablist [role="tab"]')
  await waitFor(`!document.querySelector('.selection-menu')`)
  await click('.document-tablist [aria-label="settings.arbitrary-suffix"]')
  if (await evaluate(`document.querySelector('.workbench-explorer').getClientRects().length > 0`)) await click('[aria-label="Collapse files"]')
  window.webContents.enableDeviceEmulation({ screenPosition: 'desktop', screenSize: { width: 390, height: 844 }, viewPosition: { x: 0, y: 0 }, viewSize: { width: 390, height: 844 }, deviceScaleFactor: 1, scale: 1 })
  await waitFor(`innerWidth === 390`)
  await new Promise(resolve => setTimeout(resolve, 150))
  await selectFileText('.file-modal-text', excerptOffsets.start, excerptOffsets.end)
  await assertFileComposer()
  await captureSelectionMenu('file-selection-mobile.png', true, true)
  await nativeKey('c', 'KeyC', 67, 'c')
  await waitFor(`!document.querySelector('.selection-menu')`)
  await click('.document-tablist [aria-label="src/main.ts"]')
  await waitFor(`document.querySelector('.document-tablist [aria-label="src/main.ts"]').getAttribute('aria-selected') === 'true'`)
  await assertFileEndAboveOverlay()
  await new Promise(resolve => setTimeout(resolve, 200))
  await writeFile(join(directory, 'file-overlay-mobile.png'), (await window.webContents.capturePage({ x: 0, y: 0, width: 390, height: 844 })).toPNG())
  await click('.document-tablist [aria-label="Close src/main.ts"]')
  await click('.document-tablist [aria-label="Close settings.arbitrary-suffix"]')
  await waitFor(`!document.querySelector('.selection-menu')`)
  assert.equal(await evaluate(`document.querySelector('.composer-input textarea') === window.fileComposer`), true, 'Closing a file never remounts the composer')
  window.webContents.disableDeviceEmulation()
  await waitFor(`innerWidth > 1280`)
  await click('[aria-label="Remove context.txt"]')
  await click('[aria-label="Remove red.png"]')
  await prepareComposer('\u4f60')
  await click('.explorer-toggle')
  await waitFor(`document.querySelector('.file-workbench.explorer-docked')`)
  await click('.tree-row[data-path="README.md"]')
  await waitFor(`document.querySelector('.file-markdown strong')?.textContent === 'rendered'`)
  const markdownQuoteText = await selectFileText('.file-markdown strong')
  await click('.selection-menu button:first-of-type')
  await waitFor(`!document.querySelector('.selection-menu')`)
  assert.equal(await evaluate(`window.fileComposer.value`), `\u4f60\n\n> File: README.md\n> Lines: 3 (source block)\n> \n> ${markdownQuoteText}\n\n`, 'Rendered Markdown quotes point back to the source block rather than rendered DOM line breaks')
  await click('.document-tablist [aria-label="Close README.md"]')
  await prepareComposer('\u4f60')
  for (const name of ['.node-version', 'settings.arbitrary-suffix', 'binary.unknown']) {
    await click(`.tree-row[data-path="${name}"]`)
    if (name === 'binary.unknown') await waitFor(`Array.from(document.querySelectorAll('.file-modal-note')).some(node => node.getClientRects().length && node.textContent.includes('binary data'))`)
    else await waitFor(`Array.from(document.querySelectorAll('.file-modal-text')).some(node => node.getClientRects().length && node.textContent.includes(${JSON.stringify(name)}))`)
    if (name === '.node-version') await assertFileEndAboveOverlay()
  }
  await click('.document-tablist [role="tab"]')
  await evaluate(`document.querySelector('.document-tabs').style.maxWidth = '260px'; document.querySelector('.document-tabs').scrollLeft = 0; document.querySelector('textarea').focus()`)
  const pinnedBounds = await evaluate(`document.querySelector('.conversation-tab').getBoundingClientRect().toJSON()`)
  const wheelPoint = await evaluate<{ x: number; y: number }>(`(() => { const rect = document.querySelector('.conversation-tab').getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; })()`)
  await keyboard.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', ...wheelPoint, deltaX: 0, deltaY: 180 })
  await waitFor(`document.querySelector('.document-tabs').scrollLeft > 0`)
  assert.deepEqual(await evaluate(`document.querySelector('.conversation-tab').getBoundingClientRect().toJSON()`), pinnedBounds, 'Wheel over pinned Conversation scrolls only file tabs without moving Conversation')
  assert.equal(await evaluate(`(() => { const pinned = document.querySelector('.conversation-tab').getBoundingClientRect(); return pinned.left >= 0 && pinned.right <= innerWidth && !document.querySelector('.document-tabs .conversation-tab'); })()`), true)
  assert.equal(await evaluate(`document.querySelector('.document-tablist [aria-selected="true"]').textContent.trim()`), 'Conversation', 'Wheel scrolls document tabs horizontally without selecting')
  const middleClick = async (selector: string) => {
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: 'nearest', inline: 'nearest' })`)
    const point = await evaluate<{ x: number; y: number }>(`(() => { const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; })()`)
    await keyboard.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'middle', buttons: 4, clickCount: 1 })
    await keyboard.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'middle', buttons: 0, clickCount: 1 })
  }
  await middleClick('.document-tablist [aria-label="settings.arbitrary-suffix"]')
  await waitFor(`!document.querySelector('.document-tablist [aria-label="settings.arbitrary-suffix"]')`)
  assert.equal(await evaluate(`document.activeElement === document.querySelector('textarea')`), true, 'Middle-closing an inactive file must not steal composer focus')
  await middleClick('.document-tablist [role="tab"]')
  assert.equal(await evaluate(`document.querySelector('.document-tablist [role="tab"]').textContent.trim()`), 'Conversation', 'Conversation cannot be middle-closed')
  await click('.document-tablist [aria-label="binary.unknown"]')
  await middleClick('.document-tablist [aria-label="binary.unknown"]')
  await waitFor(`document.querySelector('.document-tablist [aria-label=".node-version"]').getAttribute('aria-selected') === 'true'`)
  await click('.document-tablist [aria-label="Close .node-version"]')
  await evaluate(`document.querySelector('.document-tabs').style.removeProperty('max-width')`)
  await click('[aria-label="Collapse files"]')
  window.webContents.enableDeviceEmulation({ screenPosition: 'desktop', screenSize: { width: 390, height: 844 }, viewPosition: { x: 0, y: 0 }, viewSize: { width: 390, height: 844 }, deviceScaleFactor: 1, scale: 1 })
  await waitFor(`innerWidth === 390`)
  await click('.explorer-toggle')
  await waitFor(`document.querySelector('.workbench-explorer.drawer')?.getClientRects().length > 0`)
  assert.equal(await evaluate(`(() => { const drawer = document.querySelector('.workbench-explorer').getBoundingClientRect(); return drawer.width >= 220 && drawer.right <= innerWidth && drawer.bottom <= innerHeight && !!document.querySelector('.explorer-backdrop'); })()`), true)
  assert.equal(await evaluate(`(() => {
    const drawer = document.querySelector('.workbench-explorer').getBoundingClientRect();
    const toolbar = document.querySelector('.document-toolbar').getBoundingClientRect();
    const backdrop = document.querySelector('.explorer-backdrop').getBoundingClientRect();
    return drawer.top >= toolbar.bottom - 1 && backdrop.top >= toolbar.bottom - 1;
  })()`), true, 'Mobile explorer and backdrop must start below the document toolbar, including the Folders offset')
  const mobileTogglePoint = await evaluate<{ x: number; y: number }>(`(() => {
    const toggle = document.querySelector('.explorer-toggle');
    const rect = toggle.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  })()`)
  assert.equal(await evaluate(`document.querySelector('.explorer-toggle').contains(document.elementFromPoint(${mobileTogglePoint.x}, ${mobileTogglePoint.y}))`), true, 'The open mobile drawer must not intercept hits on its toolbar toggle')
  await keyboard.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...mobileTogglePoint, button: 'left', buttons: 1, clickCount: 1 })
  await keyboard.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', ...mobileTogglePoint, button: 'left', buttons: 0, clickCount: 1 })
  await waitFor(`!document.querySelector('.workbench-explorer').getClientRects().length`)
  await click('.explorer-toggle')
  await waitFor(`document.querySelector('.workbench-explorer.drawer')?.getClientRects().length > 0`)
  await writeFile(join(directory, 'workbench-mobile.png'), (await window.webContents.capturePage({ x: 0, y: 0, width: 390, height: 844 })).toPNG())
  await click('[aria-label="Dismiss files"]')
  await waitFor(`!document.querySelector('.workbench-explorer').getClientRects().length`)
  await click('.explorer-toggle')
  await evaluate(`document.querySelector('.tree-row[data-path="README.md"]').focus()`)
  await nativeKey('Escape', 'Escape', 27)
  assert.equal(await evaluate(`document.activeElement.classList.contains('explorer-toggle') && !document.querySelector('.workbench-explorer').getClientRects().length`), true, 'Escape from a focused Files row closes the mobile drawer and restores Toggle files focus, even with its informational tooltip')
  await click('.explorer-toggle')
  await click('.tree-row[data-path="README.md"]')
  await waitFor(`document.querySelector('.file-markdown h1')?.textContent === 'README.md' && !document.querySelector('.workbench-explorer').getClientRects().length`)
  assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), true)
  await writeFile(join(directory, 'session-files-mobile.png'), (await window.webContents.capturePage({ x: 0, y: 0, width: 390, height: 844 })).toPNG())
  await click('.document-tablist [aria-label="Close README.md"]')
  assert.equal(await evaluate(`document.activeElement.textContent.trim()`), 'Conversation')
  window.webContents.disableDeviceEmulation()
  await waitFor(`innerWidth > 700`)
  await showSessionView(false)
  await evaluate(`(() => { const input = document.querySelector('.composer-input textarea'); window.retainedInput = input; input.value = 'Keep this unsent draft'; input.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('.chat-messages').scrollTop = 120; window.retainedScroll = document.querySelector('.chat-messages').scrollTop; })()`)
  await showSessionView(true)
  await waitFor(`document.querySelectorAll('.lane-bar.model').length === 2`)
  assert.equal(traceQueries.at(-1)?.searchParams.get('sessionId'), idA)
  assert.equal(traceQueries.at(-1)?.searchParams.get('physicalSessionId'), 'physical-a')
  assert.equal(await evaluate(`document.querySelector('.composer-input textarea').getClientRects().length`), 0)
  assert.equal(await evaluate(`Boolean(document.querySelector('.right-pane'))`), false)
  await click('[aria-label="Zoom into trace"]')
  await waitFor(`Boolean(document.querySelector('[aria-label="Pan trace timeline"]'))`)
  await evaluate(`(() => { const slider = document.querySelector('[aria-label="Pan trace timeline"]'); slider.value = '100'; slider.dispatchEvent(new Event('input', { bubbles: true })); })()`)
  await evaluate(`Array.from(document.querySelectorAll('.timeline-controls button')).find(button => button.textContent === 'Reset').click()`)
  await waitFor(`!document.querySelector('[aria-label="Pan trace timeline"]')`)
  await evaluate(`Array.from(document.querySelectorAll('.event-fold-controls button')).find(button => button.textContent === 'Collapse turns').click()`)
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('.trace-event')).every(event => !event.getClientRects().length)`), true)
  await evaluate(`Array.from(document.querySelectorAll('.event-fold-controls button')).find(button => button.textContent === 'Expand turns').click()`)
  await evaluate(`Array.from(document.querySelectorAll('.event-fold-controls button')).find(button => button.textContent === 'Expand calls').click()`)
  await waitFor(`document.querySelector('.trace-event-detail')?.textContent.includes('Synthetic README result')`)
  await evaluate(`document.activeElement.blur()`)
  await nativeKey('a', 'KeyA', 65, 'a')
  await nativeKey('Backspace', 'Backspace', 8)
  assert.equal(await evaluate(`document.querySelector('.composer-input textarea').value`), 'Keep this unsent draft')
  keyboard.detach()
  await click('.lane-bar.tools')
  await waitFor(`document.querySelector('.span-inspector')?.textContent.includes('Synthetic README result')`)
  await evaluate(`(() => { const input = document.querySelector('[aria-label="Search session trace"]'); input.value = 'Vue'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
  await waitFor(`document.querySelectorAll('.trace-event').length === 3`)
  await click('#diagnosis-tools-tab')
  assert.equal(await evaluate(`document.querySelectorAll('#diagnosis-tools .tool-def').length`), 1)
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('#diagnosis-tools .rounded-md')).borderRadius`), '0px', 'UnoCSS cards must share square surface tokens')
  await click('#diagnosis-prompt-tab')
  assert.match(await evaluate<string>(`document.querySelector('#diagnosis-prompt').textContent`), /Synthetic system prompt/)
  assert.equal(await evaluate(`document.querySelectorAll('.system-prompt-content .katex math').length`), 2)
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('#diagnosis-prompt .i-lucide-copy')).maskImage.includes('data:image/svg+xml')`), true)
  await showSessionView(false)
  assert.equal(await evaluate(`document.querySelector('.composer-input textarea') === window.retainedInput`), true)
  assert.equal(await evaluate(`document.querySelector('.composer-input textarea').value`), 'Keep this unsent draft')
  assert.equal(await evaluate(`document.querySelector('.chat-messages').scrollTop === window.retainedScroll`), true)
  await showSessionView(true)
  await click('#diagnosis-trace-tab')
  await evaluate(`(() => { const input = document.querySelector('[aria-label="Search session trace"]'); input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
  live = true
  await waitFor(`!document.querySelector('.trace-heading button').disabled`)
  await click('.trace-heading button')
  await waitFor(`document.querySelectorAll('.lane-bar.running').length === 1`)
  live = false
  fail = true
  await waitFor(`!document.querySelector('.trace-heading button').disabled`)
  await click('.trace-heading button')
  await waitFor(`document.querySelector('.diagnosis-error')?.textContent.includes('503')`)
  fail = false
  await click('.trace-heading button')
  await waitFor(`!document.querySelector('.diagnosis-error') && document.querySelectorAll('.lane-bar.running').length === 0`)
  await click('.span-inspector [aria-label="Close span details"]')
  await evaluate(`document.querySelector('.diagnosis-scroll').scrollTop = 0`)
  await new Promise(resolve => setTimeout(resolve, 200))
  await writeFile(join(directory, 'diagnosis-desktop.png'), (await window.webContents.capturePage()).toPNG())
  const wideBounds = await evaluate<boolean>(`document.documentElement.scrollWidth <= innerWidth && document.querySelector('.session-diagnosis').getBoundingClientRect().bottom <= innerHeight`)
  assert.equal(wideBounds, true)
  window.webContents.enableDeviceEmulation({ screenPosition: 'desktop', screenSize: { width: 390, height: 844 }, viewPosition: { x: 0, y: 0 }, viewSize: { width: 390, height: 844 }, deviceScaleFactor: 1, scale: 1 })
  await new Promise(resolve => setTimeout(resolve, 200))
  assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth && document.querySelector('.trace-search').getBoundingClientRect().right <= innerWidth`), true)
  await writeFile(join(directory, 'diagnosis-mobile.png'), (await window.webContents.capturePage({ x: 0, y: 0, width: 390, height: 844 })).toPNG())
  window.webContents.disableDeviceEmulation()
  await showSessionView(false)
  await click('.segment-nav-btn')
  await waitFor(`document.querySelector('.chat-messages').textContent.includes('Historical segment only')`)
  await showSessionView(true)
  await waitFor(`document.querySelector('#diagnosis-trace').textContent.includes('Historical segment only') && document.querySelectorAll('.lane-bar.model').length === 0`)
  assert.equal(traceQueries.at(-1)?.searchParams.get('physicalSessionId'), 'physical-older')
  await showSessionView(false)
  await click('.segment-nav-btn')
  await waitFor(`document.querySelectorAll('.chat-bubble').length >= 4`)
  await showSessionView(true)
  await waitFor(`document.querySelectorAll('.lane-bar.model').length === 2`)
  gate = new Promise<void>(resolve => { release = resolve })
  const count = traceQueries.length
  await click('.trace-heading button')
  await waitFor(`document.querySelector('.trace-heading button').disabled`)
  while (traceQueries.length === count) await new Promise(resolve => setTimeout(resolve, 20))
  await selectSession(idB)
  release!()
  await waitFor(`document.querySelector('.chat-messages').textContent.includes('Only the second session')`)
  assert.equal(await evaluate(`document.querySelector('.chat-user .message-time').textContent`), 'Time unavailable')
  await showSessionView(true)
  await waitFor(`document.querySelector('#diagnosis-trace').textContent.includes('Only the second session')`)
  assert.equal(await evaluate(`document.querySelectorAll('.lane-bar.model').length`), 0)
  assert.equal(await evaluate(`document.querySelector('#diagnosis-trace').textContent.includes('Synthetic README result')`), false)
  await showSessionView(false)
  const send = async (text: string) => {
    await evaluate(`(() => { const input = document.querySelector('.composer-input textarea'); input.value = ${JSON.stringify(text)}; input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
    await click('.composer-send')
  }
  await send('Timestamp input')
  await waitFor(`document.querySelector('.chat-assistant:last-child')?.textContent.includes('A streamed response')`)
  assert.equal(await pasteFixture({ images: ['blocked.png'] }), true)
  assert.equal(await evaluate(`document.querySelectorAll('.attachment-thumb').length`), 0, 'Image paste cannot queue attachments while sending is disabled')
  assert.equal(await evaluate(`document.querySelectorAll('.chat-role, .chat-sender').length`), 0, 'Streaming must not restore role labels')
  const partialTime = await evaluate<string>(`document.querySelector('.chat-assistant:last-child .message-time').dateTime`)
  assert.ok(Number.isFinite(Date.parse(partialTime)))
  assert.ok(await evaluate(`Array.from(document.querySelectorAll('.chat-user')).at(-1).querySelector('.message-time').dateTime.length > 0`))
  assert.ok(emitStreamEdit)
  emitStreamEdit(false)
  await waitFor(`document.querySelector('.tool-activity-summary')?.textContent.includes('Edit streamed.ts')`)
  assert.equal(await evaluate(`Boolean(document.querySelector('.tool-activity-summary .line-changes'))`), false, 'Pending writes must not predict line counts')
  await click('.tool-activity-summary')
  await evaluate(`window.streamActivity = document.querySelector('.tool-activity')`)
  emitStreamEdit(true)
  await waitFor(`document.querySelector('.tool-activity-summary .lines-added')?.textContent === '+2'`)
  assert.equal(await evaluate(`document.querySelector('.tool-activity-summary .lines-removed').textContent`), '-1')
  assert.equal(await evaluate(`window.streamActivity === document.querySelector('.tool-activity') && window.streamActivity.open`), true, 'Streaming result updates must preserve expansion and DOM identity')
  assert.ok(completeSend)
  completeSend()
  await waitFor(`document.querySelector('.chat-messages').textContent.includes('Final timestamped response') && !document.querySelector('.composer-input textarea').disabled`)
  assert.equal(await evaluate(`document.querySelectorAll('.tool-activity').length`), 1)
  assert.equal(await evaluate(`document.querySelector('.tool-activity-summary .lines-added').textContent`), '+2', 'Committing streaming tools must not duplicate counts')
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('.chat-assistant')).find(bubble => bubble.textContent.includes('A streamed response')).querySelector('.message-time').dateTime`), partialTime)
  assert.ok(await evaluate(`Array.from(document.querySelectorAll('.chat-assistant .message-time')).every(time => Number.isFinite(Date.parse(time.dateTime)))`))
  await send('Interrupted timestamp')
  await waitFor(`Array.from(document.querySelectorAll('.chat-assistant')).filter(bubble => bubble.textContent.includes('A streamed response')).length === 2 && !document.querySelector('.composer-input textarea').disabled`)
  await send('Failed timestamp')
  await waitFor(`document.querySelector('.chat-messages').textContent.includes('Error:') && !document.querySelector('.composer-input textarea').disabled`)
  assert.ok(realtime.hub.stats.clients > 0)
  realtime.chat(idB, { event: 'response', content: 'Background timestamped reply.', done: true })
  realtime.finish(idB)
  await waitFor(`document.querySelector('.chat-messages').textContent.includes('Background timestamped reply')`)
  assert.ok(await evaluate(`Array.from(document.querySelectorAll('.chat-assistant .message-time')).every(time => Number.isFinite(Date.parse(time.dateTime)))`))
  await new Promise(resolve => setTimeout(resolve, 150))
  await writeFile(join(directory, 'bubble-timestamps.png'), (await window.webContents.capturePage()).toPNG())
  await selectSession(idGroup)
  await waitFor(`document.querySelectorAll('.chat-sender').length === 2`)
  assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('.chat-sender'), node => node.textContent)`), ['Alice', 'Bob & the <frontend> team'])
  assert.equal(await evaluate(`document.querySelectorAll('.chat-role, .chat-assistant .chat-sender, .chat-sender frontend').length`), 0)
  assert.equal(await evaluate(`document.querySelectorAll('.chat-footer .usage-badge').length`), 3)
  assert.equal(await evaluate(`document.querySelectorAll('.chat-bubble .message-time').length`), 4)
  if (!await evaluate(`document.querySelector('.workbench-explorer').getClientRects().length > 0`)) await click('.explorer-toggle')
  await waitFor(`document.querySelector('.tree-row[data-path=".node-version"]')`)
  await click('.tree-row[data-path=".node-version"]')
  await waitFor(`document.querySelector('.file-modal-text')?.textContent.includes('.node-version')`)
  const readonlyFileText = await selectFileText('.file-modal-text')
  assert.equal(await evaluate(`!document.querySelector('.composer-input textarea') && document.querySelector('.selection-menu button:first-of-type').disabled`), true, 'Read-only file previews offer Copy without creating a composer or enabling Quote')
  await click('.selection-menu button:last-of-type')
  await waitFor(`!document.querySelector('.selection-menu')`)
  assert.equal(await evaluate(`window.copiedSelections.at(-1)`), readonlyFileText)
  await click('.document-tablist [aria-label="Close .node-version"]')
  await click('.tool-activity-summary')
  await click('.tool-call-header')
  await click('.tool-result-header')
  await click('.event-header')
  await waitFor(`Boolean(document.querySelector('.tool-call-detail')) && Boolean(document.querySelector('.system-event-body'))`)
  await evaluate(`document.querySelector('.chat-messages').scrollTop = 0; document.documentElement.classList.add('dark')`)
  await new Promise(resolve => setTimeout(resolve, 150))
  await writeFile(join(directory, 'rounded-chat-desktop.png'), (await window.webContents.capturePage()).toPNG())
  await evaluate(`document.documentElement.classList.remove('dark')`)
  await new Promise(resolve => setTimeout(resolve, 150))
  await writeFile(join(directory, 'rounded-chat-light.png'), (await window.webContents.capturePage()).toPNG())
  await evaluate(`document.documentElement.classList.add('dark')`)
  window.webContents.enableDeviceEmulation({ screenPosition: 'desktop', screenSize: { width: 390, height: 844 }, viewPosition: { x: 0, y: 0 }, viewSize: { width: 390, height: 844 }, deviceScaleFactor: 1, scale: 1 })
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth && Array.from(document.querySelectorAll('.chat-bubble, .tool-group, .system-event')).every(node => node.getBoundingClientRect().right <= innerWidth)`), true)
  await writeFile(join(directory, 'rounded-chat-mobile.png'), (await window.webContents.capturePage({ x: 0, y: 0, width: 390, height: 844 })).toPNG())
  window.webContents.disableDeviceEmulation()
  await waitFor(`innerWidth > 700`)
  await new Promise(resolve => setTimeout(resolve, 150))
  const selectConversation = async (id: string) => {
    await selectSession(id)
  }
  await selectConversation(idA)
  await waitFor(`document.querySelector('.primary-conversation .heading-name').textContent === 'Trace preview' && document.querySelectorAll('.chat-bubble').length >= 4`)
  if (!await evaluate(`document.querySelector('.primary-conversation .workbench-explorer').getClientRects().length > 0`)) await click('.primary-conversation .explorer-toggle')
  await waitFor(`document.querySelector('.primary-conversation .tree-row[data-path="README.md"]')`)
  await click('.primary-conversation .tree-row[data-path="README.md"]')
  await waitFor(`document.querySelector('.primary-conversation .file-markdown h1')`)
  await click('.primary-conversation .document-tablist [role="tab"]')
  await click('.primary-conversation [aria-label="Collapse files"]')
  await evaluate(`(() => {
    const input = document.querySelector('.primary-conversation textarea');
    input.value = 'Keep main draft'; input.dispatchEvent(new Event('input', { bubbles: true }));
    window.splitParentInput = input;
    document.querySelector('.primary-conversation .chat-messages').scrollTop = 80;
  })()`)
  await selectConversation(idChild)
  await waitFor(`document.querySelector('.child-conversation .chat-messages')?.textContent.includes('This response belongs only to the child')`)
  assert.equal(await evaluate(`document.querySelector('.primary-conversation textarea') === window.splitParentInput && window.splitParentInput.value === 'Keep main draft'`), true)
  assert.equal(await evaluate(`document.querySelector('.primary-conversation .chat-messages').scrollTop < 500`), true, 'Opening a child must not scroll the parent to the bottom')
  assert.equal(await evaluate(`document.querySelector('.conversation-workspace').classList.contains('is-split') && document.querySelectorAll('.folders-sidebar').length === 1`), true)
  assert.equal(await evaluate(`new URLSearchParams(location.search).get('child')`), idChild)
  keyboard.attach('1.3')
  await evaluate(`document.querySelector('.child-conversation textarea').focus()`)
  await nativeKey('Tab', 'Tab', 9, undefined, 2)
  await nativeKey('Tab', 'Tab', 9, undefined, 10)
  assert.equal(await evaluate(`document.querySelector('.primary-conversation .document-tablist [aria-selected="true"]').textContent.trim()`), 'Conversation', 'Cycling a side chat between its fixed views must not change the inactive main pane')
  await evaluate(`(() => { const input = document.querySelector('.child-conversation textarea'); input.focus(); input.value = 'Keep child draft'; input.dispatchEvent(new Event('input', { bubbles: true })); input.setSelectionRange(input.value.length, input.value.length); input.blur(); })()`)
  await nativeKey('a', 'KeyA', 65, 'a')
  assert.equal(await evaluate(`document.querySelector('.child-conversation textarea').value`), 'Keep child drafta')
  assert.equal(await evaluate(`window.splitParentInput.value`), 'Keep main draft')
  await evaluate(`document.activeElement.blur(); document.querySelector('.primary-conversation .chat-messages').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))`)
  await nativeKey('Backspace', 'Backspace', 8)
  assert.equal(await evaluate(`window.splitParentInput.value`), 'Keep main draf')
  assert.equal(await evaluate(`document.querySelector('.child-conversation textarea').value`), 'Keep child drafta')
  await selectMessage('.child-conversation')
  assert.equal(await evaluate(`document.querySelectorAll('.selection-menu').length`), 1, 'Only the active child owns the selection menu')
  await nativeKey('q', 'KeyQ', 81, 'q')
  await waitFor(`document.querySelector('.child-conversation textarea').value.includes('> This response belongs only to the child.')`)
  assert.equal(await evaluate(`window.splitParentInput.value`), 'Keep main draf', 'Child quote must never mutate the main composer')
  await evaluate(`(() => { const input = document.querySelector('.child-conversation textarea'); input.value = 'Keep child drafta'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
  const divider = await evaluate<{ x: number; y: number }>(`(() => { const rect = document.querySelector('.conversation-resizer').getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + 120 }; })()`)
  const beforeResize = await evaluate<number>(`document.querySelector('.child-conversation').getBoundingClientRect().width`)
  await keyboard.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...divider, button: 'left', buttons: 1, clickCount: 1 })
  await keyboard.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: divider.x - 90, y: divider.y, button: 'left', buttons: 1 })
  await keyboard.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: divider.x - 90, y: divider.y, button: 'left', buttons: 0, clickCount: 1 })
  assert.equal(await evaluate(`document.querySelector('.child-conversation').getBoundingClientRect().width >= ${beforeResize + 80} && !document.querySelector('.is-resizing')`), true)
  await evaluate(`document.querySelector('.conversation-resizer').focus()`)
  await nativeKey('Home', 'Home', 36)
  assert.equal(await evaluate(`document.querySelector('.conversation-resizer').getAttribute('aria-valuenow')`), '360')
  await nativeKey('End', 'End', 35)
  assert.equal(await evaluate(`document.querySelector('.conversation-resizer').getAttribute('aria-valuenow') === document.querySelector('.conversation-resizer').getAttribute('aria-valuemax')`), true)
  await nativeKey('ArrowRight', 'ArrowRight', 39)
  assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth && document.querySelector('.primary-conversation .chat-panel').getBoundingClientRect().width >= 480`), true)
  for (const side of ['primary', 'child']) {
    await evaluate(`document.querySelector('.${side}-conversation .chat-messages').scrollTop = document.querySelector('.${side}-conversation .chat-messages').scrollHeight`)
    await waitFor(`(() => {
      const pane = document.querySelector('.${side}-conversation .chat-panel'), scroll = pane.querySelector('.chat-messages'), dock = document.querySelector('.${side}-conversation .conversation-dock');
      return Math.abs(scroll.getBoundingClientRect().bottom - pane.getBoundingClientRect().bottom) < 2 && parseFloat(getComputedStyle(scroll).paddingBottom) >= dock.getBoundingClientRect().height;
    })()`)
    assert.equal(await evaluate(`(() => { const pane = document.querySelector('.${side}-conversation'); const last = Array.from(pane.querySelectorAll('.chat-bubble')).at(-1); return last.getBoundingClientRect().bottom <= pane.querySelector('.composer-box').getBoundingClientRect().top; })()`), true, 'The final bubble must remain above the overlay at scroll end')
  }
  const beforeGrow = await evaluate<number>(`document.querySelector('.child-conversation .conversation-dock').getBoundingClientRect().height`)
  await evaluate(`(() => { const input = document.querySelector('.child-conversation textarea'); input.value = 'Wrapped draft\\n'.repeat(9); input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
  await waitFor(`document.querySelector('.child-conversation .conversation-dock').getBoundingClientRect().height > ${beforeGrow + 60}`)
  await waitFor(`(() => { const pane = document.querySelector('.child-conversation'); return parseFloat(getComputedStyle(pane.querySelector('.chat-messages')).paddingBottom) >= pane.querySelector('.conversation-dock').getBoundingClientRect().height && pane.querySelector('.message-history-rail').getBoundingClientRect().bottom < pane.querySelector('.composer-box').getBoundingClientRect().top; })()`)
  await evaluate(`(() => { const input = document.querySelector('.child-conversation textarea'); input.value = 'Keep child drafta'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
  await showSessionView(true, '.child-conversation')
  await waitFor(`document.querySelector('.child-conversation .trace-event')?.textContent.includes('child-only')`)
  await showSessionView(true)
  await waitFor(`document.querySelector('.primary-conversation .lane-bar.model')`)
  assert.equal(await evaluate(`(() => { const ids = Array.from(document.querySelectorAll('[id]'), node => node.id); return new Set(ids).size === ids.length; })()`), true, 'Parallel panes need independent tab, panel and SVG IDs')
  await showSessionView(false)
  assert.equal(await evaluate(`Boolean(document.querySelector('.child-conversation .workbench-explorer, .child-conversation .explorer-toggle, .child-conversation .explorer-backdrop, .child-conversation .file-tree'))`), false, 'Side chats must not mount a file tree or its controls')
  assert.equal(fileRequests.some(request => request.sessionId === idChild), false, 'Side chats must not fetch filesystem listings')
  assert.equal(await evaluate(`Boolean(document.querySelector('.primary-conversation .explorer-toggle'))`), true, 'Main conversation keeps its file explorer')
  assert.equal(await evaluate(`document.querySelector('.primary-conversation .diagnosis-tab [role="tab"]').getAttribute('aria-selected')`), 'false')
  assert.equal(await evaluate(`document.querySelector('.child-conversation [aria-label="Close child conversation"]').getClientRects().length > 0`), true, 'Child close action remains reachable without explorer controls')
  assert.equal(await evaluate(`(() => {
    const tabs = Array.from(document.querySelectorAll('.document-tablist [role="tab"]'));
    const ids = Array.from(document.querySelectorAll('[id]'), node => node.id);
    return new Set(ids).size === ids.length && tabs.every(tab => {
      const panel = document.getElementById(tab.getAttribute('aria-controls'));
      return panel && panel.getAttribute('aria-labelledby') === tab.id && panel.closest('.file-workbench') === tab.closest('.file-workbench');
    });
  })()`), true, 'Main and child document tabs have unique, correctly associated panel IDs')
  await click('.child-conversation .document-tablist [role="tab"]:first-child')
  await showSessionView(false, '.child-conversation')
  assert.equal(realtime.hub.stats.clients, 1, 'Main and child share one realtime transport')
  realtime.chat(idA, { content: 'Parent live response', done: false })
  realtime.chat(idChild, { content: 'Child live response', done: false })
  await waitFor(`document.querySelector('.primary-conversation .chat-working') && document.querySelector('.child-conversation .chat-working')`)
  assert.equal(await evaluate(`document.querySelector('.primary-conversation .chat-messages').textContent.includes('Child live response') || document.querySelector('.child-conversation .chat-messages').textContent.includes('Parent live response')`), false)
  await new Promise(resolve => setTimeout(resolve, 150))
  await writeFile(join(directory, 'parallel-conversations-desktop.png'), (await window.webContents.capturePage()).toPNG())
  realtime.chat(idA, { content: ' completed.', done: true })
  realtime.chat(idChild, { content: ' completed.', done: true })
  realtime.finish(idA)
  realtime.finish(idChild)
  await waitFor(`!document.querySelector('.primary-conversation textarea').disabled && !document.querySelector('.child-conversation textarea').disabled`)
  const savedWidth = await evaluate<string>(`document.querySelector('.conversation-resizer').getAttribute('aria-valuenow')`)
  window.webContents.enableDeviceEmulation({ screenPosition: 'desktop', screenSize: { width: 390, height: 844 }, viewPosition: { x: 0, y: 0 }, viewSize: { width: 390, height: 844 }, deviceScaleFactor: 1, scale: 1 })
  await waitFor(`!document.querySelector('.conversation-resizer') && !document.querySelector('.primary-conversation').getClientRects().length`)
  await nativeKey('Tab', 'Tab', 9, undefined, 2)
  assert.equal(await evaluate(`document.querySelector('.primary-conversation .document-tablist [aria-selected="true"]').textContent.trim()`), 'Conversation', 'Hidden main panes must ignore document shortcuts')
  assert.equal(await evaluate(`document.querySelector('.child-conversation textarea').value`), 'Keep child drafta')
  assert.equal(await evaluate(`Boolean(document.querySelector('.child-conversation .workbench-explorer, .child-conversation .explorer-toggle, .child-conversation .explorer-backdrop'))`), false, 'Narrow side chats must not expose a file drawer')
  assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth && document.querySelector('.child-conversation .composer-box').getBoundingClientRect().bottom <= innerHeight`), true)
  await writeFile(join(directory, 'parallel-conversations-mobile.png'), (await window.webContents.capturePage({ x: 0, y: 0, width: 390, height: 844 })).toPNG())
  window.webContents.disableDeviceEmulation()
  await waitFor(`Boolean(document.querySelector('.conversation-resizer'))`)
  assert.equal(await evaluate(`document.querySelector('.conversation-resizer').getAttribute('aria-valuenow')`), savedWidth)
  assert.equal(await evaluate(`document.querySelector('.primary-conversation textarea') === window.splitParentInput && window.splitParentInput.value === 'Keep main draf'`), true)
  agentWorking = true
  await selectConversation(idAgent)
  await waitFor(`document.querySelector('.child-conversation .chat-messages').textContent.includes('The agent is examining the files')`)
  assert.equal(await evaluate(`Boolean(document.querySelector('.child-conversation .workbench-explorer, .child-conversation .explorer-toggle'))`), false, 'Read-only subagent side chats do not expose files')
  assert.equal(await evaluate(`Boolean(document.querySelector('.child-conversation textarea'))`), false)
  const readonlySelection = await selectMessage('.child-conversation')
  assert.equal(await evaluate(`document.querySelector('.selection-menu [role="menuitem"]').disabled`), true, 'Read-only conversations disable Quote')
  await nativeKey('q', 'KeyQ', 81, 'q')
  assert.equal(await evaluate(`Boolean(document.querySelector('.selection-menu'))`), true)
  await nativeKey('c', 'KeyC', 67, 'c')
  await waitFor(`!document.querySelector('.selection-menu')`)
  assert.equal(await evaluate(`window.copiedSelections.at(-1)`), readonlySelection, 'Read-only conversations still allow Copy through the isolated stub')
  agentMessages.push({ role: 'assistant', content: 'Agent progress arrived without reopening the pane.' })
  await waitFor(`document.querySelector('.child-conversation .chat-messages').textContent.includes('Agent progress arrived')`)
  agentMessages.push({ role: 'assistant', content: 'Long agent history. '.repeat(250) })
  await waitFor(`document.querySelector('.child-conversation .chat-messages').textContent.includes('Long agent history')`)
  await evaluate(`document.querySelector('.child-conversation .chat-messages').scrollTop = 50`)
  agentMessages.push({ role: 'assistant', content: 'Agent final result.' })
  agentWorking = false
  await waitFor(`document.querySelector('.child-conversation .chat-messages').textContent.includes('Agent final result')`)
  assert.equal(await evaluate(`document.querySelector('.child-conversation .chat-messages').scrollTop`), 50, 'Agent refresh must preserve readers who scroll up')
  const agentRequestCount = agentHistoryRequests
  agentHistoryGate = new Promise(resolve => { releaseAgentHistory = resolve })
  while (agentHistoryRequests === agentRequestCount) await new Promise(resolve => setTimeout(resolve, 30))
  await selectConversation(idChild)
  releaseAgentHistory!()
  await waitFor(`document.querySelector('.child-conversation .chat-messages').textContent.includes('This response belongs only to the child')`)
  assert.equal(await evaluate(`document.querySelector('.child-conversation .chat-messages').textContent.includes('Agent progress arrived')`), false)
  assert.equal(fileRequests.some(request => request.sessionId === idChild || request.sessionId === idAgent), false, 'Switching side chats never fetches their filesystem')
  await click('[aria-label="Close child conversation"]')
  await waitFor(`!document.querySelector('.child-conversation')`)
  assert.equal(await evaluate(`document.querySelector('.primary-conversation textarea') === window.splitParentInput && window.splitParentInput.value === 'Keep main draf'`), true)
  keyboard.detach()
  await window.loadURL(`${origin}/chat/${encodeURIComponent(idA)}?child=${encodeURIComponent(idChild)}`)
  await waitFor(`document.querySelector('.child-conversation .chat-messages')?.textContent.includes('child-only') && document.querySelector('.primary-conversation .heading-name')?.textContent === 'Trace preview'`)
  keyboard.attach('1.3')
  await nativeKey('a', 'KeyA', 65, 'a')
  assert.equal(await evaluate(`document.querySelector('.child-conversation textarea').value`), 'a')
  assert.equal(await evaluate(`document.querySelector('.primary-conversation textarea').value`), '')
  keyboard.detach()
  await click('[aria-label="Close child conversation"]')
  await window.loadURL(`${origin}/chat/${encodeURIComponent(idA)}?child=web%3Achat-missing`)
  await waitFor(`document.querySelector('.child-conversation .composer-error')?.textContent.includes('unavailable')`)
  const beforeUnknownSend = sentMessages.length
  await evaluate(`(() => { const input = document.querySelector('.child-conversation textarea'); input.value = 'Do not create this missing session'; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); })()`)
  assert.equal(sentMessages.length, beforeUnknownSend)
  assert.equal(chatHistoryRequests.includes('chat-missing'), false, 'An unknown child URL must not materialize a session')
  await click('[aria-label="Close child conversation"]')
  await waitFor(`!document.querySelector('.child-conversation')`)
  await click('[aria-label="Add folder"]')
  await waitFor(`document.querySelectorAll('#folder-actions [role="menuitem"]').length === 3`)
  await evaluate(`Array.from(document.querySelectorAll('#folder-actions [role="menuitem"]')).find(node => node.textContent.includes('Start from scratch')).click()`)
  await waitFor(`Boolean(document.querySelector('.draft-heading'))`)
  const sessionsBeforeDraftExplorer = extraSessions.length
  const requestsBeforeDraftExplorer = fileRequests.length
  const historyBeforeDraftExplorer = chatHistoryRequests.length
  const sendsBeforeDraftExplorer = sentMessages.length
  if (!await evaluate(`document.querySelector('.workbench-explorer').getClientRects().length > 0`)) await click('.explorer-toggle')
  await waitFor(`document.querySelector('.file-tree-note')?.textContent.includes('select a conversation')`)
  assert.equal(await evaluate(`document.querySelector('.file-tree [aria-label="Refresh files"]').disabled && !document.querySelector('.file-tree input, .file-tree [aria-label*="Upload"], .file-tree [aria-label*="Create"]')`), true)
  await click('[aria-label="Collapse files"]')
  await click('.explorer-toggle')
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(extraSessions.length, sessionsBeforeDraftExplorer, 'Browsing the draft explorer must not create a session')
  assert.equal(fileRequests.length, requestsBeforeDraftExplorer, 'A draft must not request filesystem contents')
  assert.equal(chatHistoryRequests.length, historyBeforeDraftExplorer)
  assert.equal(sentMessages.length, sendsBeforeDraftExplorer)
  await click('[aria-label="Collapse files"]')
  const draftCount = traceQueries.length
  const detailsBeforeDraftSettings = detailsRequests
  const patchesBeforeDraftSettings = settingsPatches.length
  await chooseSetting('None')
  await chooseSetting('High')
  assert.equal(await evaluate(`document.querySelectorAll('.session-select').length`), 5)
  assert.equal(settingsPatches.length, patchesBeforeDraftSettings, 'Draft settings must not PATCH or create a session')
  await new Promise(resolve => setTimeout(resolve, 2200))
  assert.equal(detailsRequests, detailsBeforeDraftSettings, 'Draft settings must not fetch a session')
  assert.equal(traceQueries.length, draftCount, 'Unsent draft must not query or materialize diagnosis')
  assert.equal(await evaluate(`Boolean(document.querySelector('.session-diagnosis'))`), false)
  const attachImage = () => evaluate(`(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d');
    context.fillStyle = '#ff0000';
    context.fillRect(0, 0, 1, 1);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    const files = new DataTransfer();
    files.items.add(new File([blob], 'red.png', { type: 'image/png' }));
    const input = document.querySelector('.composer-file-input');
    input.files = files.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`)
  await attachImage()
  await waitFor(`document.querySelector('.attachment-thumb')?.naturalWidth === 1`)
  assert.equal(uploadAttempts, 0, 'Selecting an image must not upload or create a session')
  assert.equal(await evaluate(`document.querySelectorAll('.session-select').length`), 5)
  await click('[aria-label="Remove red.png"]')
  assert.equal(await evaluate(`Boolean(document.querySelector('.attachment-thumb'))`), false)
  await attachImage()
  await waitFor(`document.querySelector('.attachment-thumb')?.naturalWidth === 1`)
  await new Promise(resolve => setTimeout(resolve, 250))
  await writeFile(join(directory, 'image-draft-desktop.png'), (await window.webContents.capturePage()).toPNG())
  window.webContents.enableDeviceEmulation({ screenPosition: 'desktop', screenSize: { width: 390, height: 844 }, viewPosition: { x: 0, y: 0 }, viewSize: { width: 390, height: 844 }, deviceScaleFactor: 1, scale: 1 })
  await waitFor(`innerWidth === 390`)
  await new Promise(resolve => setTimeout(resolve, 250))
  assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth && document.querySelector('.composer-box').getBoundingClientRect().bottom <= innerHeight`), true)
  await writeFile(join(directory, 'image-draft-mobile.png'), (await window.webContents.capturePage({ x: 0, y: 0, width: 390, height: 844 })).toPNG())
  window.webContents.disableDeviceEmulation()
  await waitFor(`innerWidth > 1280`)
  failUpload = true
  const sendsBeforeUpload = sentMessages.length
  await evaluate(`document.querySelector('.composer-input textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))`)
  await waitFor(`document.querySelector('.composer-error')?.textContent.includes('Synthetic upload failure')`)
  assert.equal(sentMessages.length, sendsBeforeUpload)
  assert.equal(await evaluate(`Boolean(document.querySelector('.attachment-thumb'))`), true, 'Failed uploads must remain retryable in the composer')
  failUpload = false
  await evaluate(`document.querySelector('.composer-input textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))`)
  await waitFor(`document.querySelector('.chat-messages').textContent.includes('A streamed response')`)
  assert.equal(sentMessages.at(-1)?.content, '')
  assert.deepEqual(sentMessages.at(-1)?.media, [...uploadedImages.keys()])
  await waitFor(`document.querySelector('.chat-user img')?.naturalWidth === 1`)
  assert.equal(await evaluate(`Boolean(document.querySelector('.attachment-thumb'))`), false)
  assert.deepEqual(sentMessages.at(-1)?.config, { thinking: { type: 'enabled' }, reasoningEffort: 'high' })
  assert.ok(completeSend)
  completeSend()
  await waitFor(`!document.querySelector('.composer-input textarea').disabled`)
  await waitFor(`document.querySelector('.chat-user img')?.src.startsWith('data:image/png;') && document.querySelector('.chat-user img').naturalWidth === 1`)
  inventoryGate = new Promise(resolve => { releaseInventory = resolve })
  await window.loadURL(`${origin}/workspaces`)
  await waitFor(`document.querySelector('.inventory-status')?.textContent.includes('Loading devices')`)
  assert.equal(await evaluate(`document.querySelectorAll('.node-admin-row').length`), 0)
  releaseInventory!()
  await waitFor(`location.pathname === '/nodes' && document.querySelectorAll('.node-admin-row').length === 3`)
  assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('.tab-nav [aria-current="page"]'), node => node.textContent.trim())`), ['Nodes'])
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('.tab-nav .tab')).some(node => node.textContent.trim() === 'Workspaces')`), false)
  assert.equal(await evaluate(`Boolean(document.querySelector('.fixture-notice'))`), false)
  assert.equal(await evaluate(`document.querySelector('.capability-overview').textContent`), 'Workdir (1) · Shell (1)')
  assert.equal(await evaluate(`document.querySelectorAll('.node-admin-row .local-mark').length`), 1)
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('.node-facts dt')).some(node => /Version|Last seen/.test(node.textContent))`), false)
  assert.equal(await evaluate(`document.querySelectorAll('.admin-actions').length`), 0)
  assert.equal(await evaluate(`document.querySelectorAll('.node-capabilities[open]').length`), 0)
  await evaluate(`document.querySelector('.node-capabilities summary').focus()`)
  assert.equal(await evaluate(`document.activeElement === document.querySelector('.node-capabilities summary')`), true)
  await click('.node-capabilities summary')
  await waitFor(`Boolean(document.querySelector('.node-capabilities[open]'))`)
  assert.equal(await evaluate(`document.querySelectorAll('.node-capabilities[open] .capability-row').length`), 2)
  assert.match(await evaluate<string>(`document.querySelector('.node-capabilities[open] .path').textContent`), /synthetic/)
  assert.equal(await evaluate(`document.querySelector('.node-admin-list').textContent.includes('fixture-source')`), false)
  assert.equal(await evaluate(`document.querySelector('.node-admin-list').textContent.includes('Approval')`), false)
  await evaluate(`document.querySelectorAll('.node-capabilities').forEach(details => details.open = true)`)
  assert.equal(await evaluate(`document.querySelectorAll('.capability-row .availability.unavailable').length`), 1)
  assert.equal(await evaluate(`document.querySelectorAll('.node-admin-row .status-dot.revoked').length`), 1)
  assert.equal(await evaluate(`document.querySelectorAll('.capability-row .path').length`), 1, 'Never invent remote paths')
  await new Promise(resolve => setTimeout(resolve, 200))
  await writeFile(join(directory, 'nodes-capabilities-desktop.png'), (await window.webContents.capturePage()).toPNG())
  window.webContents.enableDeviceEmulation({ screenPosition: 'desktop', screenSize: { width: 390, height: 844 }, viewPosition: { x: 0, y: 0 }, viewSize: { width: 390, height: 844 }, deviceScaleFactor: 1, scale: 1 })
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth && Array.from(document.querySelectorAll('.node-admin-row, .capability-row, .capability-row .path')).every(node => node.getBoundingClientRect().right <= innerWidth)`), true)
  await writeFile(join(directory, 'nodes-capabilities-mobile.png'), (await window.webContents.capturePage({ x: 0, y: 0, width: 390, height: 844 })).toPNG())
  window.webContents.disableDeviceEmulation()
  inventoryState = 'changed'
  await waitFor(`document.querySelectorAll('.capability-row .availability.online').length === 3`)
  assert.equal(await evaluate(`document.querySelectorAll('.node-capabilities[open]').length`), 2, 'Polling must preserve expanded devices')
  inventoryState = 'error'
  await click('.context-strip button')
  await waitFor(`document.querySelector('.inventory-error')?.textContent.includes('503')`)
  assert.equal(await evaluate(`document.querySelectorAll('.node-admin-row').length`), 0, 'Unavailable API must not display stale online statuses')
  inventoryState = 'empty'
  await click('.context-strip button')
  await waitFor(`document.querySelector('.empty-panel')?.textContent.includes('No devices registered')`)
  assert.equal(await evaluate(`Boolean(document.querySelector('.inventory-error'))`), false)
  inventoryState = 'ready'
  await click('.context-strip button')
  await waitFor(`document.querySelectorAll('.node-admin-row').length === 3`)
  inventoryGate = new Promise(resolve => { releaseInventory = resolve })
  await click('.context-strip button')
  await waitFor(`document.querySelector('.context-strip button').disabled`)
  await evaluate(`Array.from(document.querySelectorAll('.tab-nav .tab')).find(node => node.textContent.trim() === 'Chat').click()`)
  await waitFor(`location.pathname === '/chat' && !document.querySelector('.node-admin-list')`)
  releaseInventory!()
  const stoppedInventoryRequests = inventoryRequests
  await new Promise(resolve => setTimeout(resolve, 5200))
  assert.equal(inventoryRequests, stoppedInventoryRequests, 'Unmounted Nodes must stop polling')
  await waitFor(`Boolean(document.querySelector('.composer-input textarea'))`)
  await evaluate(`(() => { const input = document.querySelector('.composer-input textarea'); input.value = 'Keep this draft while configuring providers'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
  await evaluate(`Array.from(document.querySelectorAll('.tab-nav .tab')).find(node => node.textContent.trim() === 'Settings').click()`)
  await waitFor(`document.querySelectorAll('.provider-card').length === 3 && document.querySelector('.provider-form')`)
  assert.equal(await evaluate(`document.querySelectorAll('.provider-selected').length`), 1)
  assert.equal(await evaluate(`document.querySelector('[data-provider="custom"] .provider-state').textContent.trim()`), 'Ready')
  assert.equal(await evaluate(`document.querySelector('[data-provider="openai"] .provider-state').textContent.trim()`), 'Configured')
  assert.equal(await evaluate(`document.querySelectorAll('.provider-form').length`), 1)
  assert.equal(await evaluate(`document.querySelector('.setup-title').textContent.trim()`), 'Add provider')
  assert.equal(await evaluate(`Boolean(document.querySelector('.provider-form option[value="openai"], .provider-form .method-tabs'))`), false, 'Existing providers must only be edited through their own cards')
  assert.equal(await evaluate(`document.querySelector('.provider-form select').value`), 'anthropic')
  assert.equal(await evaluate(`document.querySelector('.provider-form input[type="password"]').value`), '')
  await new Promise(resolve => setTimeout(resolve, 150))
  await writeFile(join(directory, 'providers-desktop.png'), (await window.webContents.capturePage()).toPNG())
  window.webContents.enableDeviceEmulation({ screenPosition: 'desktop', screenSize: { width: 390, height: 844 }, viewPosition: { x: 0, y: 0 }, viewSize: { width: 390, height: 844 }, deviceScaleFactor: 1, scale: 1 })
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth && Array.from(document.querySelectorAll('.provider-card, .provider-form, .provider-form input')).every(node => node.getBoundingClientRect().right <= innerWidth)`), true)
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.provider-cards')).gridTemplateColumns.split(' ').length`), 1)
  await writeFile(join(directory, 'providers-mobile.png'), (await window.webContents.capturePage({ x: 0, y: 0, width: 390, height: 844 })).toPNG())
  window.webContents.disableDeviceEmulation()
  await new Promise(resolve => setTimeout(resolve, 150))
  await click('[data-provider="openai"] button')
  await waitFor(`document.querySelector('.setup-title').textContent.includes('OpenAI settings')`)
  assert.equal(await evaluate(`document.activeElement === document.querySelector('.setup-title')`), true)
  assert.equal(await evaluate(`document.querySelector('.provider-form select').disabled`), true)
  assert.equal(await evaluate(`document.querySelector('.provider-form input[type="url"]').value`), 'https://api.openai.com/v1')
  assert.equal(await evaluate(`document.querySelector('.provider-form input[type="password"]').placeholder`), 'Leave blank to keep the saved key')
  assert.equal(await evaluate(`document.querySelector('.provider-form input[type="password"]').required`), false)
  failProviderSave = true
  await evaluate(`document.querySelector('.provider-form form').requestSubmit()`)
  await waitFor(`document.querySelector('.provider-form .error')?.textContent.includes('Cannot reach')`)
  assert.equal(providerSaves.at(-1)?.provider, 'openai')
  assert.equal('apiKey' in providerSaves.at(-1)!, false, 'Editing with a blank key must preserve the saved credential')
  assert.equal(await evaluate(`location.pathname`), '/settings', 'Failed save stays in the form')
  failProviderSave = false
  await click('[data-provider="copilot"] button')
  await waitFor(`document.querySelector('.setup-title').textContent.includes('GitHub Copilot settings')`)
  await click('.provider-form .actions .primary')
  await waitFor(`Boolean(document.querySelector('.device-panel'))`)
  await click('[data-provider="custom"] button')
  await waitFor(`document.querySelector('.setup-title').textContent.includes('custom settings')`)
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(cancelledProviderLogins.size, 1, 'Switching provider cards cancels the previous device login')
  assert.equal(await evaluate(`document.querySelector('.provider-form input[placeholder="local"]').disabled`), true)
  assert.equal(await evaluate(`document.querySelector('.provider-form input[placeholder="Model ID from your provider"]').value`), 'synthetic-model')
  await evaluate(`Array.from(document.querySelectorAll('.provider-form button')).find(node => node.textContent === 'Done editing').click()`)
  assert.equal(await evaluate(`document.activeElement === document.querySelector('[data-provider="custom"] button')`), true)
  await waitFor(`document.querySelector('.provider-form select').value === 'anthropic'`)
  await evaluate(`(() => { const input = document.querySelector('.provider-form input[type="password"]'); input.value = 'synthetic-new-key'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
  await evaluate(`document.querySelector('.provider-form form').requestSubmit()`)
  await waitFor(`location.pathname === '/chat' && document.querySelector('.composer-input textarea')?.value === 'Keep this draft while configuring providers'`)
  assert.equal(providerSaves.at(-1)?.provider, 'anthropic')
  await evaluate(`Array.from(document.querySelectorAll('.tab-nav .tab')).find(node => node.textContent.trim() === 'Settings').click()`)
  await waitFor(`document.querySelectorAll('.provider-card').length === 4`)
  assert.equal(await evaluate(`Boolean(document.querySelector('.provider-form option[value="anthropic"]'))`), false)
  assert.equal(await evaluate(`Boolean(document.querySelector('[data-provider="anthropic"] .provider-selected'))`), true)
  failProviderInventory = true
  await evaluate(`Array.from(document.querySelectorAll('.provider-form button')).find(node => node.textContent === 'Recheck configuration').click()`)
  await waitFor(`Boolean(document.querySelector('.providers-view .inventory-error'))`)
  assert.equal(await evaluate(`document.querySelectorAll('.provider-card').length`), 0, 'Failed inventory must not show stale cards')
  failProviderInventory = false
  await click('.providers-view .inventory-error button')
  await waitFor(`document.querySelectorAll('.provider-card').length === 4`)
  groupTreeSessions = true
  realtime.publisher.invalidateSessions()
  await window.loadURL(`${origin}/chat/${encodeURIComponent(idA)}`)
  await waitFor(`document.querySelectorAll('.folder-conversations .tree-item').length === 3 && document.querySelector('.file-tree .tree-row[data-path="README.md"]')`)
  assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('.folder-conversations .tree-item'), row => row.style.getPropertyValue('--tree-depth'))`), ['1', '2', '2'], 'Folder sessions and their children preserve lineage using shared depth')
  await click('.tree-row[data-path="src"]')
  await waitFor(`document.querySelector('.tree-row[data-path="src/main.ts"]')`)
  await new Promise(resolve => setTimeout(resolve, 150))
  await writeFile(join(directory, 'shared-trees-desktop.png'), (await window.webContents.capturePage()).toPNG())
  window.webContents.enableDeviceEmulation({ screenPosition: 'desktop', screenSize: { width: 390, height: 844 }, viewPosition: { x: 0, y: 0 }, viewSize: { width: 390, height: 844 }, deviceScaleFactor: 1, scale: 1 })
  await waitFor(`innerWidth === 390`)
  await click('.mobile-sessions-toggle')
  await waitFor(`document.querySelector('.mobile-sessions-open')`)
  assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth && Array.from(document.querySelectorAll('.folder-conversations .tree-item')).every(row => row.getBoundingClientRect().right <= innerWidth)`), true)
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.folder-conversations .session-delete')).opacity`), '1', 'Tree actions remain discoverable without hover on mobile')
  await new Promise(resolve => setTimeout(resolve, 150))
  await writeFile(join(directory, 'shared-trees-mobile.png'), (await window.webContents.capturePage({ x: 0, y: 0, width: 390, height: 844 })).toPNG())
  window.webContents.disableDeviceEmulation()
  await waitFor(`innerWidth > 1280`)
  if (await evaluate(`Boolean(document.querySelector('.mobile-sessions-open'))`)) await click('.mobile-sessions-toggle')
  const sessionsBeforeFolderDraft = extraSessions.length
  const historyBeforeFolderDraft = chatHistoryRequests.length
  const sendsBeforeFolderDraft = sentMessages.length
  const filesBeforeFolderDraft = fileRequests.length
  await click('[aria-label="New conversation in Synthetic folder"]')
  await waitFor(`document.querySelector('.draft-folder strong')?.textContent === 'Synthetic folder'`)
  if (!await evaluate(`document.querySelector('.workbench-explorer').getClientRects().length > 0`)) await click('.explorer-toggle')
  await waitFor(`document.querySelector('.tree-row[data-path="synthetic-folder.txt"]')`)
  assert.equal(await evaluate(`document.querySelector('[aria-label="Refresh files"]').disabled`), false, 'Unsent folder drafts have a usable explorer')
  assert.equal(await evaluate(`(() => {
    const content = document.querySelector('.workbench-content').getBoundingClientRect();
    const heading = document.querySelector('.draft-heading').getBoundingClientRect();
    const composer = document.querySelector('.composer-box').getBoundingClientRect();
    return Math.abs(heading.left + heading.width / 2 - composer.left - composer.width / 2) < 2
      && heading.top >= content.top && heading.bottom <= composer.top && composer.bottom <= innerHeight
      && composer.left >= content.left && composer.right <= content.right;
  })()`), true, 'Draft heading and shared composer remain centered, ordered and bounded')
  folderPreviewGate = new Promise(resolve => { releaseFolderPreview = resolve })
  const folderPreviewStart = folderFileRequests.length
  await click('.tree-row[data-path="README.md"]')
  await waitFor(`document.querySelector('.file-modal-text-wrap')?.textContent.includes('Loading')`)
  for (let attempt = 0; attempt < 100 && !folderFileRequests.slice(folderPreviewStart).some(request => request.kind === 'preview'); attempt++) await new Promise(resolve => setTimeout(resolve, 20))
  const pendingFolderPreview = folderFileRequests.slice(folderPreviewStart).find(request => request.kind === 'preview')
  assert.ok(pendingFolderPreview, 'The pending preview must reach the synthetic folder endpoint before switching scope')
  await click('[aria-label="New conversation in Second folder"]')
  await waitFor(`document.querySelector('.tree-row[data-path="synthetic-folder-two.txt"]')`)
  assert.equal(await evaluate(`document.querySelectorAll('.document-tablist [role="tab"]').length`), 1, 'A second folder starts with an independent document set')
  assert.equal(await evaluate(`Boolean(document.querySelector('.tree-row[data-path="synthetic-folder.txt"]'))`), false)
  for (let attempt = 0; attempt < 100 && !pendingFolderPreview.aborted; attempt++) await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(pendingFolderPreview.aborted, true, 'Switching folder scope aborts pending previews')
  releaseFolderPreview!()
  await click('.tree-row[data-path="README.md"]')
  await waitFor(`document.querySelector('.file-markdown h1')?.textContent === 'synthetic-folder-two'`)
  assert.equal(await evaluate(`document.querySelector('.file-markdown a').href`), `${origin}/api/folders/synthetic-folder-two/static/synthetic-folder-two.txt`)
  assert.equal(await evaluate(`new URL(document.querySelector('.file-modal-actions a').href).pathname`), '/api/folders/synthetic-folder-two/raw')
  await click('[aria-label="New conversation in Synthetic folder"]')
  await waitFor(`document.querySelector('.tree-row[data-path="synthetic-folder.txt"]') && document.querySelector('.document-tablist [aria-selected="true"]').textContent.trim() === 'Conversation'`)
  await click('.document-tablist [aria-label="README.md"]')
  await waitFor(`document.querySelector('.file-markdown h1')?.textContent === 'synthetic-folder'`)
  assert.equal(await evaluate(`document.querySelectorAll('.document-tablist [role="tab"]').length`), 2, 'Returning to a folder restores only its own documents')
  assert.equal(extraSessions.length, sessionsBeforeFolderDraft)
  assert.equal(folderSessionRequests.length, 0, 'Folder tree and preview must not create a session before Send')
  assert.equal(chatHistoryRequests.length, historyBeforeFolderDraft)
  assert.equal(sentMessages.length, sendsBeforeFolderDraft)
  assert.equal(fileRequests.length, filesBeforeFolderDraft, 'Folder drafts never address session filesystem routes')
  await click('[aria-label="New conversation in Second folder"]')
  await waitFor(`document.querySelector('.tree-row[data-path="synthetic-folder-two.txt"]')`)
  await click('.document-tablist [aria-label="README.md"]')
  await waitFor(`document.querySelector('.file-markdown h1')?.textContent === 'synthetic-folder-two'`)
  await click('[aria-label="New conversation in Second folder"]')
  await waitFor(`document.querySelector('.document-tablist [aria-selected="true"]').textContent.trim() === 'Conversation' && document.activeElement === document.querySelector('textarea')`)
  assert.equal(await evaluate(`document.querySelectorAll('.document-tablist [role="tab"]').length`), 2, 'The same folder + action returns to Conversation without discarding its open file tabs')
  assert.equal(folderSessionRequests.length, 0)
  const uploadsBeforeFolderPaste = uploadAttempts
  await prepareComposer('')
  assert.equal(await pasteFixture({ images: ['red.png'] }), true)
  await waitFor(`document.querySelector('.attachment-thumb')?.naturalWidth === 1 && !document.querySelector('.composer-send').disabled`)
  assert.equal(await evaluate(`document.querySelector('.composer-input textarea').value`), '', 'An image-only folder draft is sendable without inserting text')
  assert.equal(folderSessionRequests.length, 0)
  assert.equal(extraSessions.length, sessionsBeforeFolderDraft)
  assert.equal(uploadAttempts, uploadsBeforeFolderPaste, 'Folder draft paste does not upload or materialize a session')
  await prepareComposer('Create folder conversation after browsing')
  await evaluate(`window.folderFileComposer = document.querySelector('.composer-input textarea')`)
  await click('.document-tablist [aria-label="README.md"]')
  await waitFor(`document.querySelector('.file-markdown h1')?.textContent === 'synthetic-folder-two'`)
  const draftFileRequestsBeforeQuote = folderFileRequests.length
  const folderQuoteText = await selectFileText('.file-markdown h1')
  await click('.selection-menu button:first-of-type')
  await waitFor(`!document.querySelector('.selection-menu') && document.activeElement === window.folderFileComposer`)
  const folderFilePayload = `Create folder conversation after browsing\n\n> File: README.md\n> Lines: 1 (source block)\n> \n> ${folderQuoteText}\n\n`
  assert.equal(await evaluate(`window.folderFileComposer.value`), folderFilePayload)
  assert.equal(await evaluate(`document.querySelector('.document-tablist [aria-selected="true"]').getAttribute('aria-label')`), 'README.md')
  assert.equal(folderFileRequests.length, draftFileRequestsBeforeQuote)
  assert.equal(folderSessionRequests.length, 0, 'Quoting folder files keeps an unsent draft sessionless')
  assert.equal(extraSessions.length, sessionsBeforeFolderDraft)
  await assertFileComposer()
  failFolderSessionCreate = true
  await click('.composer-send')
  await waitFor(`document.querySelector('.composer-error')?.textContent.includes('Main could not complete') && !document.querySelector('.composer-send').disabled`)
  assert.equal(await evaluate(`document.querySelector('.document-tablist [aria-selected="true"]').getAttribute('aria-label') === 'README.md' && document.querySelector('.composer-input textarea') === window.folderFileComposer && window.folderFileComposer.value === ${JSON.stringify(folderFilePayload)}`), true, 'Failure before session preparation keeps the file and shared draft composer intact')
  assert.equal(folderSessionRequests.length, 0)
  assert.equal(uploadAttempts, uploadsBeforeFolderPaste, 'Failure before folder creation leaves pasted images pending and unuploaded')
  assert.equal(await evaluate(`document.querySelector('.attachment-thumb')?.naturalWidth`), 1)
  failFolderSessionCreate = false
  await click('.composer-send')
  await waitFor(`document.querySelector('.chat-messages')?.textContent.includes('A streamed response')`)
  assert.deepEqual(folderSessionRequests, ['synthetic-folder-two'])
  assert.equal(extraSessions.length, sessionsBeforeFolderDraft + 1)
  assert.equal(sentMessages.at(-1)?.chatId, 'chat-folder-created-1')
  assert.equal(sentMessages.at(-1)?.content, folderFilePayload.trim())
  assert.deepEqual(sentMessages.at(-1)?.media, ['C:\\synthetic\\uploads\\chat-folder-created-1\\red.png'])
  assert.equal(uploadAttempts, uploadsBeforeFolderPaste + 1)
  assert.equal(await evaluate(`document.querySelector('.document-tablist [aria-selected="true"]').textContent.trim() === 'Conversation' && document.querySelector('.composer-input textarea') === window.folderFileComposer`), true, 'Sending from a file returns to Conversation without replacing the composer')
  completeSend!()
  await waitFor(`!document.querySelector('textarea').disabled && document.querySelector('.tree-row[data-path="src"]')`)
  assert.equal(await evaluate(`document.querySelectorAll('.document-tablist [role="tab"]').length`), 2, 'Created sessions start with Conversation and Diagnosis')
  assert.equal(fileRequests.at(-1)?.sessionId, 'web:chat-folder-created-1')
  await click('.tree-row[data-path="README.md"]')
  await waitFor(`document.querySelector('.file-markdown h1')?.textContent === 'README.md'`)
  assert.equal(previewRequests.at(-1)?.sessionId, 'web:chat-folder-created-1')
  const sessionFilesBeforeScratch = fileRequests.length
  const folderFilesBeforeScratch = folderFileRequests.length
  await click('[aria-label="Add folder"]')
  await waitFor(`document.querySelectorAll('#folder-actions [role="menuitem"]').length === 3`)
  await evaluate(`Array.from(document.querySelectorAll('#folder-actions [role="menuitem"]')).find(node => node.textContent.includes('Start from scratch')).click()`)
  await waitFor(`document.querySelector('.draft-scratch') && document.querySelector('.file-tree-note')?.textContent.includes('select a conversation')`)
  assert.equal(await evaluate(`document.querySelector('[aria-label="Refresh files"]').disabled && !document.querySelector('.file-document')`), true)
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(fileRequests.length, sessionFilesBeforeScratch, 'Scratch must not retain the previous session file scope')
  assert.equal(folderFileRequests.length, folderFilesBeforeScratch, 'Scratch must not retain the previous folder file scope')
  assert.equal(extraSessions.length, sessionsBeforeFolderDraft + 1)
  const gitScope = `sessions:${idA}`
  const dirtyGit: GitStatus = { available: true, entries: [
    { path: 'src/main.ts', status: 'modified' },
    { path: 'new.ts', status: 'untracked' },
    { path: 'gone/archive/deleted.ts', status: 'deleted' },
    { path: 'renamed.ts', originalPath: 'old.ts', status: 'renamed' },
    { path: 'conflict.ts', status: 'conflicted' },
    { path: 'added.ts', status: 'added' },
    { path: 'typechanged.ts', status: 'typechanged' },
    { path: 'binary.dat', status: 'modified' },
    { path: 'large.ts', status: 'modified' },
  ] }
  gitFixtureScopes.add(gitScope)
  gitStates.set(gitScope, dirtyGit)
  for (const entry of dirtyGit.entries) {
    gitDiffs.set(`${gitScope}\0${entry.path}`, {
      ...entry, base: entry.status === 'untracked' ? 'empty' : 'HEAD', binary: entry.path === 'binary.dat',
      truncated: entry.path === 'large.ts', hunks: [],
    })
  }
  const combinedDiff: GitDiff = {
    path: 'src/main.ts', status: 'modified', base: 'HEAD', binary: false, truncated: false,
    hunks: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 4, lines: [
      ' // src/main.ts', '-const before = 1', '+const staged = 2', '+const after = 3', " console.log('done')",
    ] }],
  }
  gitDiffs.set(`${gitScope}\0src/main.ts`, combinedDiff)
  gitDiffs.get(`${gitScope}\0new.ts`)!.hunks = [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ['+export const created = true', '+console.log(created)'] }]
  gitDiffs.get(`${gitScope}\0gone/archive/deleted.ts`)!.hunks = [{ oldStart: 1, oldLines: 2, newStart: 0, newLines: 0, lines: ['-const removed = true', '-console.log(removed)'] }]
  gitDiffs.get(`${gitScope}\0added.ts`)!.notice = 'Index differs, but there is no net HEAD-to-working-tree content change.'
  gitDiffs.get(`${gitScope}\0typechanged.ts`)!.notice = 'Symbolic link target changed; not followed.'
  await window.loadURL(`${origin}/chat/${encodeURIComponent(idA)}`)
  await waitFor(`document.querySelector('.tree-row[data-path="new.ts"] .git-status')?.textContent === 'U'`)
  keyboard.attach('1.3')
  await evaluate(`Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.gitCopied = text } } }); window.gitComposer = document.querySelector('textarea')`)
  await click('.tree-row[data-path="README.md"]')
  await waitFor(`document.querySelector('.file-markdown h1')?.textContent === 'README.md'`)
  const expandedFoldersWidth = await evaluate(`document.querySelector('.folders-sidebar').getBoundingClientRect().width`)
  await click('[aria-label="Collapse folders"]')
  await waitFor(`document.querySelector('.folders-sidebar.is-rail')`)
  assert.equal(await evaluate(`document.querySelector('.folders-sidebar').getBoundingClientRect().width`), 64)
  assert.equal(await evaluate(`!document.querySelector('.folders-resizer') && !document.querySelector('.folder-conversations') && document.querySelector('textarea') === window.gitComposer`), true, 'Rail hides inline families and resizing without remounting the conversation')
  assert.equal(await evaluate(`document.querySelectorAll('.folders-sidebar [title], .tree-row[title], .document-tab[title]').length`), 0, 'Component hover information replaces native titles')
  const focusBeforeRailHover = await evaluate(`document.activeElement.getAttribute('aria-label')`)
  const railFolder = await evaluate(`(() => { const rect = document.querySelector('.folder-folder[aria-label="Synthetic folder"]').getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } })()`) as { x: number; y: number }
  await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...railFolder })
  await waitFor(`document.querySelector('.hover-info-popup[role="dialog"] .folder-info-path')`)
  assert.equal(await evaluate(`document.querySelector('.folder-info-path').textContent`), 'C:\\synthetic\\folder')
  assert.equal(await evaluate(`document.querySelectorAll('.folder-info-conversations .session-select').length`), 3)
  assert.equal(await evaluate(`(() => { const card = document.querySelector('.hover-info-popup').getBoundingClientRect(); return card.left >= 0 && card.top >= 0 && card.right <= innerWidth && card.bottom <= innerHeight })()`), true)
  const cardSession = await evaluate(`(() => { const rect = document.querySelector('.folder-info-conversations .session-select').getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } })()`) as { x: number; y: number }
  await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...cardSession })
  await new Promise(resolve => setTimeout(resolve, 220))
  assert.equal(await evaluate(`document.querySelectorAll('.hover-info-popup').length === 1 && !!document.querySelector('.folder-info')`), true, 'Pointer crossing the trigger/card gap keeps rich navigation open without spawning nested cards')
  await new Promise(resolve => setTimeout(resolve, 250))
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.hover-info-popup')).visibility`), 'visible')
  await writeFile(join(directory, 'folders-rail-hovercard.png'), (await window.webContents.capturePage()).toPNG())
  await nativeKey('Escape', 'Escape', 27)
  await waitFor(`!document.querySelector('.hover-info-popup')`)
  assert.equal(await evaluate(`document.activeElement.getAttribute('aria-label')`), focusBeforeRailHover, 'Dismissing a passive hover card does not steal document focus')
  await evaluate(`document.querySelector('.folder-folder[aria-label="Synthetic folder"]').focus()`)
  await nativeKey('ArrowRight', 'ArrowRight', 39)
  await waitFor(`document.querySelector('.hover-info-popup')?.contains(document.activeElement)`)
  assert.equal(await evaluate(`document.activeElement.classList.contains('folder-info-new')`), true, 'Keyboard enters the rich folder card actions')
  const documentBeforeCardShortcut = await evaluate(`document.querySelector('.document-tablist [aria-selected="true"]').textContent`)
  await nativeKey('Tab', 'Tab', 9, undefined, 2)
  assert.equal(await evaluate(`document.querySelector('.document-tablist [aria-selected="true"]').textContent`), documentBeforeCardShortcut, 'Ctrl+Tab remains blocked when focus is inside interactive hover-card navigation')
  await nativeKey('Escape', 'Escape', 27)
  await evaluate(`document.querySelector('.session-select[aria-label="Second conversation"]').focus()`)
  await waitFor(`document.querySelector('.session-info-id')?.textContent === ${JSON.stringify(idB)}`)
  assert.equal(await evaluate(`document.querySelectorAll('.hover-info-popup').length`), 1, 'Only the current root entry owns an open information card')
  await nativeKey('Tab', 'Tab', 9)
  await waitFor(`document.activeElement.classList.contains('session-info-open')`)
  await nativeKey('Escape', 'Escape', 27)
  assert.equal(await evaluate(`document.activeElement.getAttribute('aria-label')`), 'Second conversation')
  await waitFor(`!document.querySelector('.hover-info-popup')`)
  await click('[aria-label="Expand folders"]')
  await waitFor(`document.querySelector('.folders-resizer') && document.querySelector('.folder-conversations')`)
  assert.equal(await evaluate(`document.querySelector('.folders-sidebar').getBoundingClientRect().width`), expandedFoldersWidth)
  await click('[aria-label="Collapse folders"]')
  window.webContents.enableDeviceEmulation({ screenPosition: 'desktop', screenSize: { width: 390, height: 844 }, viewPosition: { x: 0, y: 0 }, viewSize: { width: 390, height: 844 }, deviceScaleFactor: 1, scale: 1 })
  await waitFor(`innerWidth === 390`)
  await click('.mobile-sessions-toggle')
  await waitFor(`document.querySelector('.mobile-sessions-open') && !document.querySelector('.folders-sidebar.is-rail') && !document.querySelector('.folders-rail-toggle') && document.querySelector('.folder-conversations')`)
  assert.equal(await evaluate(`document.querySelector('.folders-sidebar').getBoundingClientRect().width > 64 && document.querySelector('.folders-sidebar').getBoundingClientRect().right <= innerWidth`), true, 'Mobile Folders stays a full usable drawer, not an icon rail')
  await click('.mobile-sessions-toggle')
  window.webContents.disableDeviceEmulation()
  await waitFor(`innerWidth > 1280 && document.querySelector('.folders-sidebar.is-rail')`)
  await click('[aria-label="Expand folders"]')
  await waitFor(`document.querySelector('.folders-resizer')`)
  await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1200, y: 25 })
  await click('[aria-label="Close README.md"]')
  await click('.tree-row[data-path="src"]')
  await waitFor(`document.querySelector('.tree-row[data-path="src/main.ts"] .git-status')?.textContent === 'M'`)
  assert.equal(await evaluate(`!!document.querySelector('.tree-row[data-path="clean.txt"]') && !document.querySelector('.tree-row[data-path="clean.txt"] .git-status')`), true)
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.tree-row[data-path="new.ts"] .tree-label')).color !== getComputedStyle(document.querySelector('.tree-row[data-path="src/main.ts"] .tree-label')).color`), true, 'Git statuses color filenames, not just their badges')
  await click('.tree-row[data-path="src/main.ts"]')
  await waitFor(`document.querySelector('.file-modal-text')?.textContent.includes('export const answer')`)
  const gitListRequests = fileRequests.length
  await click('.file-tree-modes [role="tab"]:last-child')
  await waitFor(`document.querySelector('.tree-row[data-path="gone/archive/deleted.ts"]')`)
  assert.equal(await evaluate(`!!document.querySelector('.tree-row[data-path="clean.txt"]')`), false)
  for (const [path, badge] of [['gone/archive/deleted.ts', 'D'], ['renamed.ts', 'R'], ['conflict.ts', '!'], ['added.ts', 'A'], ['typechanged.ts', 'T']]) {
    assert.equal(await evaluate(`document.querySelector('.tree-row[data-path="${path}"] .git-status').textContent`), badge)
  }
  await click('.tree-row[data-path="gone"]')
  await click('.tree-row[data-path="gone"]')
  await waitFor(`document.querySelector('.tree-row[data-path="gone/archive/deleted.ts"]')`)
  assert.equal(fileRequests.length, gitListRequests, 'Changes directories, including deleted ghost directories, never list the filesystem')
  await click('.tree-row[data-path="src/main.ts"]')
  await waitFor(`document.querySelectorAll('.diff-row').length === 5 && document.querySelector('.diff-token[style*="--file-token-light"]')`)
  assert.equal(await evaluate(`document.querySelectorAll('.document-tablist [role="tab"]').length`), 3, 'Source and HEAD-to-working changes coexist beside pinned Conversation')
  assert.equal(await evaluate(`document.querySelector('textarea') === window.gitComposer && Array.from(document.querySelectorAll('.diff-line-number')).every(node => node.textContent === '')`), true, 'One shared composer and presentation-only line gutters')
  assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('.diff-row'), row => [row.dataset.oldLine ?? null, row.dataset.newLine ?? null])`), [['1', '1'], ['2', null], [null, '2'], [null, '3'], ['3', '4']])
  await click('.file-tree-modes [role="tab"]:first-child')
  await waitFor(`document.querySelector('.tree-row[data-path="clean.txt"]')`)
  assert.equal(await evaluate(`document.querySelector('.file-tree.tree-only') !== null`), true, 'Files mode retains the shared explorer structure')
  await click('.file-tree-modes [role="tab"]:last-child')
  const diffCode = '.diff-row[data-old-line="2"] .diff-code'
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(diffCode)}).textContent`), '-const before = 1\n')
  const diffExcerpt = await selectFileText(diffCode, 0, '-const before = 1'.length)
  assert.equal(diffExcerpt, '-const before = 1')
  const gitSends = sentMessages.length
  await nativeKey('c', 'KeyC', 67, 'c')
  await waitFor(`window.gitCopied === ${JSON.stringify(diffExcerpt)}`)
  assert.equal(sentMessages.length, gitSends)
  await prepareComposer('')
  await selectFileText(diffCode)
  await nativeKey('q', 'KeyQ', 81, 'q')
  await waitFor(`!document.querySelector('.selection-menu') && document.querySelector('textarea').value.includes('HEAD lines: 2')`)
  assert.equal(await evaluate(`document.querySelector('textarea').value.includes('File: "src/main.ts"') && document.querySelector('textarea').value.includes('Diff: HEAD -> working tree') && !document.querySelector('textarea').value.includes('Working tree lines:')`), true)
  assert.equal(await evaluate(`document.querySelector('.document-tablist [aria-selected="true"]').getAttribute('aria-label')`), 'src/main.ts changes')
  assert.equal(sentMessages.length, gitSends, 'Diff quotes never send implicitly')
  await selectFileText('.diff-row[data-new-line="2"] .diff-code')
  await click('.selection-menu button:first-of-type')
  await waitFor(`document.querySelector('textarea').value.includes('Working tree lines: 2')`)
  const pinnedBeforeGitCycle = await evaluate(`document.querySelector('.conversation-tab').getBoundingClientRect().x`)
  await evaluate(`document.querySelector('textarea').focus()`)
  await nativeKey('Tab', 'Tab', 9, undefined, 2)
  await waitFor(`document.querySelector('.conversation-tab [role="tab"]').getAttribute('aria-selected') === 'true'`)
  await nativeKey('Tab', 'Tab', 9, undefined, 2)
  await waitFor(`document.querySelector('.document-tablist [aria-selected="true"]').getAttribute('aria-label') === 'src/main.ts'`)
  await nativeKey('Tab', 'Tab', 9, undefined, 2)
  await waitFor(`document.querySelector('.document-tablist [aria-selected="true"]').getAttribute('aria-label') === 'src/main.ts changes'`)
  assert.equal(await evaluate(`document.querySelector('.conversation-tab').getBoundingClientRect().x`), pinnedBeforeGitCycle)
  await prepareComposer('Review the staged and unstaged changes together.')
  const selectedDiff = await selectFileText(diffCode)
  const selectedDiffNode = await evaluate(`window.selectedDiffNode = document.querySelector('.diff-content'); true`)
  assert.equal(selectedDiffNode, true)
  const beforeGitPoll = gitRequests.filter(request => request.scope === gitScope && request.operation === 'diff').length
  const refreshedDiff = structuredClone(combinedDiff)
  refreshedDiff.hunks[0]!.lines[3] = '+const refreshed = 4'
  gitDiffs.set(`${gitScope}\0src/main.ts`, refreshedDiff)
  for (let attempt = 0; attempt < 80 && gitRequests.filter(request => request.scope === gitScope && request.operation === 'diff').length === beforeGitPoll; attempt++) await new Promise(resolve => setTimeout(resolve, 100))
  assert.ok(gitRequests.filter(request => request.scope === gitScope && request.operation === 'diff').length > beforeGitPoll, 'Active diff must auto-refresh from status polling')
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(await evaluate(`getSelection().toString()`), selectedDiff, 'Auto-refresh preserves the native diff selection')
  assert.equal(await evaluate(`document.querySelector('.diff-content') === window.selectedDiffNode && !document.querySelector('.diff-content').textContent.includes('refreshed')`), true)
  await evaluate(`getSelection().removeAllRanges(); document.dispatchEvent(new Event('selectionchange'))`)
  await waitFor(`document.querySelector('.diff-content')?.textContent.includes('refreshed')`)
  const assertDiffOverlay = async () => {
    await evaluate(`Array.from(document.querySelectorAll('.file-diff-scroll')).find(node => node.getClientRects().length).scrollTop = 100000`)
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.equal(await evaluate(`(() => {
      const scroller = Array.from(document.querySelectorAll('.file-diff-scroll')).find(node => node.getClientRects().length); const dock = document.querySelector('.conversation-dock');
      const last = Array.from(scroller.querySelectorAll('.diff-row, .diff-notice')).at(-1);
      return getComputedStyle(dock).position === 'absolute' && parseFloat(getComputedStyle(scroller).paddingBottom) >= dock.getBoundingClientRect().height
        && last.getBoundingClientRect().bottom <= dock.getBoundingClientRect().top + 1
        && scroller.getBoundingClientRect().bottom >= dock.getBoundingClientRect().bottom
        && document.querySelector('textarea') === window.gitComposer;
    })()`), true, 'Diff final rows and notices scroll above the shared overlay composer')
  }
  await assertDiffOverlay()
  await new Promise(resolve => setTimeout(resolve, 200))
  await writeFile(join(directory, 'git-changes-desktop.png'), (await window.webContents.capturePage()).toPNG())
  window.webContents.enableDeviceEmulation({ screenPosition: 'desktop', screenSize: { width: 390, height: 844 }, viewPosition: { x: 0, y: 0 }, viewSize: { width: 390, height: 844 }, deviceScaleFactor: 1, scale: 1 })
  await waitFor(`innerWidth === 390`)
  await assertDiffOverlay()
  assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), true)
  await new Promise(resolve => setTimeout(resolve, 200))
  await writeFile(join(directory, 'git-changes-mobile.png'), (await window.webContents.capturePage({ x: 0, y: 0, width: 390, height: 844 })).toPNG())
  window.webContents.disableDeviceEmulation()
  await waitFor(`innerWidth > 1280`)
  await waitFor(`document.querySelector('.workbench-explorer:not(.drawer)')?.getClientRects().length > 0`)
  for (const [path, text] of [['new.ts', 'New file'], ['gone/archive/deleted.ts', '-const removed'], ['renamed.ts', 'Renamed from old.ts'], ['binary.dat', 'Binary files differ'], ['large.ts', 'exceeds the diff preview limit'], ['added.ts', 'Index differs'], ['typechanged.ts', 'Symbolic link target changed']]) {
    await click(`.tree-row[data-path="${path}"]`)
    await waitFor(`Array.from(document.querySelectorAll('.file-diff')).some(node => node.getClientRects().length && node.textContent.includes(${JSON.stringify(text)}))`)
    if (path === 'gone/archive/deleted.ts') assert.equal(await evaluate(`Array.from(document.querySelectorAll('.file-diff button')).some(node => node.getClientRects().length && node.textContent === 'Open file')`), false)
    if (path === 'binary.dat' || path === 'large.ts') {
      assert.equal(await evaluate(`Array.from(document.querySelectorAll('.diff-row')).filter(node => node.getClientRects().length).length`), 0)
      await assertDiffOverlay()
    }
  }
  await click('.document-tablist [aria-label="src/main.ts changes"]')
  await waitFor(`document.querySelector('.diff-content')?.textContent.includes('refreshed')`)
  gitDiffs.delete(`${gitScope}\0src/main.ts`)
  await click('[aria-label="Refresh file diff"]')
  await waitFor(`document.querySelector('.file-diff [role="alert"]')?.textContent.includes('Showing the last loaded diff')`)
  assert.equal(await evaluate(`document.querySelector('.diff-content')?.textContent.includes('refreshed')`), true)
  gitDiffs.set(`${gitScope}\0src/main.ts`, refreshedDiff)
  await click('.conversation-tab [role="tab"]')
  gitStates.set(gitScope, 'error')
  await click('[aria-label="Refresh files"]')
  await waitFor(`document.querySelector('.file-tree [role="alert"]')?.textContent.includes('Git')`)
  assert.equal(await evaluate(`document.querySelector('.file-tree').textContent.includes('Working tree clean.')`), false, 'Git failures must not masquerade as a clean worktree')
  gitStates.set(gitScope, { available: true, entries: [] })
  await click('[aria-label="Refresh files"]')
  await waitFor(`document.querySelector('.file-tree').textContent.includes('Working tree clean.')`)
  assert.equal(await evaluate(`document.querySelectorAll('.file-tree .git-status').length`), 0)
  for (const reason of ['not_repository', 'remote_unsupported', 'git_unavailable'] as const) {
    gitStates.set(gitScope, { available: false, reason, entries: [] })
    await click('[aria-label="Refresh files"]')
    await waitFor(`document.querySelector('.file-tree-modes [role="tab"]:last-child').disabled`)
    await click('.file-tree-modes [role="tab"]:first-child')
    assert.equal(await evaluate(`document.querySelectorAll('.file-tree .git-status').length`), 0)
    if (reason !== 'not_repository') await waitFor(`document.querySelector('.file-tree [role="status"]')`)
  }
  const sessionsBeforeCardDraft = extraSessions.length
  const createsBeforeCardDraft = folderSessionRequests.length
  await evaluate(`document.querySelector('.folder-folder').focus()`)
  await nativeKey('ArrowRight', 'ArrowRight', 39)
  await waitFor(`document.activeElement.classList.contains('folder-info-new')`)
  await nativeKey('Enter', 'Enter', 13, '\r')
  await waitFor(`document.querySelector('.draft-folder strong')?.textContent === 'Synthetic folder' && !document.querySelector('.hover-info-popup')`).catch(async error => {
    throw new Error(`${error.message}; card navigation state: ${JSON.stringify(await evaluate(`({
      draft: document.querySelector('.draft-folder')?.textContent,
      focus: document.activeElement.outerHTML.slice(0, 500),
      popup: document.querySelector('.hover-info-popup')?.textContent,
      selected: document.querySelector('.document-tablist [aria-selected="true"]')?.textContent,
      path: location.pathname
    })`))}`)
  })
  assert.equal(extraSessions.length, sessionsBeforeCardDraft)
  assert.equal(folderSessionRequests.length, createsBeforeCardDraft, 'Starting a draft through rich-card navigation is lazy until Send')
  await click('[aria-label="New conversation in Second folder"]')
  await waitFor(`document.querySelector('.tree-row[data-path="synthetic-folder-two.txt"]')`)
  gitStates.set('folders:synthetic-folder', dirtyGit)
  gitGate = { scope: 'folders:synthetic-folder', operation: 'status', promise: new Promise(resolve => { releaseGit = resolve }) }
  const gitCancellationStart = gitRequests.length
  await click('[aria-label="New conversation in Synthetic folder"]')
  for (let attempt = 0; attempt < 100 && !gitRequests.slice(gitCancellationStart).some(request => request.scope === 'folders:synthetic-folder'); attempt++) await new Promise(resolve => setTimeout(resolve, 20))
  const pendingGit = gitRequests.slice(gitCancellationStart).find(request => request.scope === 'folders:synthetic-folder')
  assert.ok(pendingGit, 'Folder status request reached the gated synthetic endpoint')
  await click('[aria-label="New conversation in Second folder"]')
  await waitFor(`document.querySelector('.tree-row[data-path="synthetic-folder-two.txt"]')`)
  for (let attempt = 0; attempt < 100 && !pendingGit.aborted; attempt++) await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(pendingGit.aborted, true, 'Changing folder identity aborts stale Git status requests')
  releaseGit!()
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(await evaluate(`document.querySelectorAll('.git-status').length === 0 && document.querySelector('.file-tree-modes [role="tab"]:last-child').disabled`), true, 'Late dirty status cannot leak into another folder')
  gitDiffs.set('folders:synthetic-folder\0src/main.ts', combinedDiff)
  await click('[aria-label="New conversation in Synthetic folder"]')
  await waitFor(`!document.querySelector('.file-tree-modes [role="tab"]:last-child').disabled`)
  await click('.file-tree-modes [role="tab"]:last-child')
  await waitFor(`document.querySelector('.tree-row[data-path="src/main.ts"]')`)
  gitGate = { scope: 'folders:synthetic-folder', operation: 'diff', promise: new Promise(resolve => { releaseGit = resolve }) }
  const diffCancellationStart = gitRequests.length
  await click('.tree-row[data-path="src/main.ts"]')
  for (let attempt = 0; attempt < 100 && !gitRequests.slice(diffCancellationStart).some(request => request.operation === 'diff'); attempt++) await new Promise(resolve => setTimeout(resolve, 20))
  const pendingDiff = gitRequests.slice(diffCancellationStart).find(request => request.operation === 'diff')
  assert.ok(pendingDiff, 'Folder diff reached the gated synthetic endpoint')
  await click('[aria-label="New conversation in Second folder"]')
  await waitFor(`document.querySelector('.tree-row[data-path="synthetic-folder-two.txt"]')`)
  for (let attempt = 0; attempt < 100 && !pendingDiff.aborted; attempt++) await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(pendingDiff.aborted, true, 'Changing folder identity also aborts pending diffs')
  releaseGit!()
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(await evaluate(`!document.querySelector('.file-diff') && document.querySelectorAll('.document-tablist [role="tab"]').length === 1`), true, 'Stale diffs cannot materialize a document in another folder')
  sidebarEdgeCases = true
  realtime.publisher.invalidateSessions()
  await window.loadURL(`${origin}/chat/${encodeURIComponent(idEmpty)}`)
  await waitFor(`document.querySelector('.file-tree-root-label')?.textContent === 'empty-free-workdir' && !document.querySelector('.file-tree .tree-node') && !document.querySelector('.file-tree-note')`)
  await waitFor(`document.querySelector('.self-reflection-toggle')?.getAttribute('aria-expanded') === 'false'`)
  assert.equal(await evaluate(`!document.querySelector('#self-reflection-conversations') && !!document.querySelector('.legacy-chats .session-select[aria-label="Reflect: normal conversation"]')`), true, 'Stable reflection IDs, not ordinary Reflect: titles, determine the collapsed section')
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('.folders-sidebar .session-select')).some(node => /^Reflection fixture|^Soul reflection fixture|^Reflection child fixture/.test(node.getAttribute('aria-label')))`), false, 'Collapsed reflections and descendants are absent from ordinary folder/chat groups')
  assert.equal(await evaluate(`document.querySelectorAll('.file-tree .tree-row').length`), 0, 'An empty managed free-chat directory still has a visible authoritative root identity')
  const focusWorkspaceRoot = async (expectedPath = emptyWorkdir) => {
    await waitFor(`(document.querySelector('.chat-messages .chat-content') || document.querySelector('.file-modal-body')) && document.querySelector('.file-tree-root')?.getClientRects().length > 0`)
    await evaluate(`(() => {
      window.workspaceFocusEvents = [];
      window.workspaceFocusListener = event => window.workspaceFocusEvents.push({ type: event.type, target: event.target?.className || event.target?.nodeName, hasFocus: document.hasFocus() });
      for (const name of ['focus', 'blur', 'focusin', 'focusout', 'scroll']) window.addEventListener(name, window.workspaceFocusListener, true);
    })()`)
    await evaluate(`document.querySelector('.file-tree-root').scrollIntoView({ block: 'nearest' })`)
    await new Promise(resolve => setTimeout(resolve, 150))
    const beforeRootFocus = await evaluate(`(() => {
      const root = document.querySelector('.file-tree-root'), anchor = root.closest('.hover-info-anchor');
      return { documentFocused: document.hasFocus(), anchorExists: !!anchor, triggerMatches: !!anchor?.querySelector('[data-hover-info-trigger="' + root.dataset.hoverInfoTrigger + '"]') };
    })()`)
    await evaluate(`document.querySelector('.file-tree-root').blur(); document.querySelector('.file-tree-root').focus()`)
    const afterRootFocus = await evaluate<{ documentFocused: boolean; focusedRoot: boolean; focusinFired: boolean; events: unknown[] }>(`({
      documentFocused: document.hasFocus(), focusedRoot: document.activeElement === document.querySelector('.file-tree-root'),
      focusinFired: window.workspaceFocusEvents.some(event => event.type === 'focusin' && event.target === 'file-tree-root'), events: window.workspaceFocusEvents
    })`)
    console.log(`LAYOUT_FOCUS ${JSON.stringify({ beforeRootFocus, afterRootFocus, browserWindowFocused: window.isFocused(), webContentsFocused: window.webContents.isFocused() })}`)
    if (!afterRootFocus.documentFocused && afterRootFocus.focusedRoot && !afterRootFocus.focusinFired) {
      if (!window.webContents.debugger.isAttached()) window.webContents.debugger.attach('1.3')
      await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
      focusEmulated = true
      await waitFor(`document.hasFocus()`)
      await evaluate(`document.querySelector('.file-tree-root').blur(); document.querySelector('.file-tree-root').focus()`)
      console.log(`LAYOUT_FOCUS_RECOVERED ${JSON.stringify(await evaluate(`({ documentFocused: document.hasFocus(), events: window.workspaceFocusEvents })`))}`)
    }
    assert.equal(await evaluate(`document.hasFocus() && document.activeElement === document.querySelector('.file-tree-root') && window.workspaceFocusEvents.some(event => event.type === 'focusin' && event.target === 'file-tree-root')`), true, 'The isolated focused renderer emits a real focusin event for the workspace root')
    await waitFor(`document.querySelector('.hover-info-popup')?.textContent.includes(${JSON.stringify(expectedPath)})`).catch(async error => {
      throw new Error(`${error.message}; workspace tooltip state: ${JSON.stringify(await evaluate(`({
        root: document.querySelector('.file-tree-root')?.outerHTML, focus: document.activeElement.outerHTML.slice(0, 500),
        popup: document.querySelector('.hover-info-popup')?.outerHTML, documentFocused: document.hasFocus(), events: window.workspaceFocusEvents
      })`))}`)
    })
    await evaluate(`for (const name of ['focus', 'blur', 'focusin', 'focusout', 'scroll']) window.removeEventListener(name, window.workspaceFocusListener, true)`)
  }
  const setExplorerVisible = async (visible: boolean) => {
    await waitFor(`document.querySelector('.explorer-toggle')?.getClientRects().length > 0`)
    if (await evaluate(`document.querySelector('.explorer-toggle').getAttribute('aria-expanded') === 'true'`) !== visible) await click('.explorer-toggle')
    await waitFor(`(document.querySelector('.workbench-explorer').getClientRects().length > 0) === ${visible}`)
  }
  const clickSidebar = async (selector: string) => {
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: 'nearest' })`)
    await new Promise(resolve => setTimeout(resolve, 150))
    await click(selector)
  }
  await focusWorkspaceRoot()
  assert.equal(await evaluate(`document.querySelector('.file-tree-root').hasAttribute('title')`), false)
  await captureVisibleInfo('workspace-root-desktop.png')
  await nativeKey('Escape', 'Escape', 27)
  await setExplorerVisible(true)
  const sessionsBeforeRootSwitch = extraSessions.length
  const createsBeforeRootSwitch = folderSessionRequests.length
  folderListGate = new Promise(resolve => { releaseFolderList = resolve })
  const rootRequestStart = folderFileRequests.length
  await click('[aria-label="New conversation in Synthetic folder"]')
  for (let attempt = 0; attempt < 100 && !folderFileRequests.slice(rootRequestStart).some(request => request.kind === 'files'); attempt++) await new Promise(resolve => setTimeout(resolve, 20))
  assert.ok(folderFileRequests.slice(rootRequestStart).some(request => request.kind === 'files'))
  assert.equal(await evaluate(`!document.querySelector('.file-tree-root') && !document.querySelector('.file-tree').textContent.includes('empty-free-workdir')`), true, 'Switching scope removes old workdir metadata while the new directory request is pending')
  releaseFolderList!()
  await waitFor(`document.querySelector('.file-tree-root-label')?.textContent === 'folder'`)
  await click('[aria-label="New conversation in Second folder"]')
  await waitFor(`document.querySelector('.file-tree-root-label')?.textContent === 'second'`)
  await clickSidebar('.folders-sidebar .session-select[aria-label="Empty free conversation"]')
  await waitFor(`document.querySelector('.file-tree-root-label')?.textContent === 'empty-free-workdir'`)
  assert.equal(extraSessions.length, sessionsBeforeRootSwitch)
  assert.equal(folderSessionRequests.length, createsBeforeRootSwitch, 'Root identity browsing never creates folder conversations')
  window.webContents.enableDeviceEmulation({ screenPosition: 'desktop', screenSize: { width: 390, height: 844 }, viewPosition: { x: 0, y: 0 }, viewSize: { width: 390, height: 844 }, deviceScaleFactor: 1, scale: 1 })
  await waitFor(`innerWidth === 390 && document.querySelector('.workbench-explorer.drawer')`)
  await setExplorerVisible(false)
  await setExplorerVisible(true)
  await waitFor(`document.querySelector('.workbench-explorer.drawer')?.getClientRects().length > 0`)
  await focusWorkspaceRoot()
  await captureVisibleInfo('workspace-root-mobile.png', true)
  await nativeKey('Escape', 'Escape', 27)
  await waitFor(`!document.querySelector('.workbench-explorer').getClientRects().length`)
  window.webContents.disableDeviceEmulation()
  await waitFor(`innerWidth > 1280 && document.querySelector('.folders-rail-toggle') && document.querySelector('.workbench-explorer:not(.drawer)')`)
  await clickSidebar('.self-reflection-toggle')
  await waitFor(`document.querySelectorAll('#self-reflection-conversations .session-select').length === 3`)
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('.folder-conversations .session-select, .legacy-chats .session-select')).some(node => /^Reflection fixture|^Soul reflection fixture|^Reflection child fixture/.test(node.getAttribute('aria-label')))`), false, 'Folder-associated reflection roots and descendants appear only in Self reflection')
  await clickSidebar('#self-reflection-conversations .session-select[aria-label="Reflection fixture (read-only)"]')
  await waitFor(`document.querySelector('#self-reflection-conversations .session-select[aria-label="Reflection fixture (read-only)"]')?.getAttribute('aria-current') === 'page'`)
  await setExplorerVisible(true)
  await waitFor(`document.querySelector('.file-tree-root-label')?.textContent === 'Home' && document.querySelector('.tree-row[data-path="memory.md"]')`)
  assert.equal(await evaluate(`document.querySelector('.file-tree-root').getAttribute('aria-label')`), `Home\n${reflectionHome}`, 'Reflection file browsing identifies backend Home, not its execution workdir')
  assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('.file-tree .tree-row'), node => node.dataset.path)`), ['agents', 'skills', 'memory.md'])
  await click('.tree-row[data-path="memory.md"]')
  await waitFor(`document.querySelector('.file-markdown')?.textContent.includes('Synthetic Home memory fixture.')`)
  assert.equal(previewRequests.at(-1)?.sessionId, 'heartbeat:reflector-fixture')
  await focusWorkspaceRoot(reflectionHome)
  await captureVisibleInfo('reflection-home-desktop.png')
  await nativeKey('Escape', 'Escape', 27)
  window.webContents.enableDeviceEmulation({ screenPosition: 'desktop', screenSize: { width: 390, height: 844 }, viewPosition: { x: 0, y: 0 }, viewSize: { width: 390, height: 844 }, deviceScaleFactor: 1, scale: 1 })
  await waitFor(`innerWidth === 390 && document.querySelector('.workbench-explorer.drawer')`)
  await setExplorerVisible(true)
  await waitFor(`document.querySelector('.workbench-explorer.drawer')?.getClientRects().length > 0`)
  await focusWorkspaceRoot(reflectionHome)
  await captureVisibleInfo('reflection-home-mobile.png', true)
  await nativeKey('Escape', 'Escape', 27)
  window.webContents.disableDeviceEmulation()
  await waitFor(`innerWidth > 1280 && document.querySelector('.workbench-explorer:not(.drawer)')`)
  await setExplorerVisible(true)
  await waitFor(`document.querySelector('.workbench-explorer:not(.drawer)')?.getClientRects().length > 0`)
  const descendantFilesStart = fileRequests.length
  await clickSidebar('#self-reflection-conversations .session-select[aria-label="Reflection child fixture (read-only)"]')
  for (let attempt = 0; attempt < 100 && !fileRequests.slice(descendantFilesStart).some(request => request.sessionId === 'agent:reflection-child'); attempt++) await new Promise(resolve => setTimeout(resolve, 20))
  assert.ok(fileRequests.slice(descendantFilesStart).some(request => request.sessionId === 'agent:reflection-child'), 'Selecting a reflection descendant requests its own Home listing before checking the shared Home label')
  await waitFor(`document.querySelector('.file-tree-root-label')?.textContent === 'Home' && document.querySelector('#self-reflection-conversations .session-select[aria-label="Reflection child fixture (read-only)"]').getAttribute('aria-current') === 'page'`)
  assert.equal(fileRequests.at(-1)?.sessionId, 'agent:reflection-child', 'Reflection descendants receive the same Home browser identity')
  await clickSidebar('.self-reflection-toggle')
  const stagesBeforeReflectionPoll = sessionStageRequests
  for (let attempt = 0; attempt < 100 && sessionStageRequests === stagesBeforeReflectionPoll; attempt++) await new Promise(resolve => setTimeout(resolve, 25))
  assert.ok(sessionStageRequests > stagesBeforeReflectionPoll, 'Session activity refresh reached the fixture')
  assert.equal(await evaluate(`document.querySelector('.self-reflection-toggle').getAttribute('aria-expanded') === 'false' && !document.querySelector('#self-reflection-conversations')`), true, 'Polling and an active reflection do not force the section open')
  await click('[aria-label="Collapse folders"]')
  await waitFor(`document.querySelector('.folders-sidebar.is-rail')`)
  assert.equal(await evaluate(`document.querySelectorAll('.self-reflection-toggle').length === 1 && !document.querySelector('#self-reflection-conversations')`), true, 'Rail retains one collapsed Self reflection section')
  await clickSidebar('.self-reflection-toggle')
  await waitFor(`document.querySelectorAll('#self-reflection-conversations .folder-session-row.icon-only').length === 2`)
  assert.equal(await evaluate(`document.querySelectorAll('#self-reflection-conversations .session-select').length`), 2, 'Expanded rail shows reflection root icons, not duplicate descendant icons')
  await click('[aria-label="Expand folders"]')
  await waitFor(`!document.querySelector('.folders-sidebar.is-rail') && document.querySelectorAll('#self-reflection-conversations .session-select').length === 3`)
  await clickSidebar('.folders-sidebar .session-select[aria-label="Empty free conversation"]')
  await waitFor(`document.querySelector('.file-tree-root-label')?.textContent === 'empty-free-workdir'`)
  const focusLongSession = async () => {
    await evaluate(`Array.from(document.querySelectorAll('.folders-sidebar .session-select')).find(node => node.getAttribute('aria-label') === ${JSON.stringify(longSessionTitle)}).scrollIntoView({ block: 'center' })`)
    await new Promise(resolve => setTimeout(resolve, 150))
    await evaluate(`(() => { const button = Array.from(document.querySelectorAll('.folders-sidebar .session-select')).find(node => node.getAttribute('aria-label') === ${JSON.stringify(longSessionTitle)}); button.blur(); button.focus(); })()`)
    await waitFor(`document.querySelector('.session-info-title')?.textContent === ${JSON.stringify(longSessionTitle)}`)
  }
  const assertLongSessionInfo = async () => {
    assert.equal(await evaluate(`(() => {
      const card = document.querySelector('.hover-info-popup'); const title = card.querySelector('.session-info-title');
      const description = card.querySelector('.session-info-description'); const id = card.querySelector('.session-info-id');
      const related = card.querySelector('.session-info-related'); const open = card.querySelector('.session-info-open');
      const lines = node => node.getBoundingClientRect().height / parseFloat(getComputedStyle(node).lineHeight);
      const rect = card.getBoundingClientRect(); const action = open.getBoundingClientRect();
      return title.textContent === ${JSON.stringify(longSessionTitle)} && getComputedStyle(title).webkitLineClamp === '2' && lines(title) <= 2.1
        && description.textContent === ${JSON.stringify(longSessionDescription)} && getComputedStyle(description).webkitLineClamp === '3' && lines(description) <= 3.1
        && id.textContent === ${JSON.stringify(idLong)} && getComputedStyle(id).textOverflow === 'ellipsis'
        && related.scrollHeight > related.clientHeight && related.clientHeight <= Math.min(204, innerHeight * .3) + 1
        && rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight
        && card.scrollWidth <= card.clientWidth && action.top >= rect.top && action.bottom <= rect.bottom;
    })()`), true, 'Long CJK/URL titles, descriptions, IDs and related lists remain bounded with visible navigation actions')
  }
  await focusLongSession()
  await assertLongSessionInfo()
  await captureVisibleInfo('sidebar-long-info-desktop.png')
  await nativeKey('ArrowRight', 'ArrowRight', 39)
  await waitFor(`document.activeElement.classList.contains('session-info-open')`)
  await nativeKey('Escape', 'Escape', 27)
  assert.equal(await evaluate(`document.activeElement.getAttribute('aria-label')`), longSessionTitle)
  window.webContents.enableDeviceEmulation({ screenPosition: 'desktop', screenSize: { width: 390, height: 844 }, viewPosition: { x: 0, y: 0 }, viewSize: { width: 390, height: 844 }, deviceScaleFactor: 1, scale: 1 })
  await waitFor(`innerWidth === 390`)
  await click('.mobile-sessions-toggle')
  await waitFor(`document.querySelector('.mobile-sessions-open') && !document.querySelector('.folders-sidebar.is-rail')`)
  await focusLongSession()
  await assertLongSessionInfo()
  await captureVisibleInfo('sidebar-long-info-mobile.png', true)
  await nativeKey('ArrowRight', 'ArrowRight', 39)
  await waitFor(`document.activeElement.classList.contains('session-info-open')`)
  await nativeKey('Escape', 'Escape', 27)
  await click('.mobile-sessions-toggle')
  window.webContents.disableDeviceEmulation()
  await waitFor(`innerWidth > 1280`)
  savedProviders.clear()
  providerStatus = { ready: false, provider: 'copilot', model: 'claude-sonnet-4.6@copilot', authMode: 'copilot', hasApiKey: false, reason: 'missing_credentials' }
  await window.loadURL(`${origin}/providers`)
  await waitFor(`document.querySelector('.setup-title')?.textContent.trim() === 'Connect a model provider'`)
  assert.equal(await evaluate(`document.querySelectorAll('.provider-card').length`), 0)
  assert.equal(await evaluate(`Boolean(document.querySelector('.provider-form .method-tabs [aria-pressed="true"]'))`), true)
  assert.deepEqual(unexpected, [])
  assert.equal(window.isVisible(), false)
  console.log(`LAYOUT_RESULT ${JSON.stringify({ ok: true, diagnosis: true, documentTabs: true, selectionMenu: true, folderDraftFiles: true, reflectionHome: true, workspaceRoots: true, boundedSidebarInfo: true, messageTimestamps: true, squareSurfaces: true, conversationWidthCaps: true, groupAuthors: true, traceRequests: traceQueries.length, screenshotDirectory: directory })}`)
}
async function cleanup(): Promise<void> {
  release?.()
  releaseInventory?.()
  releaseFilePreview?.()
  releaseAgentHistory?.()
  releaseFolderPreview?.()
  releaseFolderList?.()
  releaseGit?.()
  disposeDocumentShortcuts?.()
  if (window && !window.isDestroyed()) {
    if (focusEmulated && window.webContents.debugger.isAttached()) {
      await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: false })
      focusEmulated = false
    }
    if (window.webContents.debugger.isAttached()) window.webContents.debugger.detach()
    window.webContents.stop()
    window.webContents.disableDeviceEmulation()
    window.destroy()
  }
  realtime.close()
  await devServer?.close()
  server.closeAllConnections()
  if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}
void (async () => {
  let code = 0
  try { await main() } catch (error) { console.error(error); code = 1 }
  try { await cleanup() } catch (error) { console.error(error); code = 1 }
  app.exit(code)
})()
