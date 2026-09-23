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

test('background chips and sidebar delegated activity update without making an idle parent busy', {
  timeout: 90_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? 'Electron requires a display server.' : false,
}, async t => {
  const directory = resolve(root, '.test-artifacts', `background-activity-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  let phase = 'running'
  let parentStage = 'idle'
  let background = 'running'
  const server = await createServer({
    configFile: false, root: resolve(root, 'app'), logLevel: 'error', cacheDir: resolve(directory, 'vite-cache'),
    plugins: [vue(), UnoCSS({ configFile: resolve(root, 'app', 'unocss.config.ts') }), {
      name: 'background-activity',
      resolveId: id => id === '/activity.ts' ? '\0activity' : undefined,
      load(id) {
        if (id !== '\0activity') return
        return `import 'uno.css'; import '/src/styles.css';
          import { createApp, h } from 'vue';
          import { createRouter, createWebHistory } from 'vue-router';
          import Chat from '/src/components/ChatTab.vue';
          import ProjectGroup from '/src/components/ProjectGroup.vue';
          const router = createRouter({history:createWebHistory(),routes:[
            {name:'chat',path:'/projects/:projectId/chat/:sessionId',component:{}},
            {name:'project-settings',path:'/projects/:projectId/settings/:section',component:{}}
          ]});
          const subscriptions = new Set();
          window.__invalidate = () => { for (const observer of subscriptions) observer.reset?.('subscription'); };
          window.__navigate = sessionId => router.push({name:'chat',params:{projectId:'a',sessionId}});
          const app = createApp({setup() {
            return () => { const route = router.currentRoute.value;
              return h('div',{style:'display:flex;height:100vh;min-width:0'},[
                h('div',{id:'fixture-sidebar',style:'flex:0 0 280px;overflow:auto'},[
                  h(ProjectGroup,{apiBase:location.origin,project:{id:'a',name:'Fixture'},
                    selectedProjectId:'a',selectedSessionId:route.params.sessionId,navigationKey:route.fullPath,remoteFolders:false,
                    onSelect:window.__navigate})
                ]),
                h(Chat,{key:route.params.sessionId,managed:true,projectId:'a',sessionId:route.params.sessionId,
                  apiBase:location.origin+'/projects/a',visible:true,style:'flex:1;min-width:0',enableChildPane:true,
                  childSessionId:route.query.child,onOpenChild:target=>router.replace({query:{child:target.childId}}),
                  onNavigate:window.__navigate})
              ]);
            };
          }});
          app.provide(Symbol.for('shadow.live-client-pool'), {client:() => ({
            subscribe:(_topic,observer) => {
              subscriptions.add(observer);
              return {close(){subscriptions.delete(observer)},ready:async()=>{}};
            }
          })});
          app.use(router); await router.isReady(); app.mount('#app');`
      },
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          const url = new URL(request.url!, 'http://127.0.0.1')
          const path = url.pathname
          const json = (value: unknown, status = 200) => {
            response.statusCode = status
            response.setHeader('Content-Type', 'application/json')
            response.end(JSON.stringify(value))
          }
          if (/^\/projects\/a\/chat\/[^/]+$/.test(path)) {
            response.setHeader('Content-Type', 'text/html')
            response.end('<!doctype html><html><head><style>@media(max-width:700px){#fixture-sidebar{display:none}}</style></head><body style="margin:0"><div id="app"></div><script type="module" src="/activity.ts"></script></body></html>')
          } else if (path === '/fixture-state') {
            phase = url.searchParams.get('phase') ?? phase
            parentStage = url.searchParams.get('parent') ?? parentStage
            background = url.searchParams.get('background') ?? background
            json({ ok: true })
          } else if (path.endsWith('/api/sessions/graph')) {
            json({ nodes: [], sessions: [
              { sessionId: 'web:chat-owner', name: 'Owner conversation', mode: 'session' },
              { sessionId: 'web:chat-other', name: 'Other conversation', mode: 'session' },
              { sessionId: 'worker', name: 'Research worker', mode: 'task', parentSessionId: 'web:chat-owner', executionStatus: phase },
              { sessionId: 'leaf', name: 'Nested review', mode: 'call', parentSessionId: 'worker', executionStatus: phase === 'running' ? 'running' : 'completed' },
            ] })
          } else if (path.endsWith('/api/sessions/stages')) {
            json({ stages: { 'web:chat-owner': parentStage, 'web:chat-other': 'idle', worker: phase === 'waiting' ? 'waiting' : phase === 'pending' ? 'idle' : 'llm', leaf: 'tool' }, activeRequestIds: {}, recoveries: {} })
          } else if (path.endsWith('/background-tasks')) {
            const sessionId = decodeURIComponent(path.split('/').at(-2)!)
            if (background === 'error') { json({}, 503); return }
            const tasks = background === 'running' && sessionId === 'web:chat-owner' ? [{
              id: 'process-1', sessionId, kind: 'process', title: 'Build preview server', status: 'running', createdAt: '2026-09-23T00:00:00Z',
            }] : []
            json({ sessionId, total: tasks.length, tasks })
          } else if (path.endsWith('/api/folders')) json({ folders: [] })
          else if (path.endsWith('/api/chat/session')) json({ history: [], systemPrompt: '', tools: [] })
          else if (path.endsWith('/details')) {
            const sessionId = decodeURIComponent(path.split('/').at(-2)!)
            json({ sessionId, name: null, workdir: { kind: 'local', displayPath: '/synthetic' }, usage: null,
              usageScope: 'session', context: { usedTokens: null, windowTokens: null } })
          } else if (path.endsWith('/files')) json({ path: '', entries: [] })
          else if (path.endsWith('/git/status')) json({ available: false, reason: 'not_repository' })
          else if (/\/api\/sessions\/[^/]+$/.test(path)) json({ currentPhysicalId: 'segment', previousPhysicalId: null, messages: [] })
          else if (path.endsWith('/api/slash-commands')) json({ commands: [] })
          else if (path.includes('/api/')) json({})
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
  await build({ entryPoints: [resolve(root, 'desktop', 'tests', 'fixtures', 'background-activity-smoke.ts')],
    outfile: resolve(directory, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron'], logLevel: 'silent' })
  const env: NodeJS.ProcessEnv = { BACKGROUND_ACTIVITY_URL: url }
  for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'ComSpec', 'PATHEXT', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR']) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) env[key] = directory
  const child = spawn(desktopRequire('electron') as string, [resolve(directory, 'main.cjs')], { cwd: directory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { log += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { log += chunk })
  const timer = setTimeout(() => child.kill(), 75_000)
  t.after(() => { clearTimeout(timer); if (child.exitCode === null) child.kill() })
  const [code] = await once(child, 'close')
  assert.equal(code, 0, log)
  assert.match(log, /BACKGROUND_ACTIVITY_SMOKE_OK/)
})
