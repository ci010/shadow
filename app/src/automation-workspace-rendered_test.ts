import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import UnoCSS from 'unocss/vite'

const root = fileURLToPath(new URL('../..', import.meta.url))
const desktopRequire = createRequire(new URL('../../desktop/package.json', import.meta.url))
const { build } = desktopRequire('esbuild') as typeof import('esbuild')

test('automations open ordinary conversations and navigate run history without a runs explorer or run tabs', {
  timeout: 90_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? 'Electron requires a display server.' : false,
}, async t => {
  const directory = resolve(root, '.test-artifacts', `automations-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  const automation = { id: 'cron:weekly', name: 'Encapsulation', source: 'learning', session: 'fresh', schedule: '0 9 * * 1', task: 'Review recent work', enabled: true }
  const runs = Array.from({ length: 65 }, (_, index) => ({
    id: `run-${index}`, sessionId: `cron:run-${index}`, startedAt: new Date(Date.UTC(2026, 8, 30, 0, -index)).toISOString(),
    status: 'completed', title: `Saved conversation ${index} ${'Long prompt text '.repeat(20)}`,
    ...(index === 0 ? { learning: { status: 'partial', summary: 'One conditional decision persisted; a source page still needs review.', artifacts: 1, events: 1, evaluated: 0 } } : {}),
  }))
  const offsets: number[] = []
  const fileRequests: string[] = []
  const changeRequests: string[] = []
  const unexpected: string[] = []
  let hold = true
  let holdHistory = true
  let failRuns = false
  let emptyRuns = false
  const pending: (() => void)[] = []
  const pendingHistory: (() => void)[] = []
  let server: Awaited<ReturnType<typeof createServer>> | undefined
  t.after(async () => {
    pending.splice(0).forEach(send => send())
    pendingHistory.splice(0).forEach(send => send())
    if (server) {
      server.httpServer?.closeAllConnections()
      await server.watcher.close()
      await server.close()
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 })
  })
  server = await createServer({
    configFile: false, root: resolve(root, 'app'), logLevel: 'error', cacheDir: resolve(directory, 'vite-cache'),
    optimizeDeps: { noDiscovery: true, exclude: ['emf-converter', '@napi-rs/canvas'],
      include: ['vue', 'vue-router', 'marked', 'dompurify', 'zod', 'katex', '@open-file-viewer/core', '@monaco-editor/loader'] },
    plugins: [vue(), UnoCSS({ configFile: resolve(root, 'app', 'unocss.config.ts') }), {
      name: 'automation-workspace-fixture',
      resolveId: id => id === '/automations-fixture.ts' ? '\0automations-fixture' : id === 'virtual:shadow-pdf-assets' ? '\0fixture-pdf-assets' : undefined,
      load(id) {
        if (id === '\0fixture-pdf-assets') return 'export const cMapUrl = "", standardFontDataUrl = "", wasmUrl = "";'
        if (id !== '\0automations-fixture') return
        return `import 'uno.css'; import '/src/styles.css';
          import { createApp, h } from 'vue';
          import { createRouter, createMemoryHistory } from 'vue-router';
          import ProjectsWorkspace from '/src/components/ProjectsWorkspace.vue';
          import { ioBridgeKey, createIoBridge } from '/src/io/bridge.ts';
          const router = createRouter({history:createMemoryHistory(),routes:[
            {name:'chat',path:'/projects/:projectId/chat/:sessionId?',component:{}},
            {name:'projects',path:'/projects',component:{}},
            {name:'project-settings',path:'/projects/:projectId/settings/:section?',component:{}},
            {name:'agents',path:'/projects/:projectId/agents',component:{}},
            {name:'settings',path:'/settings/:section?',component:{}},
          ]});
          await router.push({name:'chat',params:{projectId:'fixture'},query:{automation:'cron:weekly'}});
          const app = createApp({render:() => h(ProjectsWorkspace,{apiBase:location.origin,visible:true})});
          app.provide(Symbol.for('shadow.live-client-pool'),{client:() => ({
            subscribe:() => ({close(){},ready:async()=>{}})
          })});
          app.provide(ioBridgeKey, createIoBridge());
          app.use(router).mount('#app');
          window.__automationRouter = router;`
      },
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          const url = new URL(request.url!, 'http://fixture')
          const path = url.pathname.replace(/^\/projects\/fixture/, '')
          const json = (value: unknown, status = 200) => {
            if (response.destroyed) return
            response.statusCode = status
            response.setHeader('Content-Type', 'application/json')
            response.end(JSON.stringify(value))
          }
          if (path === '/__automations') {
            response.setHeader('Content-Type', 'text/html')
            response.end('<!doctype html><html class="dark"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="app" style="height:100dvh;display:flex"></div><script type="module" src="/automations-fixture.ts"></script></body></html>')
          } else if (path === '/__fixture/stats') json({ changes: changeRequests.length, offsets })
          else if (path === '/__fixture/hold') { hold = true; json({ ok: true }) }
          else if (path === '/__fixture/release' || path === '/__fixture/fail') {
            hold = false
            failRuns = path.endsWith('/fail')
            pending.splice(0).forEach(send => send())
            json({ ok: true })
          } else if (path === '/__fixture/empty') { emptyRuns = true; json({ ok: true }) }
          else if (path === '/__fixture/history') {
            holdHistory = false
            pendingHistory.splice(0).forEach(send => send())
            json({ ok: true })
          } else if (path === '/api/projects') json({ projects: [{ id: 'fixture', name: 'Fixture project', createdAt: '' }] })
          else if (path === '/api/automations') {
            const send = () => json({ automations: [automation] })
            if (hold) pending.push(send)
            else send()
          } else if (path.endsWith('/runs')) {
            const offset = Number(url.searchParams.get('offset'))
            offsets.push(offset)
            const send = () => json(failRuns ? { error: 'Synthetic unavailable history' } : { runs: emptyRuns ? [] : runs.slice(offset, offset + 30), total: emptyRuns ? 0 : runs.length, offset }, failRuns ? 503 : 200)
            if (hold) pending.push(send)
            else send()
          } else if (path === '/api/sessions/graph') json({ sessions: [...runs.map(run => ({
            sessionId: run.sessionId, title: run.title, mode: 'session',
            automation: { contextMode: 'fresh', jobId: automation.id, name: automation.name, runId: run.id, startedAt: run.startedAt },
          })), { sessionId: 'web:ordinary', title: 'Ordinary conversation', mode: 'session' }], nodes: [] })
          else if (path === '/api/sessions/stages') json({ stages: {}, activeRequestIds: {}, recoveries: {} })
          else if (path === '/api/folders') json({ folders: [] })
          else if (path === '/api/channels') json({ channels: [] })
          else if (path === '/api/config') json({ agent: { model: 'fixture:model', workspace: 'synthetic', temperature: 0.7 } })
          else if (path === '/debug/models') json({ models: ['fixture:model'] })
          else if (path.endsWith('/details')) {
            const sessionId = decodeURIComponent(path.split('/').at(-2)!)
            json({ sessionId, name: 'Saved run', workdir: { kind: 'local', displayPath: 'C:\\synthetic' }, usage: null,
              usageScope: 'session', context: { usedTokens: null, windowTokens: null } })
          } else if (path.endsWith('/file-changes')) {
            changeRequests.push(path)
            json({ error: 'Write history has no standalone UI consumer' }, 500)
          } else if (/\/api\/sessions\/[^/]+$/.test(path)) {
            const sessionId = decodeURIComponent(path.split('/').at(-1)!)
            const segment = sessionId === 'compact:run-1'
            const send = () => json({ currentPhysicalId: 'segment', previousPhysicalId: !segment && sessionId === 'cron:run-1' ? 'compact:run-1' : null, messages: [
              { role: 'user', content: `Synthetic run input ${sessionId}` }, { role: 'assistant', content: `Synthetic run result ${sessionId}` },
            ] })
            if (holdHistory) pendingHistory.push(send)
            else send()
          } else if (path.endsWith('/context')) json({ systemPrompt: 'Synthetic context', tools: [] })
          else if (path.endsWith('/work')) json({ records: [], effects: [] })
          else if (path.endsWith('/files') || path.endsWith('/git/status')) {
            if (!path.includes('web%3Aordinary')) fileRequests.push(path)
            json(path.endsWith('/files') ? { path: '', entries: [] } : { available: false, reason: 'not_repository', entries: [] })
          } else if (path.endsWith('/api/slash-commands')) json({ commands: [] })
          else if (path.endsWith('/background-tasks')) json({ total: 0, tasks: [] })
          else if (path.endsWith('/publication-requests')) json({ request: null, requests: [] })
          else if (path.endsWith('/probe-requests')) json({ requests: [] })
          else if (path.startsWith('/api/') || path.startsWith('/debug/')) { unexpected.push(path); json({ error: 'Unstubbed fixture request' }, 404) }
          else next()
        })
      },
    }],
    server: { host: '127.0.0.1', port: 0, watch: null },
  })
  await server.listen()
  const url = server.resolvedUrls?.local[0]
  assert.ok(url)
  await build({
    entryPoints: [resolve(root, 'desktop', 'tests', 'fixtures', 'automation-workspace-smoke.ts')],
    outfile: resolve(directory, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs',
    target: 'node24', external: ['electron'], logLevel: 'silent',
  })
  const env: NodeJS.ProcessEnv = { AUTOMATION_SMOKE_URL: url, AUTOMATION_SCREENSHOTS: process.env.AUTOMATION_SCREENSHOTS }
  for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'ComSpec', 'PATHEXT', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR']) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) env[key] = directory
  const child = spawn(desktopRequire('electron') as string, [resolve(directory, 'main.cjs')], {
    cwd: directory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk })
  const timer = setTimeout(() => child.kill(), 75_000)
  t.after(() => { clearTimeout(timer); if (child.exitCode === null) child.kill() })
  const [code] = await once(child, 'close')
  if (code !== 0) process.stderr.write(output)
  assert.equal(code, 0, output)
  assert.match(output, /AUTOMATION_WORKSPACE_OK/)
  assert.ok(offsets.includes(30))
  assert.ok(offsets.includes(60), 'Deep links can resolve runs beyond the first two pages')
  assert.ok(fileRequests.length > 0, 'Run conversations use the ordinary file explorer defaults')
  assert.deepEqual(changeRequests, [], 'Removing the changes UI must also remove its requests')
  assert.deepEqual(unexpected, [])
})
