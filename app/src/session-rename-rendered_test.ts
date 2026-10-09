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

test('rendered session details supports inline identity actions, copying and keyboard rename', {
  timeout: 90_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? 'Electron requires a display server.' : false,
}, async t => {
  const directory = resolve(root, '.test-artifacts', `rename-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  let name = 'Original conversation'
  let writes = 0
  const longName = 'Review / ' + 'LongSessionName'.repeat(25)
  const longPath = 'C:\\synthetic\\' + 'nested-folder\\'.repeat(15) + 'review'
  const server = await createServer({
    configFile: false, root: resolve(root, 'app'), logLevel: 'error',
    plugins: [vue(), UnoCSS({ configFile: resolve(root, 'app', 'unocss.config.ts') }), {
      name: 'synthetic-rename',
      resolveId: id => id === '/rename-fixture.ts' ? '\0rename-fixture' : undefined,
      load(id) {
        if (id !== '\0rename-fixture') return
        return `import 'uno.css'; import '/src/styles.css';
          import { createApp, h, reactive, ref } from 'vue';
          import Heading from '/src/components/SessionHeading.vue';
          import { provideMobileChrome } from '/src/composables/useMobileChrome.ts';
          const state = reactive({name:'Original conversation',sessionId:'web:fixture',canRename:true,revision:0});
          window.__headingFixture = state;
          createApp({ setup() {
            provideMobileChrome();
            const heading = ref();
            window.__startHeadingRename = () => heading.value.startRename();
            return () => h('main', [
            h(Heading, { ref:heading, apiBase: location.origin, sessionId: state.sessionId, name: state.name,
              projectName: 'Synthetic project', physicalId: null, revision: state.revision, active: true,
              canRename: state.canRename, onRenamed: value => { state.name = value } }),
            h('p', { id: 'saved-name' }, state.name)
          ]);
          } }).mount('#app');`
      },
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          const path = new URL(request.url!, 'http://127.0.0.1').pathname
          const json = (body: unknown) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(body)) }
          if (path === '/__rename') {
            response.setHeader('Content-Type', 'text/html')
            response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="app"></div><script type="module" src="/rename-fixture.ts"></script></body></html>')
          } else if (/^\/api\/sessions\/[^/]+\/details$/.test(path)) {
            const sessionId = decodeURIComponent(path.split('/')[3])
            const remote = sessionId.startsWith('web:remote')
            json({ sessionId, name: sessionId === 'web:long' ? longName : name,
              workdir: remote
                ? { kind: 'remote', displayPath: sessionId === 'web:remote-missing' ? null : 'Z:\\remote\\review',
                  nodeName: 'Synthetic device', displayName: 'Review workspace' }
                : { kind: 'local', displayPath: sessionId === 'web:missing' ? null : sessionId === 'web:long' ? longPath : 'C:\\synthetic' },
              usage: { promptTokens: 1234567, completionTokens: 45678, totalTokens: 1280245 },
              subagentUsage: { promptTokens: 234567, completionTokens: 5678, totalTokens: 240245 },
              usageIncomplete: true, usageScope: 'session', context: { usedTokens: 12000, windowTokens: 100000 } })
          } else if (path === '/api/sessions/web%3Afixture/name' && request.method === 'PATCH') {
            writes++
            let body = ''
            for await (const chunk of request) body += chunk
            const input = JSON.parse(body)
            if (input.name === 'Fail this rename') { response.statusCode = 500; json({ error: 'synthetic_failure' }); return }
            name = input.name
            json({ sessionId: 'web:fixture', name })
          } else next()
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
    entryPoints: [resolve(root, 'desktop', 'tests', 'fixtures', 'session-rename-smoke.ts')],
    outfile: resolve(directory, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs',
    target: 'node24', external: ['electron'], logLevel: 'silent',
  })
  const env: NodeJS.ProcessEnv = { RENAME_SMOKE_URL: url }
  for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'ComSpec', 'PATHEXT', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'RENAME_SCREENSHOTS']) {
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
  assert.match(output, /RENAME_SMOKE_OK/)
  assert.equal(writes, 3, 'Cancel sends no request; only two saves and one deliberate failure reach Main')
})
