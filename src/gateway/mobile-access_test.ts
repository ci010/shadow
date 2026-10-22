import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { MobileAccess, mobileGatewayConfig } from './mobile-access.ts'
import { GatewayClientAddressRegistry, registerGatewayRoutes, serveGateway } from './server.ts'

const credential = 'test-owner-launch-credential'
const publicOrigin = 'https://shadow.example.test'
const nativeOrigin = 'capacitor://localhost'

function fixture() {
  let now = Date.now()
  let liveSignal: AbortSignal | undefined
  const addresses = new GatewayClientAddressRegistry()
  const access = new MobileAccess({ publicOrigin, launchCredential: credential, clientAddresses: addresses, now: () => now })
  const main = new Hono()
  registerGatewayRoutes(main, [access.managementPlugin(), app => {
    app.get('/api/private', c => c.json({ authorized: access.authorizeMain(c.req.raw), cookie: c.req.header('Cookie') ?? null }))
    app.post('/projects/default/api/private', async c => c.json({ body: await c.req.json(), authorized: access.authorizeMain(c.req.raw) }))
    app.get('/api/live', c => { liveSignal = c.req.raw.signal; return c.text('event: ready\ndata: {}\n\n') })
    app.get('/projects/default/api/media', c => c.text(c.req.query('path') ?? '', 200, { 'Set-Cookie': 'must-not-leak=x' }))
    app.get('/projects/default/api/sessions/:id/raw', c => c.html('<script>untrusted()</script>'))
    app.get('/projects/default/api/folders/:id/raw', c => c.body(new Uint8Array([1, 2, 3]), 200, { 'Content-Type': 'application/octet-stream' }))
    app.get('/api/redirect', c => c.redirect('https://external.test'))
    app.get('/local/v1/readiness', c => c.json({ ready: true }))
  }], { launchCredential: credential, clientAddresses: addresses, authorizeClient: request => access.authorizeMain(request) })
  const remote = access.createGateway(main)
  function request(app: Hono, path: string, init: RequestInit = {}, peer = '127.0.0.1') {
    const request = new Request(`http://127.0.0.1:3123${path}`, init)
    addresses.capture(request, { transport: 'tcp', hostname: peer })
    return app.request(request)
  }
  const owner = (path: string, method = 'POST', headers: Record<string, string> = {}, peer?: string) =>
    request(main, path, { method, headers: { Authorization: `Bearer ${credential}`, ...headers } }, peer)
  const client = (path: string, token?: string, init: RequestInit = {}) =>
    request(remote, path, { ...init, headers: { Origin: nativeOrigin, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...Object.fromEntries(new Headers(init.headers)) } })
  async function code() {
    const response = await owner('/local/v1/mobile-pairing')
    assert.equal(response.status, 200)
    return (await response.json()).code as string
  }
  const pair = (code: string) => client('/mobile/v1/pair', undefined, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }),
  })
  async function login() {
    const response = await pair(await code())
    assert.equal(response.status, 200)
    return (await response.json()).accessToken as string
  }
  return { main, remote, access, addresses, request, owner, client, code, pair, login,
    advance: (ms: number) => { now += ms }, liveSignal: () => liveSignal }
}

test('mobile access is explicitly configured and requires a canonical HTTPS deployment', () => {
  assert.equal(mobileGatewayConfig({}), undefined)
  assert.deepEqual(mobileGatewayConfig({ SHADOW_MOBILE_ORIGIN: `${publicOrigin}/` }), { publicOrigin, port: 3125 })
  for (const origin of ['http://host', 'https://user:pass@host', 'https://host/path', 'https://host?secret=x', 'https://host/#x']) {
    assert.throws(() => mobileGatewayConfig({ SHADOW_MOBILE_ORIGIN: origin }))
  }
  assert.throws(() => mobileGatewayConfig({ SHADOW_MOBILE_PORT: '3125' }))
  for (const port of ['0', '1023', '65536', 'Infinity']) assert.throws(() => mobileGatewayConfig({ SHADOW_MOBILE_ORIGIN: publicOrigin, SHADOW_MOBILE_PORT: port }))
})

test('mobile pairing uses single-use expiring owner codes, never browser or launch credentials', async t => {
  const f = fixture()
  t.after(() => f.access.close())
  assert.equal((await f.owner('/local/v1/mobile-pairing', 'POST', { Origin: nativeOrigin })).status, 403)
  assert.equal((await f.owner('/local/v1/mobile-pairing', 'POST', {}, '192.0.2.1')).status, 401)
  const code = await f.code()
  const response = await f.pair(code)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), nativeOrigin)
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
  const { accessToken } = await response.json()
  assert.equal((await f.pair(code)).status, 401)
  assert.equal((await f.client('/api/private', credential)).status, 401)
  assert.equal((await f.client('/api/private')).status, 401)
  assert.equal((await f.request(f.main, '/api/private', { headers: { Authorization: `Bearer ${accessToken}` } })).status, 401)
  assert.deepEqual(await (await f.client('/api/private', accessToken, { headers: { Cookie: 'shadow_web_default=bad' } })).json(), { authorized: true, cookie: null })
  assert.equal((await f.client('/mobile/v1/session', accessToken)).status, 200)
  const expired = await f.code()
  f.advance(300_001)
  assert.equal((await f.pair(expired)).status, 401)
  f.advance(12 * 60 * 60_000)
  assert.equal((await f.client('/mobile/v1/session', accessToken)).status, 401)
})

test('mobile ingress rejects other origins, non-loopback upstreams, control routes and redirects', async t => {
  const f = fixture()
  t.after(() => f.access.close())
  const token = await f.login()
  for (const path of ['/local/v1/readiness', '/pair/v1/offers', '/cluster/v1/nodes', '/api/web-auth/pair',
    '/projects/default/local/v1/shutdown', '/nodes/v1/network', '/', '/assets/main.js']) {
    assert.equal((await f.client(path, token)).status, 403, path)
  }
  assert.equal((await f.client('/api/private', token, { headers: { Origin: 'https://evil.test' } })).status, 403)
  assert.equal((await f.client('/api/private', token, { headers: { Origin: 'null' } })).status, 403)
  assert.equal((await f.request(f.remote, '/api/private', { headers: { Authorization: `Bearer ${token}` } }, '192.0.2.1')).status, 403)
  assert.equal((await f.client('/api/redirect', token)).status, 502)
  assert.equal((await f.client('/api/private', token, { headers: { Upgrade: 'websocket' } })).status, 400)
  assert.equal((await f.client('/api/private', undefined, { method: 'OPTIONS', headers: {
    'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type',
  } })).status, 204)
  assert.equal((await f.client('/api/private', undefined, { method: 'OPTIONS', headers: {
    'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'cookie',
  } })).status, 403)
  const result = await f.client('/projects/default/api/private', token, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"message":"hello"}',
  })
  assert.deepEqual(await result.json(), { authorized: true, body: { message: 'hello' } })
})

test('resource tickets authorize only exact reads, expire and revoke with the parent session', async t => {
  const f = fixture()
  t.after(() => f.access.close())
  const token = await f.login()
  const mint = (path: string) => f.client('/mobile/v1/resource-ticket', token, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }),
  })
  for (const path of ['/api/private', '//evil.test/api/media', '/local/v1/readiness', '/api/media?ticket=preexisting']) {
    assert([400, 403].includes((await mint(path)).status), path)
  }
  const response = await mint('/projects/default/api/media?path=some%20image.png&chatId=one')
  assert.equal(response.status, 200)
  const ticket = await response.json()
  const url = new URL(ticket.url)
  assert.equal(url.origin, publicOrigin)
  assert(!url.href.includes(token))
  const path = `${url.pathname}${url.search}`
  const media = await f.client(path)
  assert.equal(media.status, 200)
  assert.equal(await media.text(), 'some image.png')
  assert.equal(media.headers.get('Set-Cookie'), null)
  assert.equal(media.headers.get('Content-Security-Policy'), "sandbox; default-src 'none'")
  assert.equal(media.headers.get('Access-Control-Allow-Origin'), nativeOrigin)
  assert.equal((await f.client(path, undefined, { headers: { Range: 'bytes=0-4' } })).status, 200)
  assert.equal((await f.client(path.replace('chatId=one', 'chatId=two'))).status, 401)
  assert.equal((await f.client(path, undefined, { method: 'POST' })).status, 401)
  assert.equal((await f.client(path, token)).status, 401)
  f.advance(60_001)
  assert.equal((await f.client(path)).status, 401)
  const renewed = new URL((await (await mint('/projects/default/api/media?path=other.png')).json()).url)
  await f.client('/api/live', token)
  assert.equal(f.liveSignal()?.aborted, false)
  assert.equal((await f.client('/mobile/v1/session', token, { method: 'DELETE' })).status, 204)
  assert.equal(f.liveSignal()?.aborted, true)
  assert.equal((await f.client(`${renewed.pathname}${renewed.search}`)).status, 401)
})

test('mobile file previews use exact raw tickets but never authorize linked static pages', async t => {
  const f = fixture()
  t.after(() => f.access.close())
  const token = await f.login()
  for (const path of ['/projects/default/api/sessions/web%3Achat/raw?path=page.html',
    '/projects/default/api/folders/folder-id/raw?path=data.bin']) {
    const ticket = await f.client('/mobile/v1/resource-ticket', token, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }),
    })
    assert.equal(ticket.status, 200)
    const url = new URL((await ticket.json()).url)
    const response = await f.client(`${url.pathname}${url.search}`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('Content-Security-Policy'), "sandbox; default-src 'none'")
    assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer')
  }
  assert.equal((await f.client('/mobile/v1/resource-ticket', token, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: '{"path":"/projects/default/api/sessions/web%3Achat/static/index.html"}',
  })).status, 403)
})

test('owner can enumerate and revoke sessions without disclosing bearer credentials', async t => {
  const f = fixture()
  t.after(() => f.access.close())
  const token = await f.login()
  const response = await f.owner('/local/v1/mobile-sessions', 'GET')
  const text = await response.text()
  assert(!text.includes(token))
  const session = JSON.parse(text).sessions[0]
  assert.equal((await f.request(f.main, `/local/v1/mobile-sessions/${session.id}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${credential}` },
  }, '192.0.2.1')).status, 401)
  assert.equal((await f.owner(`/local/v1/mobile-sessions/${session.id}`, 'DELETE')).status, 204)
  assert.equal((await f.client('/api/private', token)).status, 401)
})

test('mobile session capacity, ticket capacity and service restart fail closed', async t => {
  const f = fixture()
  t.after(() => f.access.close())
  const tokens: string[] = []
  for (let i = 0; i < 32; i++) {
    if (i === 20) f.advance(60_001)
    tokens.push(await f.login())
  }
  const retainedCode = await f.code()
  assert.equal((await f.pair(retainedCode)).status, 429)
  assert.equal((await f.client('/mobile/v1/session', tokens[0], { method: 'DELETE' })).status, 204)
  assert.equal((await f.pair(retainedCode)).status, 200)
  const mint = () => f.client('/mobile/v1/resource-ticket', tokens[1], {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: '{"path":"/api/media?path=fixture.png"}',
  })
  for (let i = 0; i < 512; i++) assert.equal((await mint()).status, 200)
  assert.equal((await mint()).status, 429)
  f.advance(60_001)
  assert.equal((await mint()).status, 200)
  f.access.close()
  assert.equal((await f.client('/api/private', tokens[1])).status, 401)
})

test('mobile pair attempts and input sizes are bounded', async t => {
  const f = fixture()
  t.after(() => f.access.close())
  assert.equal((await f.client('/mobile/v1/pair', undefined, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'a'.repeat(9000) }),
  })).status, 413)
  for (let i = 0; i < 20; i++) assert.equal((await f.pair('A'.repeat(24))).status, 401)
  assert.equal((await f.pair(await f.code())).status, 429)
  f.advance(60_001)
  assert.equal((await f.pair(await f.code())).status, 200)
})

test('real mobile listener captures the proxy TCP peer and enforces authentication', async t => {
  const f = fixture()
  const server = serveGateway(f.remote, { port: 0, host: '127.0.0.1', clientAddresses: f.addresses })
  t.after(async () => { f.access.close(); await server.shutdown() })
  await server.ready
  const base = `http://127.0.0.1:${server.addr.port}`
  assert.equal((await fetch(`${base}/api/private`)).status, 401)
  const token = await f.login()
  const response = await fetch(`${base}/api/private`, { headers: { Authorization: `Bearer ${token}`, Origin: 'https://localhost' } })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://localhost')
})
