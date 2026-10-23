import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { Hono } from 'hono'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import UnoCSS from 'unocss/vite'
import { BrowserAuth } from '../../src/gateway/web-auth.ts'
import { GatewayClientAddressRegistry, registerGatewayRoutes, serveGateway } from '../../src/gateway/server.ts'

const root = fileURLToPath(new URL('../..', import.meta.url))
const desktopRequire = createRequire(new URL('../../desktop/package.json', import.meta.url))
const { build } = desktopRequire('esbuild') as typeof import('esbuild')

test('Electron issues codes through native IPC; browser pairs with cookies, preserves deep links and signs out', {
  timeout: 90_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY
    ? 'Electron browser smoke requires a display server.' : false,
}, async t => {
  const directory = resolve(root, '.test-artifacts', `web-auth-browser-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  const vite = await createServer({
    configFile: false, envFile: false, root: resolve(root, 'app'), logLevel: 'error',
    define: { 'import.meta.env.VITE_API_BASE': 'undefined' },
    plugins: [{
      name: 'synthetic-protected-route',
      enforce: 'pre',
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (request.url !== '/src/native-pairing-smoke.html') return next()
          response.setHeader('Content-Type', 'text/html')
          response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="app"></div><script type="module" src="/src/native-pairing-smoke.ts"></script></body></html>')
        })
      },
      resolveId(id, importer) {
        if (id === '/src/native-pairing-smoke.ts') return '\0native-pairing-smoke'
        if (importer?.replaceAll('\\', '/').endsWith('/src/router.ts') && id.endsWith('.vue')) return '\0protected-route'
      },
      load(id) {
        if (id === '\0native-pairing-smoke') return `
          import { createApp, h } from 'vue';
          import BrowserAccess from '/src/components/DesktopBrowserAccess.vue';
          import '/src/styles.css';
          import 'virtual:uno.css';
          createApp({ render: () => h(BrowserAccess, { api: window.shadowDesktop.webPairing }) }).mount('#app');
        `
        if (id !== '\0protected-route') return
        return `import { defineComponent, h, onMounted, ref } from 'vue';
          export default defineComponent({ setup() {
            const ready = ref(false);
            onMounted(async () => {
              const responses = await Promise.all([
                fetch('/api/private', { credentials: 'same-origin' }),
                fetch('/projects/default/api/private', { credentials: 'same-origin' }),
              ]);
              ready.value = responses.every(response => response.ok);
            });
            return () => h('div', { id: 'protected-route', 'data-ready': ready.value }, ready.value ? 'Protected route ready' : 'Loading protected route');
          } });`
      },
    }, vue(), UnoCSS({ configFile: resolve(root, 'app', 'unocss.config.ts') })],
    server: { host: '127.0.0.1', port: 0, hmr: false },
    optimizeDeps: { include: ['vue', 'vue-router'], entries: [] },
    cacheDir: resolve(directory, 'vite-cache'),
  })
  t.after(() => vite.close())
  await vite.listen()
  const viteAddress = vite.httpServer!.address()
  assert.ok(viteAddress && typeof viteAddress !== 'string')
  const viteOrigin = `http://127.0.0.1:${viteAddress.port}`
  const clientAddresses = new GatewayClientAddressRegistry()
  const launchCredential = 'synthetic-browser-smoke-management-credential'
  const auth = new BrowserAuth({ launchCredential, clientAddresses, developmentUrl: viteOrigin })
  t.after(() => auth.close())
  const gateway = new Hono()
  let pairingStarted = false
  const prematureRequests: string[] = []
  const authenticatedRequests: string[] = []
  const mutationOrigins: string[] = []
  gateway.use('*', async (c, next) => {
    if (c.req.path === '/api/web-auth/pair') pairingStarted = true
    if (c.req.path === '/api/web-auth/pair' || (c.req.path === '/api/web-auth/session' && c.req.method === 'DELETE')) {
      mutationOrigins.push(c.req.header('Origin') ?? '')
    }
    if (!pairingStarted && (c.req.path === '/api/provider/setup' || c.req.path.endsWith('/api/private'))) {
      prematureRequests.push(c.req.path)
    }
    await next()
  })
  registerGatewayRoutes(gateway, [auth.plugin(), app => {
    for (const path of ['/api/private', '/projects/default/api/private']) app.get(path, c => {
      authenticatedRequests.push(c.req.path)
      return c.json({ ok: true })
    })
    app.get('/api/provider/setup', c => c.json({
      provider: 'fixture', model: 'fixture', authMode: 'none', ready: true, hasApiKey: false,
    }))
    app.get('*', async c => {
      const url = new URL(c.req.url)
      const response = await fetch(viteOrigin + url.pathname + url.search)
      return new Response(response.body, { status: response.status, headers: response.headers })
    })
  }], { launchCredential, browserAuth: auth, clientAddresses })
  const server = serveGateway(gateway, { host: '127.0.0.1', port: 0, clientAddresses })
  await server.ready
  t.after(() => server.shutdown())
  const origin = `http://127.0.0.1:${server.addr.port}`
  const offer = await fetch(origin + '/local/v1/web-pairing', {
    method: 'POST', headers: { Authorization: `Bearer ${launchCredential}` },
  })
  assert.equal(offer.status, 200)
  const { code } = await offer.json() as { code: string }
  await Promise.all([
    build({
      entryPoints: [resolve(root, 'desktop', 'tests', 'fixtures', 'web-auth-smoke.ts')],
      outfile: resolve(directory, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs',
      target: 'node24', external: ['electron'], logLevel: 'silent',
    }),
    build({
      entryPoints: [resolve(root, 'desktop', 'src', 'preload.ts')],
      outfile: resolve(directory, 'preload.cjs'), bundle: true, platform: 'node', format: 'cjs',
      target: 'node24', external: ['electron'], logLevel: 'silent',
    }),
  ])
  const env: NodeJS.ProcessEnv = { WEB_AUTH_SMOKE_URL: origin, WEB_AUTH_SMOKE_CODE: code, WEB_AUTH_SMOKE_CREDENTIAL: launchCredential }
  for (const name of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'ComSpec', 'PATHEXT', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR']) {
    if (process.env[name] !== undefined) env[name] = process.env[name]
  }
  for (const name of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) env[name] = directory
  const child = spawn(desktopRequire('electron') as string, [resolve(directory, 'main.cjs')], {
    cwd: directory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { output += chunk })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { output += chunk })
  const timeout = setTimeout(() => child.kill(), 75_000)
  t.after(() => { clearTimeout(timeout); if (child.exitCode === null) child.kill() })
  const [exitCode] = await once(child, 'close')
  assert.equal(exitCode, 0, output)
  assert.match(output, /WEB_AUTH_BROWSER_SMOKE_OK/)
  assert.match(output, /NATIVE_PAIRING_SMOKE_OK/)
  assert.deepEqual(prematureRequests, [], 'No protected frontend request may fire before pairing')
  assert.ok(authenticatedRequests.includes('/api/private'))
  assert.ok(authenticatedRequests.includes('/projects/default/api/private'))
  assert.deepEqual(mutationOrigins, [origin, origin, origin, origin], 'Browser pair/logout and native-code redemption must use the same origin')
})
