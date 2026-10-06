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

test('agent browser separates definitions and previews with accessible desktop and narrow navigation', {
  timeout: 90_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? 'Electron requires a display server.' : false,
}, async t => {
  const directory = resolve(root, '.test-artifacts', `agent-browser-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  const agents = [
    { name: 'general', description: 'General assistant that completes work directly or delegates with an explicit execution contract', source: 'builtin', defaultMode: 'session' },
    { name: 'explore', description: 'Read-only exploration for understanding an existing codebase', source: 'builtin', defaultMode: 'session', allowedTools: ['read', 'search'] },
    { name: 'plan', description: 'Planning agent for design and implementation decisions', source: 'builtin', defaultMode: 'session', blockedTools: ['write'] },
    { name: 'verify', description: 'Verify completed work against its execution contract', source: 'builtin', defaultMode: 'task', allowedTools: [] },
    ...Array.from({ length: 10 }, (_, index) => ({ name: `fixture-role-${index}`, description: 'Synthetic role for testing catalog scroll and search', source: 'builtin', defaultMode: 'task' })),
    { name: 'review', description: 'Workspace-specific review instructions for this synthetic project', source: 'workspace', defaultMode: 'task',
      model: 'fixture-model@provider', temperature: 0, maxTokens: 2048, allowedTools: ['read', 'search'], blockedTools: ['write'] },
    { name: 'review-' + 'long-agent-name-'.repeat(8), description: 'A long workspace role name and description should wrap without hiding actions or overflowing the browser pane.', source: 'workspace', defaultMode: 'call' },
  ]
  const tools = [
    { name: 'read', description: 'Read a file, list a directory, or fetch a URL. Paths stay in the owning project.',
      parameters: { type: 'object', additionalProperties: false, required: ['path'], properties: {
        path: { type: 'string', description: 'A file or directory path', minLength: 1 },
        options: { type: ['object', 'null'], description: 'Optional read settings', additionalProperties: false },
      } } },
    { name: 'write', description: 'Write or edit a file. Changes remain within the selected work context.', parameters: { type: 'object', properties: { content: { type: 'string' } } } },
    { name: 'search', description: 'Search filenames or text and inspect matching evidence.' },
  ]
  let mode = 'normal'
  const pending: Array<() => void> = []
  const unexpected: string[] = []
  const contexts: Array<{ project: string; agent: string; channel: string }> = []
  let catalogRequests = 0
  const server = await createServer({
    configFile: false, root: resolve(root, 'app'), logLevel: 'error', cacheDir: resolve(directory, 'vite-cache'),
    optimizeDeps: { noDiscovery: true },
    plugins: [vue(), UnoCSS({ configFile: resolve(root, 'app', 'unocss.config.ts') }), {
      name: 'synthetic-agent-browser',
      enforce: 'pre',
      resolveId: id => id === '/agent-browser-fixture.ts' ? '\0agent-browser-fixture' : undefined,
      load(id) {
        if (id !== '\0agent-browser-fixture') return
        return `import 'uno.css'; import '/src/styles.css';
          import { createApp, h, reactive } from 'vue';
          import { createRouter, createMemoryHistory } from 'vue-router';
          import AgentsTab from '/src/components/AgentsTab.vue';
          import ToolsCard from '/src/components/ToolsCard.vue';
          import SystemPromptCard from '/src/components/SystemPromptCard.vue';
          const router = createRouter({history:createMemoryHistory(), routes:[
            {path:'/agents/:projectId/:agentName?', name:'agents', component:{render:() => null}},
          ]});
          await router.push('/agents/fixture/general?channel=web&retained=yes');
          const state = reactive({project:'fixture', width:'100%', legacy:false});
          const requests = [];
          const nativeFetch = window.fetch.bind(window);
          window.fetch = (input, options) => {
            const request = {url:String(input)};
            requests.push(request);
            return nativeFetch(input, options).then(response => {request.status = response.status; return response;},
              error => {request.error = String(error); throw error;});
          };
          const clipboard = {writes:[], fail:false, hold:false, release:null};
          Object.defineProperty(navigator, 'clipboard', {configurable:true, value:{writeText:text => {
            clipboard.writes.push(text);
            if (clipboard.fail) return Promise.reject(new Error('Synthetic clipboard denial'));
            if (clipboard.hold) return new Promise(resolve => { clipboard.release = resolve });
            return Promise.resolve();
          }}});
          window.__agentFixture = {router, state, clipboard, requests};
          createApp({render:() => h('main', {style:'height:100dvh;display:flex;flex-direction:column;min-height:0'}, [
            h('header', {style:'padding:12px 24px;font-size:12px;color:var(--c-text-secondary)'}, 'Agent browser / synthetic fixture'),
            h('div', {class:'fixture-pane', style:'flex:1;min-height:0;padding:12px;box-sizing:border-box;width:' + state.width}, [
              state.legacy ? h('div', {class:'legacy-viewers', style:'height:100%;overflow:auto'}, [
                h(ToolsCard, {tools:${JSON.stringify(tools)}}),
                h(SystemPromptCard, {prompt:'# Legacy renderer\\n\\nOriginal diagnosis presentation.'}),
              ]) : h(AgentsTab, {apiBase:location.origin + '/projects/' + state.project + '/'}),
            ]),
          ])}).use(router).mount('#app');`
      },
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          const url = new URL(request.url!, 'http://fixture')
          const json = (value: unknown) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)) }
          if (url.pathname === '/__agent-browser') {
            response.setHeader('Content-Type', 'text/html')
            response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="app"></div><script type="module" src="/agent-browser-fixture.ts"></script></body></html>')
            return
          }
          if (url.pathname.startsWith('/__context/')) {
            mode = url.pathname.split('/').at(-1)!
            if (mode !== 'hold') pending.splice(0).forEach(send => send())
            response.end('OK')
            return
          }
          const catalog = url.pathname.match(/^\/projects\/([^/]+)\/debug\/agent-types$/)
          if (catalog) {
            catalogRequests++
            if (catalog[1] === 'broken') { response.statusCode = 503; json({ error: 'Synthetic catalog failure' }) }
            else json(catalog[1] === 'empty' ? [] : agents)
            return
          }
          const context = url.pathname.match(/^\/projects\/([^/]+)\/debug\/agent-types\/([^/]+)\/context$/)
          if (context) {
            const agent = decodeURIComponent(context[2]!)
            const channel = url.searchParams.get('channel') ?? 'heartbeat'
            contexts.push({ project: context[1]!, agent, channel })
            const send = () => {
              if (response.destroyed) return
              if (mode === 'fail') { response.statusCode = 503; json({ error: 'Synthetic preview failure' }); return }
              if (mode === 'invalid') { json({ systemPrompt: null, tools: 'invalid' }); return }
              const resolved = agent === 'explore' ? tools.filter(tool => tool.name !== 'write') : agent === 'verify' ? [] : tools
              json({ systemPrompt: agent === 'verify' ? '' : `# ${agent}\n\nSynthetic assembled preview for **${channel}**.\n\n## Instructions\n\nRead the task, inspect the evidence, and preserve the owning Project.\n\n<available_skills>\n<skill name="fixture-skill">Synthetic skill description</skill>\n</available_skills>\n\n<script>window.__unsafePrompt = true</script>`, tools: resolved })
            }
            if (mode === 'hold') pending.push(send)
            else send()
            return
          }
          if (url.pathname.includes('/debug/') || request.method !== 'GET') {
            unexpected.push(`${request.method} ${url.pathname}`)
            response.statusCode = 404
            json({ error: 'Unstubbed endpoint' })
            return
          }
          next()
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
    entryPoints: [resolve(root, 'desktop', 'tests', 'fixtures', 'agent-browser-smoke.ts')],
    outfile: resolve(directory, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs',
    target: 'node24', external: ['electron'], logLevel: 'silent',
  })
  const env: NodeJS.ProcessEnv = { AGENT_BROWSER_URL: url, AGENT_BROWSER_SCREENSHOTS: process.env.AGENT_BROWSER_SCREENSHOTS }
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
  assert.equal(code, 0, `${output}\nSynthetic catalog requests: ${catalogRequests}; preview requests: ${contexts.length}`)
  assert.match(output, /AGENT_BROWSER_OK/)
  assert.deepEqual(unexpected, [])
  assert(contexts.every(context => context.project === 'fixture' && ['web', 'discord'].includes(context.channel)))
})
