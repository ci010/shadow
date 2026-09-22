import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { parse } from 'vue/compiler-sfc'

const root = fileURLToPath(new URL('../..', import.meta.url))
const desktopRequire = createRequire(new URL('../../desktop/package.json', import.meta.url))
const { build } = desktopRequire('esbuild') as typeof import('esbuild')

test('browser connection actions stay ordered and recovery popovers never resize or scroll route content', {
  timeout: 90_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? 'Electron requires a display server.' : false,
}, async t => {
  const directory = resolve(root, '.test-artifacts', `connection-layout-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  const { descriptor } = parse(readFileSync(resolve(root, 'app', 'src', 'App.vue'), 'utf8'))
  const server = await createServer({
    configFile: false, envFile: false, root: resolve(root, 'app'), logLevel: 'error', cacheDir: resolve(directory, 'vite-cache'),
    optimizeDeps: { entries: [] },
    plugins: [vue(), {
      name: 'connection-layout-fixture',
      resolveId: id => ['/connection-fixture.ts', '/app-shell.css'].includes(id) ? `\0${id}` : undefined,
      load(id) {
        if (id === '\0/app-shell.css') return descriptor.styles.map(style => style.content).join('\n')
        if (id !== '\0/connection-fixture.ts') return
        return `
          import '/src/styles.css'; import '/app-shell.css';
          import { createApp, h, reactive } from 'vue';
          import BrowserAuth from '/src/BrowserAuth.vue';
          import DesktopFrame from '/src/DesktopFrame.vue';
          import ConnectionStatus from '/src/components/ConnectionStatus.vue';
          import { createBrowserSession } from '/src/web-auth.ts';
          const state = reactive({ mode:'auth', childTitle:'', liveError:'', notificationError:'', retries:0, managed:0 });
          const session = createBrowserSession(location.origin, { fetch: async () =>
            Response.json({ version:1, required:true, authenticated:false, pinAvailable:true }) });
          await session.refresh();
          window.fixture = state;
          createApp({ render: () => state.mode === 'auth' ? h(BrowserAuth, { session })
            : h(DesktopFrame, {}, { default: () => h('div', { class:'app-shell' }, [
              h('main', { class:'app-main' }, [
                h(ConnectionStatus, { childTitle:state.childTitle, liveError:state.liveError, notificationError:state.notificationError,
                  onRetry:() => state.retries++, onManageNode:() => state.managed++ }),
                h('div', { class:'route-content', id:'route' }, [
                  h('div', { style:'min-height:1400px; padding-top:400px;' }, [
                    h('h1', 'Saved conversation'),
                    h('p', 'Messages and local controls remain available while Main reconnects.'),
                    h('textarea', { id:'draft', 'aria-label':'Message', style:'width:100%;box-sizing:border-box;height:100px;' }, 'Unsent draft'),
                  ]),
                ]),
              ]),
            ]) }),
          }).mount('#app');`
      },
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (request.url !== '/__connection') return next()
          response.setHeader('Content-Type', 'text/html')
          response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="/connection-fixture.ts"></script></body></html>')
        })
      },
    }], server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  t.after(() => server.close())
  const url = server.resolvedUrls?.local[0]
  assert.ok(url)
  await build({ entryPoints: [resolve(root, 'desktop', 'tests', 'fixtures', 'connection-layout-smoke.ts')],
    outfile: resolve(directory, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs',
    target: 'node24', external: ['electron'], logLevel: 'silent' })
  const env: NodeJS.ProcessEnv = { CONNECTION_SMOKE_URL: url }
  for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'ComSpec', 'PATHEXT', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'XAUTHORITY', 'CONNECTION_SCREENSHOTS']) {
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
  assert.match(output, /CONNECTION_LAYOUT_OK/)
})
