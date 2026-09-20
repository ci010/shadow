import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { uiPlugin } from '../../src/gateway/ui.ts'

const root = fileURLToPath(new URL('../..', import.meta.url))
const desktopRequire = createRequire(new URL('../../desktop/package.json', import.meta.url))
const { build } = desktopRequire('esbuild')

test('real Chromium PWA manifest, worker control, network-only offline fallback and recovery', {
  timeout: 120_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY
    ? 'Electron requires a display server.' : false,
}, async t => {
  const directory = resolve(root, '.test-artifacts', `pwa-${randomUUID()}`)
  const dist = resolve(directory, 'public')
  await mkdir(directory, { recursive: true })
  let child: ChildProcess | undefined
  let closed: Promise<unknown> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopServer: (() => Promise<void>) | undefined
  t.after(async () => {
    if (timer) clearTimeout(timer)
    if (child && child.exitCode === null) child.kill()
    await closed
    await stopServer?.()
    await rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 })
  })

  // Serve production assets and head through the real gateway, without booting
  // the application, reading user configuration, or contacting Google Fonts.
  await cp(resolve(root, 'app', 'public'), dist, { recursive: true })
  const index = await readFile(resolve(root, 'app', 'index.html'), 'utf8')
  const head = index.match(/<head>([\s\S]*?)<\/head>/i)?.[1]
  assert.ok(head, 'Production index must contain a document head')
  const localHead = head.replace(/<link\b[^>]*href=["']https?:\/\/[^>]*>/gi, '')
  await writeFile(resolve(dist, 'index.html'), `<!doctype html><html lang="en"><head>${localHead}</head>
    <body><main id="fixture">Synthetic online PWA fixture</main>
    <script type="module" src="/pwa-fixture.js"></script></body></html>`)
  await build({
    stdin: {
      contents: `import { registerBrowserPwa } from './app/src/pwa.ts';
        window.__pwa = { error: null, registered: false };
        registerBrowserPwa({ production: true, desktop: false,
          secureContext: window.isSecureContext, protocol: location.protocol,
          serviceWorker: navigator.serviceWorker
        }).then(registration => { window.__pwa.registered = !!registration; })
          .catch(error => { window.__pwa.error = String(error); });`,
      resolveDir: root, sourcefile: 'pwa-fixture.ts', loader: 'ts',
    },
    outfile: resolve(dist, 'pwa-fixture.js'), bundle: true, platform: 'browser',
    format: 'esm', target: 'es2022', logLevel: 'silent',
  })

  let privateRequests = 0
  const requests: string[] = []
  const gateway = new Hono()
  gateway.use('*', async (c, next) => {
    requests.push(c.req.path)
    await next()
  })
  for (const path of ['/api/pwa-private', '/projects/synthetic/api/pwa-private']) {
    gateway.get(path, c => {
      c.header('Cache-Control', 'no-store')
      return c.json({ secret: 'synthetic-private-not-for-offline', revision: ++privateRequests })
    })
  }
  uiPlugin(dist)(gateway)
  const server = serve({ fetch: gateway.fetch, hostname: '127.0.0.1', port: 0 })
  stopServer = () => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
    if ('closeAllConnections' in server) server.closeAllConnections()
  })
  if (!server.listening) await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`
  const response = await fetch(`${origin}/manifest.webmanifest`)
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type')!, /application\/manifest\+json/)
  assert.equal(response.headers.get('cache-control'), 'no-cache')
  assert.equal((await fetch(`${origin}/sw.js`)).headers.get('cache-control'), 'no-cache')

  await build({
    entryPoints: [resolve(root, 'desktop', 'tests', 'fixtures', 'pwa-smoke.ts')],
    outfile: resolve(directory, 'main.cjs'), bundle: true, platform: 'node',
    format: 'cjs', target: 'node24', external: ['electron'], logLevel: 'silent',
  })
  const env: NodeJS.ProcessEnv = { PWA_SMOKE_URL: origin }
  for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'ComSpec', 'PATHEXT', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR']) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) {
    env[key] = directory
  }
  child = spawn(desktopRequire('electron') as string, [resolve(directory, 'main.cjs')], {
    cwd: directory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout!.setEncoding('utf8').on('data', chunk => { output += chunk })
  child.stderr!.setEncoding('utf8').on('data', chunk => { output += chunk })
  closed = once(child, 'close')
  timer = setTimeout(() => child?.kill(), 100_000)
  const [code] = await closed as [number | null]
  assert.equal(code, 0, output)
  assert.match(output, /PWA_SMOKE_OK/)
  t.diagnostic(output.trim())
  assert.equal(privateRequests, 4, 'Every online API fetch reaches the server; offline attempts do not')
  assert.ok(requests.includes('/sw.js'))
  assert.ok(requests.includes('/pwa/icon-192.png'))
  assert.ok(requests.includes('/pwa/icon-512.png'))
  assert.ok(requests.includes('/pwa/apple-touch-icon.png'))
})
