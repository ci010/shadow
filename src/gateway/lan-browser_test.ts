import assert from 'node:assert/strict'
import test from 'node:test'
import { once } from 'node:events'
import { Hono } from 'hono'
import { BrowserAuth } from './web-auth.ts'
import { GatewayClientAddressRegistry, registerGatewayRoutes } from './server.ts'
import { isPrivateLanAddress } from './lan-browser.ts'

test('LAN address policy excludes loopback, public, DNS, wildcard and link-local', () => {
  for (const host of ['10.1.2.3', '172.16.0.1', '172.31.255.254', '192.168.1.2']) assert(isPrivateLanAddress(host))
  for (const host of ['127.0.0.1', '0.0.0.0', '169.254.1.1', '172.32.1.1', '8.8.8.8', 'example.com', '::1', '192.168.999.1']) assert(!isPrivateLanAddress(host))
})

test('explicit LAN opt-in permits same-origin phone cookie login but never bearer or control access; disable revokes', async t => {
  const registry = new GatewayClientAddressRegistry()
  const local = 'http://127.0.0.1:43123'
  const lan = 'http://192.168.1.20:43124'
  let enabled = false
  const auth = new BrowserAuth({ launchCredential: 'synthetic-secret', clientAddresses: registry,
    enableLan: async () => { enabled = true; return [lan + '/', 'http://10.1.1.20:43125/'] },
    disableLan: async () => { enabled = false } })
  t.after(() => auth.close())
  const app = new Hono()
  registerGatewayRoutes(app, [auth.plugin(), app => {
    app.get('/', c => c.text('shell'))
    app.get('/api/private', c => c.json({ ok: true }))
    app.post('/local/v1/shutdown', c => c.json({ unsafe: true }))
    app.get('/cluster/test', c => c.json({ unsafe: true }))
  }], { browserAuth: auth, launchCredential: 'synthetic-secret', clientAddresses: registry })
  const request = (origin: string, path: string, init: RequestInit = {}, peer = '192.168.1.30') => {
    const req = new Request(origin + path, init)
    registry.capture(req, { transport: 'tcp', hostname: peer })
    return Promise.resolve(origin === lan ? auth.guardLanRequest(req) ?? app.request(req) : app.request(req))
  }
  const manage = (mode: string) => request(local, '/local/v1/web-pairing?lan=' + mode,
    { method: 'POST', headers: { authorization: 'Bearer synthetic-secret' } }, '127.0.0.1')
  assert.equal((await request(lan, '/')).status, 403)
  assert.equal((await manage('invalid')).status, 400)
  const offer = await (await manage('true')).json()
  assert(enabled)
  assert.match(offer.code, /^\d{8}$/)
  assert.equal(offer.url, lan + '/')
  assert.equal(offer.urls.length, 2)
  const pair = (code: string, origin = lan) => request(lan, '/api/web-auth/pair', {
    method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ code }) })
  assert.equal((await pair(offer.code, 'http://evil.invalid')).status, 403)
  const login = await pair(offer.code)
  assert.equal(login.status, 200)
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!
  assert.equal((await pair(offer.code)).status, 401)
  assert.equal((await request(lan, '/api/private', { headers: { cookie } })).status, 200)
  for (const path of ['/local/v1/shutdown', '/cluster/test', '/local/v1/web-pairing']) {
    assert.equal((await request(lan, path, { method: 'POST', headers: { cookie, origin: lan } })).status, 403)
    assert.equal((await request(lan, path, { method: 'POST', headers: { authorization: 'Bearer synthetic-secret' } })).status, 403)
  }
  assert.equal((await request(lan, '/api/private', { headers: { cookie } }, '8.8.8.8')).status, 403)
  await manage('false')
  assert(!enabled)
  assert.equal((await request(lan, '/api/private', { headers: { cookie } })).status, 403)
})

test('real separate listener enforces its guard for HTTP and WebSocket and closes without closing Main websocket adapter', async () => {
  const { serveGateway } = await import('./server.ts')
  const { upgradeGatewayWebSocket } = await import('./websocket.ts')
  const { default: WS } = await import('ws')
  const registry = new GatewayClientAddressRegistry()
  const auth = new BrowserAuth({ launchCredential: 'synthetic-secret', clientAddresses: registry })
  const app = new Hono()
  registerGatewayRoutes(app, [auth.plugin(), app => {
    app.get('/api/socket', c => upgradeGatewayWebSocket(app, c, socket => socket.send('ready')))
    app.post('/local/v1/shutdown', c => c.json({ unsafe: true }))
  }], { browserAuth: auth, launchCredential: 'synthetic-secret', clientAddresses: registry })
  const main = serveGateway(app, { host: '127.0.0.1', port: 0, clientAddresses: registry })
  const lan = serveGateway(app, { host: '127.0.0.1', port: 0, clientAddresses: registry,
    sharedWebSockets: true, requestGuard: req => auth.guardLanRequest(req) })
  try {
    await Promise.all([main.ready, lan.ready])
    auth.lanPorts.add(lan.addr.port)
    const origin = `http://127.0.0.1:${lan.addr.port}`
    auth.lanOrigins.add(origin)
    assert.equal((await fetch(origin + '/local/v1/shutdown', { method: 'POST', headers: { authorization: 'Bearer synthetic-secret' } })).status, 403)
    const blocked = new WS(origin.replace('http:', 'ws:') + '/api/socket', { headers: { authorization: 'Bearer synthetic-secret' } })
    await new Promise<void>((resolve, reject) => {
      blocked.on('unexpected-response', (_req, res) => { assert.equal(res.statusCode, 403); res.resume(); blocked.terminate(); resolve() })
      blocked.on('open', () => { blocked.terminate(); reject(new Error('Guard bypassed on upgrade')) })
      blocked.on('error', () => {})
    })
    await lan.shutdown()
    const socket = new WS(`ws://127.0.0.1:${main.addr.port}/api/socket`, { headers: { authorization: 'Bearer synthetic-secret' } })
    const message = await once(socket, 'message')
    assert.equal(String(message[0]), 'ready')
    socket.terminate()
  } finally { auth.close(); await lan.shutdown(); await main.shutdown() }
})
