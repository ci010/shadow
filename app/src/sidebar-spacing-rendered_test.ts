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
import { channelSessionId } from '../../src/bus/events.ts'

const root = fileURLToPath(new URL('../..', import.meta.url))
const desktopRequire = createRequire(new URL('../../desktop/package.json', import.meta.url))
const { build } = desktopRequire('esbuild') as typeof import('esbuild')

test('sidebar preserves spacing and navigation across pinned, hidden and temporary states', {
  timeout: 90_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? 'Electron requires a display server.' : false,
}, async t => {
  const directory = resolve(root, '.test-artifacts', `sidebar-spacing-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  const botSession = channelSessionId({ projectId: 'work', botInstanceId: 'bot', platform: 'qq', conversationId: 'group:room' })
  const sessions = [
    { sessionId: 'web:chat-one', title: 'Issue investigation', folderId: 'code' },
    { sessionId: 'web:chat-two', title: 'A very long conversation title that must truncate instead of changing the row height', folderId: 'code' },
    { sessionId: botSession, title: 'Bot conversation' },
  ]
  const unexpected: string[] = []
  let empty = false
  let holdFolders = false
  let failFolders = false
  const pendingFolders: (() => void)[] = []
  const server = await createServer({
    configFile: false, root: resolve(root, 'app'), logLevel: 'error', cacheDir: resolve(directory, 'vite-cache'),
    plugins: [vue(), UnoCSS({ configFile: resolve(root, 'app', 'unocss.config.ts') }), {
      name: 'synthetic-sidebar-spacing',
      enforce: 'pre',
      resolveId(id, importer) {
        if (id === '/sidebar-fixture.ts') return '\0sidebar-fixture'
        if (id === '/folder-loading-fixture.ts') return '\0folder-loading-fixture'
        if (importer?.replaceAll('\\', '/').split('?')[0].endsWith('/ProjectsWorkspace.vue')
          && /(?:^|\/)(?:ProjectConversation|AutomationDetail)\.vue$/.test(id.replaceAll('\\', '/'))) return '\0sidebar-content'
      },
      load(id) {
        if (id === '\0folder-loading-fixture') return `import 'uno.css'; import '/src/styles.css';
          import { createApp, h, ref } from 'vue';
          import FoldersSidebar from '/src/components/FoldersSidebar.vue';
          const revision = ref(0), grouped = ref(true);
          window.__folderFixture = {refresh:() => revision.value++, group:value => grouped.value = value};
          const app = createApp({render:() => h(FoldersSidebar, {
            apiBase:location.origin + '/projects/work/', grouped:grouped.value, projectName:'Workspace',
            folderRevision:revision.value, sessions:[], activeSessionId:'', collapsed:new Set(), stages:{},
            sessionsLoading:false, sessionsError:'',
          })});
          app.provide(Symbol.for('shadow.live-client-pool'), {
            client:() => ({subscribe:() => ({close(){}})}),
          });
          app.mount('#app');`
        if (id === '\0sidebar-content') return `import { defineComponent, h } from 'vue';
          export default defineComponent({
            props:['sessionId', 'projectId', 'automationId'], emits:['navigate'],
            setup(props, {expose, emit}) {
              expose({requestSession:id => emit('navigate', id)});
              return () => h('section', {class:'fixture-content', style:'flex:1;min-height:0'}, [
                h('button', {class:'fixture-content-action'}, props.sessionId || props.automationId || 'Draft'),
              ]);
            },
          });`
        if (id !== '\0sidebar-fixture') return
        return `import 'uno.css'; import '/src/styles.css';
          import { createApp, h, ref } from 'vue';
          import { createRouter, createMemoryHistory } from 'vue-router';
          import ProjectsWorkspace from '/src/components/ProjectsWorkspace.vue';
          import { botSidebarStorageKey } from '/src/bot-sidebar.ts';
          const router = createRouter({ history:createMemoryHistory(), routes:[
            { path:'/:projectId?/:sessionId?', name:'chat', component:{render:() => null} },
            { path:'/settings/:projectId/:section', name:'project-settings', component:{render:() => null} },
          ] });
          await router.push('/');
          localStorage.setItem(botSidebarStorageKey(location.origin + '/projects/work/', 'work'), '["bot"]');
          const visible = ref(true);
          window.__sidebarFixture = {setVisible:value => visible.value = value, router};
          const app = createApp({ render:() => h(ProjectsWorkspace, {apiBase:location.origin, visible:visible.value}) });
          app.provide(Symbol.for('shadow.live-client-pool'), {
            client:() => ({subscribe:() => ({close(){}})}),
          });
          app.use(router).mount('#app');`
      },
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          const url = new URL(request.url!, 'http://fixture')
          const scope = url.pathname.match(/^\/projects\/([^/]+)(\/api\/.*)$/)
          const path = scope?.[2] ?? url.pathname
          if (path === '/__folders/hold') { holdFolders = true; response.end('OK'); return }
          if (path === '/__folders/release' || path === '/__folders/fail') {
            holdFolders = false
            failFolders = path.endsWith('/fail')
            pendingFolders.splice(0).forEach(send => send())
            response.end('OK')
            return
          }
          if (path === '/__folder-loading') {
            response.setHeader('Content-Type', 'text/html')
            response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="app"></div><script type="module" src="/folder-loading-fixture.ts"></script></body></html>')
            return
          }
          if (path === '/__empty') { empty = true; response.end('OK'); return }
          if (path === '/__sidebar') {
            response.setHeader('Content-Type', 'text/html')
            response.end('<!doctype html><html class="dark"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="app"></div><script type="module" src="/sidebar-fixture.ts"></script></body></html>')
            return
          }
          if (!path.startsWith('/api/')) return next()
          let data: unknown
          const work = scope?.[1] === 'work'
          if (path === '/api/projects') data = { projects: empty ? [] : [
            { id: 'empty', name: 'Empty project with a long title', createdAt: '' },
            { id: 'work', name: 'Workspace', createdAt: '' },
            ...Array.from({ length: 20 }, (_, i) => ({ id: 'extra-' + i, name: 'More projects ' + i, createdAt: '' })),
          ] }
          else if (path === '/api/folders') data = { folders: work ? ['code', 'ops'].map(id => ({
            id, name: id === 'code' ? 'A long folder name for checking truncation' : 'Operations',
            path: `C:\\synthetic\\${id}`, createdAt: '',
          })) : [] }
          else if (path === '/api/sessions/graph') data = { sessions: work ? sessions : [], nodes: [] }
          else if (path === '/api/sessions/stages') data = { stages: {} }
          else if (path === '/api/channels') data = { channels: [{
            id: 'bot', projectId: 'work', platform: 'qq', displayName: 'QQ bot', label: 'QQ',
            enabled: true, configured: true, state: 'connected', config: {}, secrets: {},
          }] }
          else if (path === '/api/automations') data = { automations: work ? ['Encapsulation', 'Self reflection', 'Soul reflection'].map(name => ({
            id: name, name, source: 'learning', session: 'fresh', schedule: 'daily', enabled: true,
          })) : [] }
          else { unexpected.push(path); response.statusCode = 404; data = { error: 'Unstubbed fixture endpoint' } }
          const send = () => {
            if (response.destroyed) return
            response.setHeader('Content-Type', 'application/json')
            if (path === '/api/folders' && failFolders) {
              response.statusCode = 503
              response.end(JSON.stringify({ error: 'Synthetic folder loading failure' }))
            } else response.end(JSON.stringify(data))
          }
          if (path === '/api/folders' && holdFolders) pendingFolders.push(send)
          else send()
        })
      },
    }],
    server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  t.after(() => server.close())
  const url = server.resolvedUrls?.local[0]
  assert.ok(url)
  await build({
    entryPoints: [resolve(root, 'desktop', 'tests', 'fixtures', 'sidebar-spacing-smoke.ts')],
    outfile: resolve(directory, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs',
    target: 'node24', external: ['electron'], logLevel: 'silent',
  })
  const env: NodeJS.ProcessEnv = { SIDEBAR_SMOKE_URL: url, SIDEBAR_SCREENSHOT_DIR: process.env.SIDEBAR_SCREENSHOT_DIR }
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
  assert.equal(code, 0, output)
  assert.match(output, /SIDEBAR_SPACING_OK/)
  assert.deepEqual(unexpected, [])
})
