import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import vue from '@vitejs/plugin-vue'
import UnoCSS from 'unocss/vite'
import { createServer } from 'vite'
import { WebSocketServer } from 'ws'
import { pdfViewerAssets } from '../pdf-viewer-assets.ts'
import { RealtimeHub } from '../../src/realtime/hub.ts'
import { parseRealtimeTopics } from '../../src/realtime/protocol.ts'

const root = fileURLToPath(new URL('../..', import.meta.url))
const desktopRequire = createRequire(new URL('../../desktop/package.json', import.meta.url))
const { build } = desktopRequire('esbuild') as typeof import('esbuild')
const ids = ['web:chat-one', 'web:chat-two', 'bot:fixture:readonly']
const history = (transport: string, id: string) => [{ role: 'user', content: `${transport} snapshot ${id}` }]
const followUp = (id: string) => id === 'web:chat-two'
  ? { next: 'Review the fixture after the timer', after: 60, nextRun: null }
  : null
const details = (id: string) => ({ sessionId: id, name: id, workdir: { kind: 'local', displayPath: '/synthetic' },
  usage: null, usageScope: 'session', context: { usedTokens: null, windowTokens: null } })
const chat = (transport: string, id: string) => ({ chatId: id.replace(/^web:/, ''), currentPhysicalId: 'physical-fixture', previousPhysicalId: null,
  segmentIndex: 0, history: history(transport, id), tools: [], commandResults: [], decisionRecords: [], systemPrompt: '' })
const renderer = `import 'uno.css'; import '/src/styles.css';
  import {createLiveClientPool, liveTransportKey} from '/src/stores/live.ts';
  import {createLiveClient} from '/src/live-client.ts';
  import {createResourceApp} from '/src/stores/app.ts';
  import {createRouter,createMemoryHistory} from 'vue-router';
  import App from '/src/App.vue'; import ProjectsWorkspace from '/src/components/ProjectsWorkspace.vue';
  const router = createRouter({history:createMemoryHistory(),routes:[
    {path:'/projects/:projectId/chat/:sessionId?',name:'chat',component:ProjectsWorkspace},
    {path:'/settings/:section?',name:'settings',component:ProjectsWorkspace},
    {path:'/projects/:projectId/settings/:section?',name:'project-settings',component:ProjectsWorkspace},
    ...['projects','usage','nodes'].map(name=>({path:'/'+name,name,component:ProjectsWorkspace})),
    ...['board','dashboard','workflows'].map(page=>({path:'/projects/:projectId/'+page,name:'project-'+page,component:ProjectsWorkspace})),
  ]});
  await router.push('/projects/work/chat'); window.__fixtureRouter=router;
  const app = createResourceApp(App).use(router);
  if (new URLSearchParams(location.search).has('socket')) {
    // Cold handshake authentication is covered by the real Child/Main test.
    // Supply fixture credentials so this renderer test isolates warm switching.
    app.provide(liveTransportKey, createLiveClientPool((base, options) => createLiveClient(base, {
      ...options, ticket: async () => ['shadow.live.v1', 'ticket.00000000-0000-0000-0000-000000000000'],
    })));
  }
  app.mount('#app');`

for (const transport of ['HTTP', 'Socket']) test(`real Electron App warm conversation switch request counts (${transport})`, {
  timeout: 90_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? 'Electron requires a display server.' : false,
}, async t => {
  const directory = await mkdtemp(resolve(root, '.conversation-switch-'))
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  const onSocket = transport === 'Socket'
  const requests: string[] = []
  const sent: Array<{ type: string; conversations?: Array<{ sessionId: string }> }> = []
  const marks: Array<{ http: number; ws: number }> = []
  const hub = new RealtimeHub()
  const publisher = hub.registerProject('work', undefined, async id => ({ data: {
    chat: chat('Socket', id), details: details(id), inputDelivery: [], work: { records: [], effects: [] }, botSetup: { pending: false },
    backgroundTasks: { sessionId: id, total: 0, tasks: [] }, scheduledTasks: [], followUp: followUp(id),
  } }), () => {})
  t.after(() => hub.close())
  const server = await createServer({
    configFile: false, root: resolve(root, 'app'), logLevel: 'error', cacheDir: resolve(directory, 'vite-cache'),
    optimizeDeps: { include: ['vue', 'vue-router', 'vue-i18n'], entries: [], noDiscovery: true },
    plugins: [pdfViewerAssets(), vue(), UnoCSS({ configFile: resolve(root, 'app', 'unocss.config.ts') }), {
      name: 'conversation-switch-renderer',
      resolveId: id => id === '/conversation-switch-fixture.ts' ? '\0conversation-switch-fixture' : undefined,
      load: id => id === '\0conversation-switch-fixture' ? renderer : undefined,
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          const url = new URL(request.url!, 'http://fixture')
          const path = url.pathname.replace(/^\/projects\/[^/]+(?=\/api\/)/, '')
          if (path === '/__switch-mark') { marks.push({ http: requests.length, ws: sent.length }); response.end('ok'); return }
          if (path === '/__follow-up-clear') {
            publisher.chat('web:chat-two', { event: 'conversation_summary', data: { followUp: null } })
            response.end('ok'); return
          }
          if (path === '/__switch') {
            response.setHeader('Content-Type', 'text/html')
            response.end('<!doctype html><div id="app"></div><script type="module" src="/conversation-switch-fixture.ts"></script>'); return
          }
          if (!path.startsWith('/api/')) return next()
          requests.push(`${request.method} ${path}`)
          const json = (data: unknown, status = 200) => {
            const body = JSON.stringify(data)
            response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) })
            response.end(body)
          }
          if (path === '/api/live/ws') return onSocket ? json({ protocol: 'shadow.live.v1', proof: 'ticket.00000000-0000-0000-0000-000000000000' }) : json({})
          if (path === '/api/live') {
            const abort = new AbortController()
            response.once('close', () => abort.abort())
            const stream = hub.connect(parseRealtimeTopics(url.searchParams.get('topics') ?? undefined), abort.signal, url.searchParams.get('cursor') ?? undefined)
            response.writeHead(stream.status, Object.fromEntries(stream.headers))
            Readable.fromWeb(stream.body!).on('error', () => response.destroy()).pipe(response)
            return
          }
          if (path === '/api/projects/work/status') return json({ state: 'ready' })
          if (path === '/api/credential-requests') return json({ request: null })
          if (path === '/api/audio/status') return json({ asr: { ready: false, route: 'local' }, tts: { ready: false, route: 'local' } })
          if (path === '/api/projects') return json({ projects: [{ id: 'work', name: 'Workspace', createdAt: '' }] })
          if (path === '/api/web-auth/session') return json({ version: 1, required: false, authenticated: true })
          if (path === '/api/provider/configured') return json({ providers: [] })
          if (path === '/api/provider/setup') return json({ provider: 'openai', model: 'gpt-test', ready: true, hasApiKey: false, authMode: 'none' })
          if (path === '/api/models') return json({ models: ['gpt-test'] })
          if (path === '/api/config') return json({ agent: { model: 'gpt-test', workspace: 'synthetic', temperature: 0.5 } })
          if (path === '/api/chat/commands') return json({ commands: [] })
          if (path === '/api/folders') return json({ folders: [] })
          if (path === '/api/io/clients') return json({ clientToken: 'fixture' })
          if (path === '/api/io/runs') return json({ runs: [] })
          if (path === '/api/sessions/summary') return json({ sessions: ids.map(sessionId => ({ sessionId, title: sessionId })), nodes: [] })
          if (path === '/api/sessions/stages') return json({ activity: {} })
          if (path === '/api/bot-chat-setup/request') return json({ request: null })
          if (path === '/api/chat/session') return json({ revision: 'a'.repeat(64), historyRevision: 'b'.repeat(64),
            metadataVersions: Object.fromEntries(['systemPrompt', 'tools', 'commandResults', 'decisionRecords'].map(field => [field, 'c'.repeat(64)])),
            data: chat('HTTP', `web:${url.searchParams.get('chatId')}`) })
          const match = /^\/api\/sessions\/([^/]+)(?:\/(.*))?$/.exec(path)
          if (match) {
            const id = decodeURIComponent(match[1]!)
            switch (match[2]) {
              case undefined: return json({ ...chat('HTTP', id), messages: history('HTTP', id) })
              case 'details': return json(details(id))
              case 'work': return json({ records: [], effects: [] })
              case 'input-delivery': return json([])
              case 'follow-up': return json({ sessionId: id, followUp: followUp(id) })
              case 'scheduled-tasks': return json({ sessionId: id, tasks: [] })
              case 'background-tasks': return json({ sessionId: id, total: 0, tasks: [] })
            }
          }
          return json({}) // Unrelated bootstrap APIs are not the target of this fixture.
        })
      },
    }], server: { host: '127.0.0.1', port: 0 },
  })
  let upgrades = 0
  if (onSocket) {
    const sockets = new WebSocketServer({ noServer: true, handleProtocols: () => 'shadow.live.v1' })
    server.httpServer!.on('upgrade', (request, socket, head) => {
      if (request.url !== '/api/live/ws') return
      sockets.handleUpgrade(request, socket, head, client => {
        upgrades++
        client.on('message', raw => sent.push(JSON.parse(raw.toString())))
        hub.connectSocket(client, () => true)
      })
    })
    t.after(() => { for (const client of sockets.clients) client.terminate(); sockets.close() })
  }
  await server.listen()
  t.after(() => server.close())
  await build({ entryPoints: [resolve(root, 'desktop/tests/fixtures/conversation-switch-smoke.ts')], outfile: resolve(directory, 'main.cjs'),
    bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron'], logLevel: 'silent' })
  const env: NodeJS.ProcessEnv = { CONVERSATION_SMOKE_TRANSPORT: transport, CONVERSATION_SMOKE_URL: new URL(onSocket ? '/__switch?socket' : '/__switch', server.resolvedUrls!.local[0]!).href }
  for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR']) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) env[key] = directory
  const child = spawn(desktopRequire('electron') as string, [resolve(directory, 'main.cjs')], { cwd: directory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk })
  const timer = setTimeout(() => child.kill(), 75_000)
  t.after(() => { clearTimeout(timer); if (child.exitCode === null) child.kill() })
  const [code] = await once(child, 'close')
  assert.equal(code, 0, `${output}\nAPI requests: ${JSON.stringify(requests)}\nWS: ${JSON.stringify(sent)}`)
  assert.equal(marks.length, 3)
  const hot = /(?:\/api\/(?:live(?:\/ws)?|chat\/(?:session|presence)|models|bot-chat-setup\/request)$|\/api\/sessions\/[^/]+(?:\/(?:details|input-delivery|work|follow-up|background-tasks|scheduled-tasks))?$)/
  for (const [index, id] of ids.slice(1).entries()) {
    const traffic = requests.slice(marks[index]!.http, marks[index + 1]!.http).filter(request => hot.test(request) && !/\/api\/sessions\/(summary|stages)$/.test(request))
    const commands = sent.slice(marks[index]!.ws, marks[index + 1]!.ws).filter(frame => frame.type !== 'presence')
    t.diagnostic(`${id}: ${JSON.stringify({ http: traffic, ws: commands.map(frame => frame.type) })}`)
    if (onSocket) {
      assert.deepEqual(traffic, [])
      assert.deepEqual(commands.map(frame => [frame.type, frame.conversations?.map(topic => topic.sessionId)]), [['openConversation', [id]]])
    } else assert.ok(traffic.some(path => path === 'GET /api/chat/session' || path.endsWith(encodeURIComponent(id))))
  }
  assert.equal(upgrades, onSocket ? 1 : 0)
})
