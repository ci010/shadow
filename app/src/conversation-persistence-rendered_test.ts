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

test('real composer and diagnosis selections survive page reload and preserve session isolation', {
  timeout: 90_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? 'Electron requires a display server.' : false,
}, async t => {
  const directory = resolve(root, '.test-artifacts', `persistence-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  let rejectSend = false
  const html = '<!doctype html><html><body style="margin:0">Synthetic HTML preview</body></html>'
  const server = await createServer({
    configFile: false, root: resolve(root, 'app'), logLevel: 'error', cacheDir: resolve(directory, 'vite-cache'),
    plugins: [vue(), UnoCSS({ configFile: resolve(root, 'app', 'unocss.config.ts') }), {
      name: 'conversation-persistence',
      resolveId: id => id === '/persistence.ts' ? '\0persistence' : undefined,
      load(id) {
        if (id !== '\0persistence') return
        return `import 'uno.css'; import '/src/styles.css';
          import { createApp, h, ref, watch } from 'vue';
          import { createRouter, createWebHistory } from 'vue-router';
          import Chat from '/src/components/ChatTab.vue';
          const router = createRouter({history:createWebHistory(),routes:[
            {name:'chat',path:'/projects/:projectId/chat/:sessionId?',component:{}},
            {name:'project-settings',path:'/projects/:projectId/settings/:section?',component:{}},
            {name:'agents',path:'/projects/:projectId/agents',component:{}},
            {name:'settings',path:'/settings/:section?',component:{}}
          ]});
          const app = createApp({setup() {
            const sessionId = ref('');
            watch(router.currentRoute, route => {
              if (route.name === 'chat') sessionId.value = route.params.sessionId || '';
            }, {immediate:true});
            return () => { const route = router.currentRoute.value;
              return h(Chat, {key:sessionId.value || 'draft', managed:true, projectId:route.params.projectId,
                sessionId:sessionId.value, apiBase:location.origin + '/projects/' + route.params.projectId,
                visible:true, style:'height:100vh',
                knowledgeRequest:route.query.panel === 'knowledge' ? {entryId:route.query.entry} : undefined,
                onPrepared:sessionId => router.replace({name:'chat',params:{projectId:route.params.projectId,sessionId}}),
                onKnowledgeNavigation:(active, entry) => {
                  if (active) router.replace({query:{...route.query,panel:'knowledge',entry,diagnosis:undefined}});
                  else if (route.query.panel === 'knowledge') router.replace({query:{...route.query,panel:undefined,entry:undefined}});
                },
              });
            };
          }});
          app.provide(Symbol.for('shadow.live-client-pool'), {client:() => ({
            subscribe:() => ({close(){},ready:async()=>{}})
          })});
          app.use(router); await router.isReady(); app.mount('#app');
          window.__navigate = url => router.push(url);`
      },
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          const url = new URL(request.url!, 'http://127.0.0.1')
          const path = url.pathname
          const json = (value: unknown, status = 200) => {
            response.statusCode = status
            response.setHeader('Content-Type', 'application/json')
            response.end(JSON.stringify(value))
          }
          if (/^\/projects\/[^/]+\/chat(?:\/[^/]+)?$/.test(path)) {
            response.setHeader('Content-Type', 'text/html')
            response.end('<!doctype html><html><body style="margin:0"><div id="app"></div><script type="module" src="/persistence.ts"></script></body></html>')
          } else if (path === '/fixture-reject') { rejectSend = url.searchParams.get('value') === 'true'; json({ ok: true }) }
          else if (path.endsWith('/api/sessions/graph')) json({ sessions: ['web:chat-one', 'web:chat-two'].map(sessionId => ({ sessionId, mode: 'session' })), nodes: [] })
          else if (path.endsWith('/api/sessions/stages')) json({ stages: {}, activeRequestIds: {}, recoveries: {} })
          else if (path.endsWith('/api/chat/session')) json({ history: [{ role: 'assistant', content: '[Preview layout](layout.html)' }], systemPrompt: 'Synthetic persisted system prompt', tools: [] })
          else if (path.endsWith('/static/layout.html')) {
            response.setHeader('Content-Type', 'text/html')
            response.end(html)
          }
          else if (path.endsWith('/preview')) json({ content: html, size: Buffer.byteLength(html), sourcePath: 'layout.html', binary: false })
          else if (path.endsWith('/publication-requests')) json({ request: null, requests: [] })
          else if (path.endsWith('/probe-requests')) json({ requests: [] })
          else if (path.endsWith('/background-tasks')) json({ sessionId: 'web:chat-one', total: 0, tasks: [] })
          else if (path.endsWith('/api/chat/send')) {
            const chunks: Buffer[] = []
            for await (const chunk of request) chunks.push(Buffer.from(chunk))
            const body = JSON.parse(Buffer.concat(chunks).toString())
            json(rejectSend ? { error: 'synthetic send failure' } : { chatId: body.chatId, requestId: 'request-fixture' }, rejectSend ? 503 : 200)
          } else if (path.endsWith('/details')) {
            const sessionId = decodeURIComponent(path.split('/').at(-2)!)
            json({ sessionId, name: null, workdir: { kind: 'local', displayPath: '/synthetic' }, usage: null,
              usageScope: 'session', context: { usedTokens: null, windowTokens: null } })
          } else if (path.endsWith('/files')) json({ path: '', entries: [] })
          else if (path.endsWith('/api/projects')) json({ projects: [{ id: 'a', name: 'Project A', createdAt: '2026-01-01T00:00:00Z' }] })
          else if (path.endsWith('/api/config')) json({ agent: { model: 'synthetic', workspace: '/synthetic', temperature: 0.7 } })
          else if (path.endsWith('/git/status')) json({ available: false, reason: 'not_repository' })
          else if (path.endsWith('/v1/query/session-spans')) json({ sessionId: url.searchParams.get('sessionId'), physicalSessionId: 'segment', hasMore: false, entries: [] })
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
  await build({ entryPoints: [resolve(root, 'desktop', 'tests', 'fixtures', 'conversation-persistence-smoke.ts')],
    outfile: resolve(directory, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron'], logLevel: 'silent' })
  const env: NodeJS.ProcessEnv = { PERSISTENCE_URL: url }
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
  assert.match(log, /PERSISTENCE_SMOKE_OK/)
})
