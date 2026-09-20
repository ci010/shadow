import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'
import { Hono } from 'hono'
import WS from 'ws'
import { BrowserAuth, isPublicWebShell } from './web-auth.ts'
import { GatewayClientAddressRegistry, registerGatewayRoutes, serveGateway } from './server.ts'
import { upgradeGatewayWebSocket } from './websocket.ts'
import { RealtimeHub, registerRealtimeRoute } from '../realtime/hub.ts'

const origin = 'http://127.0.0.1:43123'
const credential = 'fixture-management-credential'

function fixture(options: { protected?: boolean; developmentUrl?: string } = {}) {
  let now = Date.now()
  const clientAddresses = new GatewayClientAddressRegistry()
  const launchCredential = options.protected === false ? undefined : credential
  const auth = new BrowserAuth({ clientAddresses, launchCredential, developmentUrl: options.developmentUrl, now: () => now })
  const app = new Hono()
  registerGatewayRoutes(app, [auth.plugin(), gateway => {
    gateway.get('/', c => c.html('<html>Pair this browser</html>'))
    gateway.get('/api/private', c => c.json({ ok: true }))
    gateway.post('/api/private', c => c.json({ ok: true }))
    gateway.get('/projects/default/api/private', c => c.json({ ok: auth.authorize(c.req.raw) }))
    gateway.get('/local/v1/readiness', c => c.json({ ready: true }))
    gateway.post('/local/v1/shutdown', c => c.json({ stopping: true }))
  }], { launchCredential, browserAuth: auth, clientAddresses, allowedOrigins: options.developmentUrl ? [options.developmentUrl] : [] })
  function request(path: string, init: RequestInit = {}, address = '127.0.0.1') {
    const request = new Request(origin + path, init)
    clientAddresses.capture(request, { transport: 'tcp', hostname: address })
    return app.request(request)
  }
  async function code() {
    const response = await request('/local/v1/web-pairing', {
      method: 'POST', headers: { authorization: `Bearer ${credential}` },
    })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const offer = await response.json()
    assert.match(offer.code, /^(?:[A-F0-9]{4}-){5}[A-F0-9]{4}$/)
    assert.equal(offer.url, origin + '/')
    assert.equal(Date.parse(offer.expiresAt), now + 300_000)
    return offer.code as string
  }
  async function pair(value: string, headers: Record<string, string> = {}) {
    return request('/api/web-auth/pair', {
      method: 'POST', headers: { origin, 'content-type': 'application/json', ...headers }, body: JSON.stringify({ code: value }),
    })
  }
  return { app, auth, clientAddresses, request, code, pair, advance: (ms: number) => { now += ms } }
}

function cookie(response: Response): string {
  const header = response.headers.get('set-cookie')
  assert(header)
  assert.match(header, /HttpOnly; SameSite=Strict; Path=\/; Max-Age=43200/)
  assert(!header.includes(credential))
  return header.split(';')[0]!
}

test('public shell and browser status do not unlock APIs or management controls', async t => {
  const f = fixture()
  t.after(() => f.auth.close())
  assert.equal((await f.request('/')).status, 200)
  const status = await f.request('/api/web-auth/session')
  assert.equal(status.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await status.json(), { version: 1, required: true, authenticated: false })
  for (const path of ['/api/private', '/projects/default/api/private', '/local/v1/readiness']) {
    assert.equal((await f.request(path)).status, 401)
  }
  assert.equal((await f.request('/local/v1/web-pairing', { method: 'POST' })).status, 401)
  const code = await f.code()
  const response = await f.pair(code.toLowerCase().replaceAll('-', ' '))
  assert.equal(response.status, 200)
  const session = await response.json()
  assert.equal(session.authenticated, true)
  const headers = { cookie: cookie(response), origin }
  assert.equal((await f.request('/api/private', { headers })).status, 200)
  assert.deepEqual(await (await f.request('/projects/default/api/private', { headers })).json(), { ok: true })
  assert.equal((await f.request('/api/private', { method: 'POST', headers })).status, 200)
  assert.equal((await f.request('/api/web-auth/session', { headers })).status, 200)
  assert.equal((await f.pair(code)).status, 401, 'codes are single use')
  for (const [path, method] of [
    ['/local/v1/readiness', 'GET'], ['/local/v1/shutdown', 'POST'], ['/local/v1/web-pairing', 'POST'],
    ['/projects/default/local/v1/shutdown', 'POST'], ['/pair/v1/offers', 'POST'], ['/cluster/v1/node', 'GET'],
  ]) assert.equal((await f.request(path!, { method, headers })).status, 401)
  assert.equal((await f.request('/local/v1/readiness', { headers: { authorization: `Bearer ${credential}` } })).status, 200)
  const logout = await f.request('/api/web-auth/session', { method: 'DELETE', headers })
  assert.equal(logout.status, 200)
  assert.match(logout.headers.get('set-cookie')!, /Max-Age=0/)
  assert.equal((await f.request('/api/private', { headers })).status, 401)
})

test('pairing expiry, session expiry and restart invalidate credentials', async t => {
  const f = fixture()
  t.after(() => f.auth.close())
  const expired = await f.code()
  f.advance(300_000)
  assert.equal((await f.pair(expired)).status, 401)
  const headers = { cookie: cookie(await f.pair(await f.code())), origin }
  f.advance(12 * 60 * 60_000)
  assert.equal((await f.request('/api/private', { headers })).status, 401)
  const next = { cookie: cookie(await f.pair(await f.code())), origin }
  f.auth.close()
  assert.equal((await f.request('/api/private', { headers: next })).status, 401)
})

test('browser authentication rejects CSRF, null origins, remote peers and malformed requests', async t => {
  const f = fixture()
  t.after(() => f.auth.close())
  const code = await f.code()
  const rejectedOrigins: Record<string, string>[] = [{ origin: 'null' }, { origin: 'http://127.0.0.1:9999' }, { origin, 'sec-fetch-site': 'cross-site' }]
  for (const headers of rejectedOrigins) {
    const response = await f.pair(code, headers)
    assert.equal(response.status, 403)
    assert.equal(response.headers.get('cache-control'), 'no-store')
  }
  assert.equal((await f.request('/api/web-auth/pair', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }),
  })).status, 403)
  assert.equal((await f.request('/api/web-auth/session', { headers: { 'x-forwarded-for': '127.0.0.1' } }, '192.0.2.1')).status, 403)
  assert.equal((await f.pair(code, { 'content-type': 'text/plain' })).status, 400)
  for (const body of ['bad json', '{}', '{"code":12}', 'null', '[]', '{"code":"x","extra":1}']) {
    assert.equal((await f.request('/api/web-auth/pair', {
      method: 'POST', headers: { origin, 'content-type': 'application/json' }, body,
    })).status, 400)
  }
  assert.equal((await f.pair('x'.repeat(1024))).status, 413)
  const headers = { cookie: cookie(await f.pair(code)) }
  assert.equal((await f.request('/api/private', { method: 'POST', headers })).status, 401)
  assert.equal((await f.request('/api/private', { headers: { ...headers, origin: 'null' } })).status, 401)
  assert.equal((await f.request('/api/private', { headers }, '192.0.2.1')).status, 401)
  assert.equal((await f.request('/api/private', { headers: { cookie: `${headers.cookie}; ${headers.cookie}` } })).status, 401)
  assert.equal((await f.request('/local/v1/web-pairing', {
    method: 'POST', headers: { authorization: `Bearer ${credential}`, origin },
  })).status, 401, 'management issuance cannot be invoked from a browser')
})

test('pair attempts and outstanding codes are bounded without consuming valid codes on throttling', async t => {
  const f = fixture()
  t.after(() => f.auth.close())
  const code = await f.code()
  for (let i = 0; i < 20; i++) assert.equal((await f.pair('not-a-code')).status, 401)
  assert.equal((await f.pair(code)).status, 429)
  f.advance(60_000)
  assert.equal((await f.pair(code)).status, 200)
  for (let i = 0; i < 32; i++) await f.code()
  const over = await f.request('/local/v1/web-pairing', { method: 'POST', headers: { authorization: `Bearer ${credential}` } })
  assert.equal(over.status, 429)
  f.advance(300_000)
  await f.code()
})

test('unprotected local development retains access and trusted Vite origin supports cookie sessions', async t => {
  const local = fixture({ protected: false })
  const dev = fixture({ developmentUrl: 'http://127.0.0.1:5273' })
  t.after(() => { local.auth.close(); dev.auth.close() })
  assert.deepEqual(await (await local.request('/api/web-auth/session')).json(), { version: 1, required: false, authenticated: true })
  assert.equal((await local.request('/api/private')).status, 200)
  const headers = { cookie: cookie(await dev.pair(await dev.code(), { origin: 'http://127.0.0.1:5273' })), origin: 'http://127.0.0.1:5273' }
  assert.equal((await dev.request('/api/private', { headers, method: 'POST' })).status, 200)
  for (const path of ['/', '/assets/app.js', '/projects/default/chat/web%3Atest', '/settings', '/nodes',
    '/workspaces', '/providers', '/approvals', '/settings/channels', '/settings/models/', '/settings/providers']) {
    assert(isPublicWebShell(new Request(origin + path)), path)
  }
  for (const path of ['/api/private', '/projects/default/api/private', '/local/v1/readiness', '/pair/v1/offers',
    '/health', '/@fs/private', '/settings/unknown', '/projects/default/settings/unknown', '/projects/unknown']) {
    assert(!isPublicWebShell(new Request(origin + path)), path)
  }
  assert(isPublicWebShell(new Request(origin + '/@vite/client'), true))
  assert(!isPublicWebShell(new Request(origin + '/', { method: 'POST' })))
})

test('browser sessions are bounded and capacity failures do not consume pairing codes', async t => {
  const f = fixture()
  t.after(() => f.auth.close())
  let firstCookie = ''
  for (let i = 0; i < 128; i++) {
    if (i % 20 === 0) f.advance(60_000)
    const response = await f.pair(await f.code())
    assert.equal(response.status, 200)
    if (i === 0) firstCookie = cookie(response)
  }
  const code = await f.code()
  assert.equal((await f.pair(code)).status, 503)
  assert.equal((await f.request('/api/web-auth/session', {
    method: 'DELETE', headers: { origin, cookie: firstCookie },
  })).status, 200)
  assert.equal((await f.pair(code)).status, 200)
})

test('real browser SSE and WebSocket connections end when their session is revoked', { timeout: 15_000 }, async t => {
  const f = fixture()
  const hub = new RealtimeHub()
  registerRealtimeRoute(f.app, hub, request => f.auth.authorize(request))
  f.app.get('/api/socket', c => upgradeGatewayWebSocket(f.app, c, socket => socket.send('connected')))
  const server = serveGateway(f.app, { host: '127.0.0.1', port: 0, clientAddresses: f.clientAddresses })
  await server.ready
  const base = `http://127.0.0.1:${server.addr.port}`
  let socket: WS | undefined
  t.after(async () => { socket?.terminate(); f.auth.close(); hub.close(); await server.shutdown() })
  const offer = await fetch(base + '/local/v1/web-pairing', { method: 'POST', headers: { authorization: `Bearer ${credential}` } })
  assert.equal(offer.status, 200)
  const { code } = await offer.json()
  const paired = await fetch(base + '/api/web-auth/pair', {
    method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ code }),
  })
  assert.equal(paired.status, 200)
  const headers = { cookie: cookie(paired), origin: base }
  const live = await fetch(base + '/api/live?topics=[]', { headers })
  assert.equal(live.status, 200)
  const reader = live.body!.getReader()
  await reader.read()
  socket = new WS(base.replace('http:', 'ws:') + '/api/socket', { headers, handshakeTimeout: 3000 })
  assert.equal((await once(socket, 'message'))[0].toString(), 'connected')
  const closed = once(socket, 'close')
  assert.equal((await fetch(base + '/api/web-auth/session', { method: 'DELETE', headers })).status, 200)
  assert.equal((await closed)[0], 1008)
  while (!(await reader.read()).done) { /* Drain already queued frames. */ }
  assert.equal((await fetch(base + '/api/private', { headers })).status, 401)
})
