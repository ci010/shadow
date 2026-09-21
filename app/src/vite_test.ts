import assert from 'node:assert/strict'
import { createServer as createHttpServer } from 'node:http'
import { EventEmitter, once } from 'node:events'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createConnection } from 'node:net'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import { Hono } from 'hono'
import WS from 'ws'
import { createServer } from 'vite'
import config, { desktopBackendRouting } from '../vite.config.ts'
import unoConfig from '../unocss.config.ts'
import { BrowserAuth } from '../../src/gateway/web-auth.ts'
import { GatewayClientAddressRegistry, registerGatewayRoutes, serveGateway } from '../../src/gateway/server.ts'
import { upgradeGatewayWebSocket } from '../../src/gateway/websocket.ts'

for (const desktop of [false, true]) {
  test(`LAN Vite preserves PIN, pairing, API and WebSocket authentication (${desktop ? 'desktop' : 'standalone'})`, async t => {
    const credential = 'synthetic-lan-management-credential'
    const pin = 'synthetic-lan-pin'
    const clientAddresses = new GatewayClientAddressRegistry()
    const auth = new BrowserAuth({
      clientAddresses, launchCredential: credential,
      pinHash: createHash('sha256').update(pin).digest('hex'),
    })
    t.after(() => auth.close())
    const app = new Hono()
    registerGatewayRoutes(app, [auth.plugin(), gateway => {
      gateway.post('/projects/default/api/private', c => c.json({ authenticated: auth.authorize(c.req.raw) }))
      gateway.get('/api/socket', c => upgradeGatewayWebSocket(app, c, socket => socket.send('authenticated')))
      gateway.post('/local/v1/shutdown', c => c.json({ stopping: true }))
    }], { browserAuth: auth, clientAddresses, launchCredential: credential, allowedOrigins: [] })
    const backend = serveGateway(app, { host: '127.0.0.1', port: 0, clientAddresses })
    await backend.ready
    t.after(() => backend.shutdown())
    const target = `http://127.0.0.1:${backend.addr.port}`
    const messages = new EventEmitter()
    const routing = desktopBackendRouting(desktop, messages)
    const vite = await createServer({
      root: fileURLToPath(new URL('..', import.meta.url)),
      configFile: false, envFile: false, logLevel: 'silent',
      optimizeDeps: { noDiscovery: true, include: [] },
      plugins: [routing.plugin],
      server: {
        host: config.server!.host, port: 0, strictPort: false, watch: null,
        proxy: desktop ? routing.proxy : Object.fromEntries(Object.entries(routing.proxy).map(([path, options]) => [
          path, { ...options, target },
        ])),
      },
    })
    t.after(() => vite.close())
    await vite.listen()
    messages.emit('message', { type: 'shadow:runtime-ready', apiBase: target })
    const address = vite.httpServer?.address()
    assert.ok(address && typeof address !== 'string')
    assert.equal(address.address, process.env.VITE_DEV_HOST ?? '0.0.0.0')
    const lan = Object.values(networkInterfaces()).flat()
      .find(value => value?.family === 'IPv4' && !value.internal)?.address
    const host = process.env.VITE_DEV_HOST === '127.0.0.1' ? '127.0.0.1' : lan ?? '127.0.0.1'
    const base = `http://${host}:${address.port}`
    const request = (path: string, init: RequestInit = {}) =>
      fetch(new URL(path, base), { ...init, signal: AbortSignal.timeout(5000) })
    const login = (body: object, headers: Record<string, string> = {}) => request('/api/web-auth/pair', {
      method: 'POST', headers: { origin: base, 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
    assert.equal((await (await request('/api/web-auth/session')).json()).authenticated, false)
    assert.equal((await request('/projects/default/api/private', { method: 'POST', headers: { origin: base } })).status, 401)
    for (const headers of [
      { origin: 'http://evil.invalid' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' },
    ]) assert.equal((await login({ pin }, headers)).status, 403)
    assert.equal((await request('/api/web-auth/pair', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin }),
    })).status, 403, 'Missing Origin must not be synthesized by the proxy')
    assert.equal((await login({ pin: 'wrong-pin' })).status, 401)

    const offer = await fetch(`${target}/local/v1/web-pairing`, {
      method: 'POST', headers: { authorization: `Bearer ${credential}` },
    })
    assert.equal(offer.status, 200)
    const code = (await offer.json()).code
    for (const body of [{ pin }, { code }]) {
      const paired = await login(body)
      assert.equal(paired.status, 200)
      const cookie = paired.headers.get('set-cookie')?.split(';')[0]
      assert.ok(cookie)
      const headers = { cookie, origin: base }
      assert.deepEqual(await (await request('/projects/default/api/private', { method: 'POST', headers })).json(),
        { authenticated: true })
      assert.equal((await request('/api/web-auth/session', { headers })).status, 200)
      assert.equal((await request('/local/v1/shutdown', { method: 'POST', headers })).status, 401)
      const socket = new WS(base.replace('http:', 'ws:') + '/api/socket', { headers, handshakeTimeout: 5000 })
      try {
        const message = await once(socket, 'message', { signal: AbortSignal.timeout(5000) })
        assert.equal(String(message[0]), 'authenticated')
      } finally { socket.terminate() }
      assert.equal((await request('/api/web-auth/session', { method: 'DELETE', headers })).status, 200)
      assert.equal((await request('/projects/default/api/private', { method: 'POST', headers })).status, 401)
    }
    assert.equal((await login({ code })).status, 401, 'Pairing codes remain single-use')
  })
}

test('Vite never serves a local PIN file through filesystem or raw module URLs', async t => {
  const root = await mkdtemp(resolve('.shadow-test-vite-pin-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, '.pin')
  await writeFile(file, 'synthetic-private-pin')
  const vite = await createServer({
    root, configFile: false, envFile: false, logLevel: 'silent',
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { host: '127.0.0.1', port: 0, strictPort: false, watch: null, fs: config.server!.fs },
  })
  t.after(() => vite.close())
  await vite.listen()
  const base = vite.resolvedUrls?.local[0]
  assert(base)
  for (const path of ['/.pin', '/.pin?raw', `/@fs/${file.replaceAll('\\', '/')}`, `/@fs/${file.replaceAll('\\', '/')}?raw`]) {
    const response = await fetch(new URL(path, base))
    assert.notEqual(response.status, 200)
    assert.doesNotMatch(await response.text(), /synthetic-private-pin/)
  }
})

test('Vite 8 transforms Vue and proxies inventory without intercepting the Nodes page', { timeout: 90_000 }, async (t) => {
  const backend = createHttpServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ path: request.url }))
  })

  backend.listen(0, '127.0.0.1')
  await once(backend, 'listening')
  t.after(() => { backend.closeAllConnections(); backend.close() })
  const address = backend.address()
  assert.ok(address && typeof address !== 'string')
  assert.ok(config.server?.proxy?.['/nodes/v1'])
  const target = `http://127.0.0.1:${address.port}`
  const vite = await createServer({
    ...config,
    root: fileURLToPath(new URL('..', import.meta.url)),
    configFile: false,
    envFile: false,
    logLevel: 'silent',
    optimizeDeps: { noDiscovery: true, include: [] },
    server: {
      ...config.server,
      host: '127.0.0.1',
      port: 0,
      strictPort: false,
      watch: null,
      proxy: Object.fromEntries(Object.entries(config.server.proxy).map(([path, proxy]) => [
        path, { ...(typeof proxy === 'string' ? {} : proxy), target },
      ])),
    },
  })
  t.after(() => vite.close())
  await vite.listen()
  const base = vite.resolvedUrls?.local[0]
  assert.ok(base)
  // Cold UnoCSS/Vue transforms share this budget on slower native CI runners.
  const signal = AbortSignal.timeout(60_000)
  const icons = await fetch(new URL('/@id/__x00__/__uno.css', base), { signal })
  assert.equal(icons.status, 200)
  const iconCss = await icons.text()
  const expectedIcons = [...new Set(unoConfig.content.inline[0]().match(/\bi-(?:lucide|simple-icons)-[a-z0-9]+(?:-[a-z0-9]+)*/g))]
  assert.ok(expectedIcons.length > 30, 'Scan actual application icon references')
  for (const icon of expectedIcons) {
    assert.ok(iconCss.includes(`.${icon}{`) || iconCss.includes(`.${icon},`),
      `${icon} must be available before any Vue route is requested`)
  }
  assert.match(iconCss, /data:image\/svg\+xml/)
  for (const utility of ['flex-col', 'min-w-0', 'items-center', 'justify-between', 'px-4', 'py-3', 'max-w-none']) {
    assert.ok(iconCss.includes(`.${utility}{`) || iconCss.includes(`.${utility},`),
      `${utility} must be available before the system prompt component is requested`)
  }
  assert.doesNotMatch(iconCss, /https?:\/\/(?:api\.iconify|api\.simplesvg|api\.unisvg)/)
  assert.deepEqual(await (await fetch(new URL('/nodes/v1', base), { signal })).json(), { path: '/nodes/v1' })
  for (const path of [
    '/projects/default/api/sessions',
    '/projects/example/v1/query/logs',
    '/projects/example/api/channels?instance=one',
  ]) {
    assert.deepEqual(await (await fetch(new URL(path, base), { signal })).json(), { path })
  }
  for (const path of [
    '/projects',
    '/projects/default/chat/web%3Achat-example',
    '/projects/example/settings/bots',
    '/projects/example/logs',
  ]) {
    const projectPage = await fetch(new URL(path, base), { signal })
    assert.equal(projectPage.status, 200)
    assert.match(projectPage.headers.get('content-type') ?? '', /text\/html/)
    assert.match(await projectPage.text(), /src\/main\.ts/)
  }
  const page = await fetch(new URL('/nodes', base), { signal })
  assert.equal(page.status, 200)
  assert.match(await page.text(), /src\/main\.ts/)
  const component = await fetch(new URL('/src/components/ModelSelector.vue', base), { signal })
  assert.equal(component.status, 200)
  assert.match(await component.text(), /i-lucide-chevron-down/)
})

test('desktop Vite waits for IPC readiness and retargets every backend route without credentials', async (t) => {
  const backends = [1, 2].map((id) => createHttpServer((request, response) => {
    assert.equal(request.headers.authorization, undefined)
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ id, path: request.url }))
  }))
  const targets: string[] = []
  for (const [index, backend] of backends.entries()) {
    backend.on('upgrade', (request, socket) => {
      assert.equal(request.headers.authorization, undefined)
      socket.end(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX-Backend: ${index + 1}\r\n\r\n`)
    })
    backend.listen(0, '127.0.0.1')
    await once(backend, 'listening')
    t.after(() => { backend.closeAllConnections(); backend.close() })
    const address = backend.address()
    assert.ok(address && typeof address !== 'string')
    targets.push(`http://127.0.0.1:${address.port}`)
  }
  const messages = new EventEmitter()
  const routing = desktopBackendRouting(true, messages)
  const vite = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    configFile: false, envFile: false, logLevel: 'silent',
    optimizeDeps: { noDiscovery: true, include: [] },
    plugins: [routing.plugin],
    server: { host: '127.0.0.1', port: 0, strictPort: false, watch: null, proxy: routing.proxy },
  })
  t.after(() => vite.close())
  await vite.listen()
  const base = vite.resolvedUrls?.local[0]
  assert.ok(base)
  const paths = ['/api/config', '/v1/query/logs', '/nodes/v1', '/local/v1/web-session',
    '/host/v1', '/pair/v1', '/debug/test', '/projects/default/api/sessions', '/projects/default/local/v1/test']
  const get = (path: string) => fetch(new URL(path, base), { signal: AbortSignal.timeout(5000) })
  const upgrade = async () => {
    const url = new URL(base)
    const socket = createConnection({ host: url.hostname, port: Number(url.port) })
    socket.setTimeout(5000, () => socket.destroy(new Error('Upgrade timed out')))
    try {
      const data = once(socket, 'data')
      socket.write('GET /api/socket HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: c3ludGhldGljLXRlc3Qta2V5\r\n\r\n')
      return String((await data)[0])
    } finally { socket.destroy() }
  }
  for (const path of paths) {
    const response = await get(path)
    assert.equal(response.status, 503)
    assert.equal(response.headers.get('retry-after'), '1')
    assert.match((await response.json()).error, /not ready/)
  }
  assert.match(await upgrade(), /503 Service Unavailable/)
  messages.emit('message', { type: 'shadow:runtime-ready', apiBase: targets[0], launchToken: 'never-forward' })
  assert.equal((await get(paths[0]!)).status, 503)
  for (let index = 0; index < targets.length; index++) {
    messages.emit('message', { type: 'shadow:runtime-ready', apiBase: targets[index] })
    for (const path of paths) assert.deepEqual(await (await get(path)).json(), { id: index + 1, path })
    assert.match(await upgrade(), new RegExp(`x-backend: ${index + 1}`, 'i'))
  }
  messages.emit('message', { type: 'shadow:runtime-stopped' })
  for (const path of paths) assert.equal((await get(path)).status, 503)
  assert.match(await upgrade(), /503 Service Unavailable/)
  await vite.close()
  assert.equal(messages.listenerCount('message'), 0)
  assert.equal(messages.listenerCount('disconnect'), 0)
})
