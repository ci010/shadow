import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import WebSocket, { WebSocketServer } from 'ws'
import { ChildLocalControlService } from '../runtime/child-local-control.ts'
import { normalizeGatewayUpgradeRequest } from '../gateway/websocket.ts'
import { serveGateway } from '../gateway/server.ts'
import { test } from 'node:test'
import { Hono } from 'hono'
import { DeviceCredentialProof } from './device-credentials.ts'
import { MainDeviceUi, deviceUiPath, deviceUiResourcePath, deviceUiRequestPath, DEVICE_UI_REQUEST, DEVICE_UI_CHALLENGE } from './device-ui.ts'
import { DeviceChallengeAuthority, devicePublicKeyFingerprint, encodeBase64Url } from './device-challenge.ts'
import { InMemoryPairingNodeRegistry } from './registry.ts'
import type { MainCluster } from './main-cluster.ts'
import { GatewayClientAddressRegistry, registerGatewayRoutes } from '../gateway/server.ts'
import { childWorkspacePlugin } from '../runtime/child-workspace.ts'
import { requestDeviceChallengeProtocol } from './device-challenge-client.ts'
import { deviceChallengeApiPlugin } from './device-challenge-api.ts'

async function fixture(developmentUrl?: string) {
  let endpoint = 'http://main.test:3124'
  const keys = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey))
  const fingerprint = await devicePublicKeyFingerprint(publicKey)
  const registry = new InMemoryPairingNodeRegistry()
  const now = new Date()
  registry.createOffer('offer-1', now, new Date(now.getTime() + 60_000))
  registry.presentOffer({ offerId: 'offer-1', pendingId: 'pending-1', deviceId: 'device-1', nodeId: 'node-1',
    deviceIdentityFingerprint: fingerprint, displayName: 'Trusted desktop' }, now)
  const authentication = registry.approve({ pendingId: 'pending-1', expectedDeviceIdentityFingerprint: fingerprint, credentialId: 'credential-1' }, now)
  const identity = { deviceId: authentication.deviceId, nodeId: authentication.nodeId, credentialId: authentication.credentialId }
  const authority = new DeviceChallengeAuthority(registry)
  await authority.registerCredential(authentication, encodeBase64Url(publicKey))
  const addresses = new GatewayClientAddressRegistry()
  const main = new Hono()
  const bridge = new MainDeviceUi({ registry, authority } as MainCluster, addresses, request => Promise.resolve(main.fetch(request)), developmentUrl)
  const ingress = new Hono()
  ingress.use('*', async (c, next) => { normalizeGatewayUpgradeRequest(c); await next() })
  bridge.plugin()(ingress)
  deviceChallengeApiPlugin({ authority, clientKey: () => 'test-child' })(ingress)
  registerGatewayRoutes(main, [], { launchCredential: 'main-private', clientAddresses: addresses, authorizeClient: request => bridge.authorize(request) })
  main.get('/api/projects', c => c.json({ projects: [{ id: 'same-main-project' }] }))
  main.post('/api/echo', async c => new Response(await c.req.text(), { headers: { 'Content-Type': c.req.header('Content-Type')! } }))
  main.get('/api/stream', c => new Response(new ReadableStream({ start(output) {
    output.enqueue(new TextEncoder().encode('data: ready\n\n'))
    c.req.raw.signal.addEventListener('abort', () => output.error(new Error('revoked')), { once: true })
  } }), { headers: { 'Content-Type': 'text/event-stream' } }))
  const networkFetch = ((input: string | URL | Request, init?: RequestInit) => ingress.fetch(new Request(input, init))) as typeof fetch
  const proof = (signal: AbortSignal, path: string) => requestDeviceChallengeProtocol(endpoint, identity, new DeviceCredentialProof(async bytes =>
    new Uint8Array(await crypto.subtle.sign('Ed25519', keys.privateKey, new Uint8Array(bytes)))), networkFetch, signal, path)
  const child = new Hono()
  registerGatewayRoutes(child, [], { launchCredential: 'child-private' })
  childWorkspacePlugin({ endpoint: 'http://main.test:3124', proof, fetch: networkFetch })(child)
  return { bridge, main, ingress, child, registry, proof, setEndpoint: (value: string) => { endpoint = value } }
}

test('workspace tunnels only business routes, never control/credentials or path escapes', () => {
  for (const path of ['/api/projects', '/projects/p1/api/sessions', '/api/live?topics=projects', '/api/media?chatId=chat&path=%2Fhome%2Fuploads%2Fpasted.png', '/projects/p1/api/media?path=C%3A%5Cuploads%5Cpasted%2Epng&download=1', '/nodes/v1', '/host/v1/query']) assert.equal(deviceUiPath(path), true, path)
  for (const path of ['/local/v1/stop', '/cluster/v1/node', '/pair/v1/offers', '/api/web-auth/pair', '/api/mobile',
    '/projects/p1/api/web-auth/session', '//evil.test/api/projects', '/api/../local/v1', '/api/%2e%2e/local', '/api/%2fmedia?path=%2Fuploads%2Fimage.png', '/api/%5cmedia?path=ok', '/api\\local']) assert.equal(deviceUiPath(path), false, path)
})

test('approved Child uses same Main projects and streaming uploads; no generic bearer or unauthenticated loopback access', async t => {
  const f = await fixture(); t.after(() => f.bridge.close())
  assert.equal((await f.child.request('/api/projects')).status, 401)
  const headers = { Authorization: 'Bearer child-private' }
  const response = await f.child.request('/api/projects', { headers })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { projects: [{ id: 'same-main-project' }] })
  const uploaded = await f.child.request('/api/echo', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream' }, body: 'file bytes' })
  assert.equal(uploaded.status, 200); assert.equal(await uploaded.text(), 'file bytes')
  assert.equal((await f.main.request('/api/projects', { headers: { Authorization: 'Bearer child-private' } })).status, 401)
  assert.equal((await f.child.request('/local/v1/stop', { method: 'POST', headers })).status, 404)
})

test('UI proofs are single use, purpose bound, and revoke active streams together with device trust', async t => {
  const f = await fixture(); t.after(() => f.bridge.close())
  const nodeProtocol = await f.proof(new AbortController().signal, '/cluster/v1/challenges')
  assert.equal((await f.ingress.request(`http://main.test:3124${DEVICE_UI_REQUEST}`, {
    method: 'POST', headers: { 'X-Shadow-Device-Proof': nodeProtocol, 'X-Shadow-Ui-Path': '/api/projects', 'X-Shadow-Ui-Method': 'GET' },
  })).status, 401, 'execution connection proof is not a workspace proof')
  const protocol = await f.proof(new AbortController().signal, DEVICE_UI_CHALLENGE)
  const init = { method: 'POST', headers: { 'X-Shadow-Device-Proof': protocol, 'X-Shadow-Ui-Path': '/api/projects', 'X-Shadow-Ui-Method': 'GET' } }
  assert.equal((await f.ingress.request(`http://main.test:3124${DEVICE_UI_REQUEST}`, init)).status, 200)
  assert.equal((await f.ingress.request(`http://main.test:3124${DEVICE_UI_REQUEST}`, init)).status, 401)
  const stream = await f.child.request('/api/stream', { headers: { Authorization: 'Bearer child-private' } })
  assert.equal(stream.status, 200)
  const reader = stream.body!.getReader(); assert.match(new TextDecoder().decode((await reader.read()).value), /ready/)
  f.registry.revoke({ deviceId: 'device-1', nodeId: 'node-1', credentialId: 'credential-1' }, 'removed', new Date())
  await assert.rejects(reader.read())
  assert.equal((await f.child.request('/api/projects', { headers: { Authorization: 'Bearer child-private' } })).status, 503)
})


test('renderer resources are read-only and never broaden device/control admission', () => {
  for (const path of ['/', '/assets/main.js', '/assets/main.css', '/@vite/client', '/src/main.ts?t=123', '/node_modules/.vite-shadow-app/deps/vue.js', '/@fs/repo/node_modules/.pnpm/pdfjs-dist@1/node_modules/pdfjs-dist/build/pdf.worker.mjs', '/projects/p1/chat']) {
    assert.equal(deviceUiResourcePath(path), true, path)
    assert.equal(deviceUiRequestPath(path, 'GET'), true, path)
    assert.equal(deviceUiRequestPath(path, 'POST'), false, path)
  }
  for (const path of ['/local/v1/stop', '/cluster/v1/ui/hmr', '/pair/v1/offers', '/api/web-auth/session', '/.env', '/.git/config', '/foo/../local/v1', '/%2eenv', '//evil.test/a']) {
    assert.equal(deviceUiResourcePath(path), false, path)
  }
})

test('Child loopback serves remote HTML/CSS/JS using device proof, not a Main bearer', async t => {
  const f = await fixture(); t.after(() => f.bridge.close())
  const resources = [
    ['/', 'text/html', '<html>remote Shadow</html>'],
    ['/assets/main.css', 'text/css', 'body { color: red }'],
    ['/assets/main.js', 'application/javascript', 'globalThis.remoteShadow = true'],
  ]
  for (const [path, contentType, content] of resources) f.main.get(path!, c => c.body(content!, 200, { 'Content-Type': contentType! }))
  for (const [path, contentType, content] of resources) {
    assert.equal((await f.child.request(path!)).status, 401)
    const response = await f.child.request(path!, { headers: { Authorization: 'Bearer child-private' } })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), contentType)
    assert.equal(await response.text(), content)
  }
})

test('authenticated Child HMR bridges text/binary both ways and closes after device revocation', { timeout: 10000 }, async t => {
  const vite = createServer()
  const wss = new WebSocketServer({ server: vite })
  vite.listen(0, '127.0.0.1'); await once(vite, 'listening')
  t.after(() => { for (const socket of wss.clients) socket.terminate(); wss.close(); vite.close() })
  const port = (vite.address() as { port: number }).port
  wss.on('connection', (socket, request) => {
    assert.equal(request.url, '/?token=synthetic-vite-token')
    assert.equal(socket.protocol, 'vite-hmr')
    assert.equal(request.headers.authorization, undefined)
    socket.send(JSON.stringify({ type: 'connected' }))
    socket.on('message', (data, binary) => socket.send(data, { binary }))
  })
  const f = await fixture(`http://127.0.0.1:${port}`); t.after(() => f.bridge.close())
  const mainServer = serveGateway(f.ingress, { host: '127.0.0.1', port: 0 }); await mainServer.ready
  t.after(() => mainServer.shutdown())
  const endpoint = `http://127.0.0.1:${mainServer.addr.port}`
  f.setEndpoint(endpoint)
  const child = new ChildLocalControlService({ port: 0, launchCredential: 'child-private', requestShutdown: () => {}, workspace: childWorkspacePlugin({ endpoint, proof: f.proof }) })
  await child.start(new AbortController().signal); t.after(() => child.shutdown())
  const origin = `http://127.0.0.1:${child.address!.port}`
  const rejected = new WebSocket(origin.replace('http:', 'ws:') + '/?token=synthetic-vite-token', 'vite-hmr')
  const denied = await once(rejected, 'error'); assert.match(String(denied[0]), /401/)
  const socket = new WebSocket(origin.replace('http:', 'ws:') + '/?token=synthetic-vite-token', 'vite-hmr', { headers: { Authorization: 'Bearer child-private', Origin: origin } })
  t.after(() => socket.terminate())
  const [connected] = await once(socket, 'message'); assert.equal(connected.toString(), '{"type":"connected"}')
  socket.send('ping'); const [text, textBinary] = await once(socket, 'message'); assert.equal(text.toString(), 'ping'); assert.equal(textBinary, false)
  socket.send(Buffer.from([0, 255, 3])); const [binary, isBinary] = await once(socket, 'message'); assert.deepEqual(binary, Buffer.from([0, 255, 3])); assert.equal(isBinary, true)
  const closed = once(socket, 'close')
  f.registry.revoke({ deviceId: 'device-1', nodeId: 'node-1', credentialId: 'credential-1' }, 'removed', new Date())
  await closed
})
