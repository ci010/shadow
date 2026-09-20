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

test('real App mobile navigation, conversation headers, drafts, sheets and touch gestures', {
  timeout: 180_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? 'Electron requires a display server.' : false,
}, async t => {
  const directory = resolve(root, '.test-artifacts', `mobile-navigation-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  const unexpected: string[] = []
  const requests: string[] = []
  const names = new Map([['web:chat-one', 'First investigation'], ['web:chat-two', 'Second investigation']])
  const history = [{ role: 'user', content: 'Investigate the mobile layout.' }, { role: 'assistant', content: 'Synthetic reply: ready to continue. ' + 'Long replies should use the available phone width without reserving desktop navigation gutters. '.repeat(8) }]
  const server = await createServer({
    configFile: false, root: resolve(root, 'app'), logLevel: 'error',
    plugins: [vue(), UnoCSS({ configFile: resolve(root, 'app', 'unocss.config.ts') }), {
      name: 'synthetic-mobile-navigation',
      resolveId: id => id === '/mobile-fixture.ts' ? '\0mobile-fixture' : undefined,
      load(id) {
        if (id !== '\0mobile-fixture') return
        return `import 'uno.css'; import '/src/styles.css';
          import { createApp, h } from 'vue';
          import { createRouter, createMemoryHistory } from 'vue-router';
          import App from '/src/App.vue';
          import ProjectsWorkspace from '/src/components/ProjectsWorkspace.vue';
          const destination = { render:() => h('section', {class:'fixture-destination'}, 'Synthetic route destination') };
          const router = createRouter({history:createMemoryHistory(), routes:[
            {path:'/chat', redirect:'/projects/work/chat/web%3Achat-one'},
            {path:'/projects/:projectId/chat/:sessionId?', name:'chat', component:ProjectsWorkspace},
            {path:'/projects', name:'projects', component:ProjectsWorkspace},
            {path:'/nodes', name:'nodes', component:destination},
            {path:'/settings/:section?', name:'settings', component:destination},
            {path:'/projects/:projectId/settings/:section?', name:'project-settings', component:destination},
            ...['agents','spans','logs'].map(name => ({path:'/projects/:projectId/' + name, name, component:destination})),
          ]});
          await router.push('/projects/work/chat/web%3Achat-one');
          window.__mobileFixture = {router, errors:[]};
          addEventListener('error', event => window.__mobileFixture.errors.push(event.message));
          addEventListener('unhandledrejection', event => window.__mobileFixture.errors.push(String(event.reason)));
          const app = createApp(App);
          app.provide(Symbol.for('shadow.live-client-pool'), {
            client:() => ({subscribe:() => ({close(){}})}),
            observe:fn => { fn([]); return () => {} }, retry(){}, dispose(){},
          });
          app.use(router).mount('#app');`
      },
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          const url = new URL(request.url!, 'http://fixture')
          if (url.pathname === '/__mobile') {
            response.setHeader('Content-Type', 'text/html')
            response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="app"></div><script type="module" src="/mobile-fixture.ts"></script></body></html>')
            return
          }
          const scope = url.pathname.match(/^\/projects\/([^/]+)(\/(?:api|debug|v1)\/.*)$/)
          const path = scope?.[2] ?? url.pathname
          if (!path.startsWith('/api/') && !path.startsWith('/debug/') && !path.startsWith('/v1/')) return next()
          requests.push(`${request.method} ${path}`)
          const session = path.match(/^\/api\/sessions\/([^/]+)(?:\/(.*))?$/)
          const sessionId = session ? decodeURIComponent(session[1]!) : ''
          const operation = session?.[2]
          let data: unknown
          if (path === '/api/projects') data = { projects: [
            { id: 'work', name: 'Workspace', createdAt: '' }, { id: 'other', name: 'Other project', createdAt: '' },
          ] }
          else if (path === '/api/provider/setup') data = { provider: 'openai', model: 'gpt-test', ready: true, hasApiKey: false, authMode: 'none' }
          else if (path === '/api/config') data = { agent: { model: 'gpt-test', workspace: 'synthetic', temperature: 0.5 } }
          else if (path === '/debug/models') data = { models: ['gpt-test', 'gpt-alternate'] }
          else if (path === '/api/folders') data = { folders: [] }
          else if (path === '/api/channels') data = { channels: [] }
          else if (path === '/api/automations') data = { automations: [] }
          else if (path === '/api/sessions/graph') data = { sessions: [...names].map(([sessionId, title]) => ({ sessionId, title })), nodes: [] }
          else if (path === '/api/sessions/stages') data = { stages: {} }
          else if (path === '/api/chat/session') data = { history, tools: [], systemPrompt: 'Synthetic mobile test prompt' }
          else if (path === '/api/chat/commands') data = { commands: [] }
          else if (path === '/api/io/runs') data = { runs: [] }
          else if (path === '/api/io/clients') data = { clientToken: 'synthetic-test-client' }
          else if (/^\/api\/io\/clients\/[^/]+\/heartbeat$/.test(path)) data = { ok: true }
          else if (path === '/api/agent-resources/publication-requests') data = { request: null, requests: [] }
          else if (path === '/api/agent-resources/probe-requests') data = { requests: [] }
          else if (path === '/v1/query/session-spans') data = { sessionId: url.searchParams.get('sessionId'), entries: [], hasMore: false }
          else if (session && !operation) data = { messages: history, physicalId: 'physical-fixture' }
          else if (operation === 'background-tasks') data = { sessionId, total: 0, tasks: [] }
          else if (operation === 'details') data = { sessionId, name: names.get(sessionId), workdir: { kind: 'local', displayPath: 'C:\\synthetic' },
            usage: null, usageScope: 'session', context: { usedTokens: null, windowTokens: null } }
          else if (operation === 'name' && request.method === 'PATCH') {
            let body = ''
            for await (const chunk of request) body += chunk
            const name = JSON.parse(body).name
            names.set(sessionId, name)
            data = { sessionId, name }
          } else if (operation === 'files') data = { path: '', entries: [{ name: 'notes.txt', type: 'file', ext: '.txt', size: 23, mtime: null }] }
          else if (operation === 'preview') data = { binary: false, size: 23, content: 'Synthetic document body', encoding: 'utf-8' }
          else if (operation === 'git/status') data = { available: false, reason: 'not_repository', changes: [] }
          else { unexpected.push(`${request.method} ${url.pathname}`); response.statusCode = 404; data = { error: 'Unstubbed mobile fixture endpoint' } }
          response.setHeader('Content-Type', 'application/json')
          response.end(JSON.stringify(data))
        })
      },
    }],
    server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  t.after(() => server.close())
  assert.ok(server.resolvedUrls?.local[0])
  await build({
    entryPoints: [resolve(root, 'desktop', 'tests', 'fixtures', 'mobile-navigation-smoke.ts')],
    outfile: resolve(directory, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs',
    target: 'node24', external: ['electron'], logLevel: 'silent',
  })
  const env: NodeJS.ProcessEnv = { MOBILE_SMOKE_URL: server.resolvedUrls.local[0] }
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
  const timer = setTimeout(() => child.kill(), 165_000)
  t.after(() => { clearTimeout(timer); if (child.exitCode === null) child.kill() })
  const [code] = await once(child, 'close')
  assert.equal(code, 0, `${output}\nUnexpected API requests: ${JSON.stringify(unexpected)}`)
  assert.match(output, /MOBILE_NAVIGATION_OK/)
  assert.deepEqual(unexpected, [])
  assert.equal(names.get('web:chat-one'), 'Renamed on phone')
  assert.equal(requests.filter(request => request.startsWith('POST ') && !request.startsWith('POST /api/io/clients')).length, 0, 'No turns, uploads or device work are started')
})
