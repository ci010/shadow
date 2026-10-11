import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, rm, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import UnoCSS from 'unocss/vite'
import { pdfViewerAssets } from '../pdf-viewer-assets.ts'

const root = fileURLToPath(new URL('../..', import.meta.url))
const desktopRequire = createRequire(new URL('../../desktop/package.json', import.meta.url))
const { build } = desktopRequire('esbuild') as typeof import('esbuild')

test('Ctrl+F searches real conversations across all segments, split panes and lifecycle changes', {
  timeout: 90_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? 'Electron requires a display server.' : false,
}, async t => {
  const directory = resolve(root, '.test-artifacts', `conversation-search-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  const current = [
    { role: 'user', content: '当前消息：中文搜索，特殊符号 .*[b]。', timestamp: '2026-10-01T01:00:00Z' },
    { role: 'assistant', content: 'Current **historical** match. [Open file](note.md)', timestamp: '2026-10-01T01:01:00Z' },
  ]
  const histories: Record<string, { messages: unknown[]; previousPhysicalId: string | null }> = {
    'web:chat-one': { messages: current, previousPhysicalId: 'physical:middle' },
    'physical:middle': { messages: [{ role: 'user', name: '__compaction_summary__', content: 'Collapsed historical summary.' }], previousPhysicalId: 'physical:oldest' },
    'physical:oldest': { messages: [
      { role: 'user', content: 'An older his**torical** message and HISTORICAL again.' },
      ...Array.from({ length: 40 }, (_, i) => ({ role: 'assistant', content: `Synthetic filler message ${i}.` })),
      { role: 'assistant', content: 'Last old message.' },
    ], previousPhysicalId: null },
    'web:child': { messages: [{ role: 'assistant', content: 'Child-only searchable text.' }], previousPhysicalId: null },
    'web:chat-two': { messages: [{ role: 'assistant', content: 'Second conversation.' }], previousPhysicalId: null },
  }
  let failHistory = false
  const searchReads: string[] = []
  const server = await createServer({
    configFile: false, root: resolve(root, 'app'), logLevel: 'error', cacheDir: resolve(directory, 'vite-cache'),
    optimizeDeps: { noDiscovery: true, exclude: ['emf-converter', '@napi-rs/canvas'],
      include: ['vue', 'vue-router', 'marked', 'dompurify', 'zod', 'katex', '@open-file-viewer/core', '@monaco-editor/loader'] },
    plugins: [pdfViewerAssets(), vue(), UnoCSS({ configFile: resolve(root, 'app', 'unocss.config.ts') }), {
      name: 'synthetic-conversation-search',
      resolveId: id => id === '/search-fixture.ts' ? '\0search-fixture' : undefined,
      load(id) {
        if (id !== '\0search-fixture') return
        return `import 'uno.css'; import '/src/styles.css';
          import {createApp, h, reactive, ref} from 'vue';
          import {createRouter, createMemoryHistory} from 'vue-router';
          import ChatWorkspace from '/src/components/ChatWorkspace.vue';
          const router = createRouter({history:createMemoryHistory(), routes:[
            {name:'chat',path:'/projects/:projectId/chat/:sessionId?',component:{}}
          ]});
          await router.push('/projects/fixture/chat/web:chat-one');
          const state = reactive({visible:true, sessionId:'web:chat-one', childSessionId:''});
          const workspace = ref();
          window.__searchFixture = {state, select:id => {
            state.sessionId=id;
            workspace.value.$refs.primary.restoreSession(id);
          }};
          const app = createApp({render:() => h(ChatWorkspace, {
            ref:workspace,
            apiBase:location.origin + '/projects/fixture/', projectId:'fixture', managed:true,
            sessionId:state.sessionId, childSessionId:state.childSessionId, visible:state.visible,
            style:'height:100dvh',
          })});
          app.provide(Symbol.for('shadow.live-client-pool'), {client:() => ({
            subscribe:() => ({close(){},ready:async()=>{}})
          })});
          app.use(router).mount('#app');`
      },
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          const url = new URL(request.url!, 'http://fixture')
          const path = url.pathname
          const json = (value: unknown, status = 200) => {
            response.statusCode = status
            response.setHeader('Content-Type', 'application/json')
            response.end(JSON.stringify(value))
          }
          if (path === '/__search') {
            response.setHeader('Content-Type', 'text/html')
            response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="/search-fixture.ts"></script></body></html>')
          } else if (path === '/__fail') { failHistory = url.searchParams.get('value') === 'true'; json({ ok: true }) }
          else if (path.endsWith('/api/sessions/graph')) json({ sessions: ['web:chat-one', 'web:child', 'web:chat-two'].map(sessionId => ({ sessionId, mode: 'session' })), nodes: [] })
          else if (path.endsWith('/api/sessions/stages')) json({ stages: {}, activeRequestIds: {}, recoveries: {} })
          else if (path.endsWith('/api/chat/session')) json({ history: histories[`web:${url.searchParams.get('chatId')}`]?.messages ?? [], systemPrompt: '', tools: [] })
          else if (/\/api\/sessions\/[^/]+$/.test(path)) {
            const key = decodeURIComponent(path.split('/').at(-1)!)
            searchReads.push(key)
            if (failHistory && key === 'physical:oldest') json({ error: 'Synthetic history failure' }, 503)
            else json({ key, currentPhysicalId: 'physical:current', ...histories[key], commandResults: [], decisionRecords: [] })
          } else if (path.endsWith('/details')) json({ sessionId: decodeURIComponent(path.split('/').at(-2)!), name: null,
            workdir: { kind: 'local', displayPath: 'C:\\synthetic' }, usage: null, usageScope: 'session', context: { usedTokens: null, windowTokens: null } })
          else if (path.endsWith('/files')) json({ path: '', entries: [] })
          else if (path.endsWith('/git/status')) json({ available: false, reason: 'not_repository' })
          else if (path.endsWith('/publication-requests')) json({ request: null, requests: [] })
          else if (path.endsWith('/probe-requests')) json({ requests: [] })
          else if (path.endsWith('/background-tasks')) json({ total: 0, tasks: [] })
          else if (path.endsWith('/api/slash-commands')) json({ commands: [] })
          else if (/^\/(?:projects\/[^/]+\/)?(?:api|debug|v1)\//.test(path)) json({})
          else next()
        })
      },
    }],
    server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  t.after(() => server.close())
  const url = server.resolvedUrls?.local[0]
  assert.ok(url)
  const originalSmoke = await readFile(resolve(root, 'desktop', 'tests', 'fixtures', 'conversation-search-smoke.ts'), 'utf8')
  const geometryMarker = "    assert.equal(await key('f', 'ctrlKey:true'), false, 'Ctrl+F is handled, not passed to browser find')"
  assert.ok(originalSmoke.includes(geometryMarker), 'Search fixture must retain the geometry injection point')
  const smoke = originalSmoke.replace(geometryMarker, `    const beforeSearch = await execute("JSON.stringify([...document.querySelector('.chat-messages').getClientRects()].map(r=>[r.x,r.y,r.width,r.height]))")
    assert.equal(await key('f', 'ctrlKey:true'), false, 'Ctrl+F is handled, not passed to browser find')
    await wait("!!document.querySelector('.conversation-search')")
    assert.equal(await execute("JSON.stringify([...document.querySelector('.chat-messages').getClientRects()].map(r=>[r.x,r.y,r.width,r.height]))"), beforeSearch, 'Real chat message geometry stays stable')`)
  await build({ stdin: { contents: smoke, loader: 'ts', resolveDir: resolve(root, 'desktop/tests/fixtures') },
    outfile: resolve(directory, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron'], logLevel: 'silent' })
  const env: NodeJS.ProcessEnv = { CONVERSATION_SEARCH_URL: url, CONVERSATION_SEARCH_SCREENSHOT_DIR: process.env.CONVERSATION_SEARCH_SCREENSHOT_DIR }
  for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'ComSpec', 'PATHEXT', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR']) {
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
  assert.equal(code, 0, output)
  assert.match(output, /CONVERSATION_SEARCH_OK/)
  assert.ok(searchReads.includes('physical:oldest'))
})
