import assert from 'node:assert/strict'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { folderFixture } from '../folders/test-fixtures.ts'
import { createHtmlPreview } from '../gateway/html-preview.ts'
import { once } from 'node:events'
import { createServer, get as httpGet } from 'node:http'
import { gunzipSync } from 'node:zlib'
import { WebChannel } from '../channels/web.ts'
import { Bus } from '../bus/bus.ts'
import type { SessionManager } from '../sessions/session-manager.ts'
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
  main.get('/projects/p1/api/agent-types', c => c.json([{ name: 'general', source: 'builtin' }]))
  main.get('/projects/p1/api/agent-types/general/context', c => c.json({ systemPrompt: 'Role preview', tools: [], channel: c.req.query('channel') }))
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
  return { bridge, main, ingress, child, registry, addresses, proof, networkFetch, setEndpoint: (value: string) => { endpoint = value } }
}

test('workspace tunnels only business routes, never control/credentials or path escapes', () => {
  for (const path of ['/api/models', '/projects/p1/api/models', '/api/projects', '/projects/p1/api/sessions', '/api/live?topics=projects', '/api/media?chatId=chat&path=%2Fhome%2Fuploads%2Fpasted.png', '/projects/p1/api/media?path=C%3A%5Cuploads%5Cpasted%2Epng&download=1', '/nodes/v1', '/host/v1/query']) assert.equal(deviceUiPath(path), true, path)
  for (const path of ['/api/agent-types/general', '/api/agent-types/general/context/extra', '/debug/models', '/local/v1/stop', '/cluster/v1/node', '/pair/v1/offers', '/api/web-auth/pair', '/api/mobile',
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

test('Child preview relay owns create/read/revoke across gateways without sharing API authority', { timeout: 10_000 }, async t => {
  const f = await fixture(); t.after(() => f.bridge.close())
  const { workspace } = await folderFixture(t)
  await mkdir(join(workspace, 'page'))
  await writeFile(join(workspace, 'page', 'index.html'), '<script src="asset.js"></script>')
  await writeFile(join(workspace, 'page', 'asset.js'), 'globalThis.preview = true')
  await writeFile(join(workspace, 'secret.txt'), 'outside-preview')
  let available = true
  f.main.post('/projects/test/api/folders/local/html-preview', c => createHtmlPreview(c, async () => available ? workspace : undefined))
  let upstreamUrl = ''
  let revokedPath = ''
  const revoked = Promise.withResolvers<void>()
  const transport: typeof fetch = async (input, init) => {
    const response = await f.networkFetch(input, init)
    const headers = new Headers(init?.headers)
    if (headers.get('X-Shadow-Ui-Method') === 'POST' && response.ok) upstreamUrl = (await response.clone().json()).url
    if (headers.get('X-Shadow-Ui-Method') === 'DELETE') { revokedPath = headers.get('X-Shadow-Ui-Path')!; revoked.resolve() }
    return response
  }
  const service = new ChildLocalControlService({ port: 0, launchCredential: 'child-private', requestShutdown: () => {},
    workspace: childWorkspacePlugin({ endpoint: 'http://main.test:3124', proof: f.proof, fetch: transport }),
  })
  t.after(() => service.shutdown())
  await service.start(new AbortController().signal)
  const base = `http://127.0.0.1:${service.address!.port}`
  const headers = { Authorization: 'Bearer child-private', Origin: base }
  const create = async () => {
    const response = await fetch(base + '/projects/test/api/folders/local/html-preview?path=page/index.html', { method: 'POST', headers })
    assert.equal(response.status, 200)
    return await response.json() as { url: string; revokeUrl: string }
  }
  assert.equal((await fetch(base + '/projects/test/api/folders/local/html-preview?path=page/index.html', { method: 'POST' })).status, 401)
  const lease = await create()
  const read = (path: string) => fetch(base + path, { headers: { Origin: 'null', 'Sec-Fetch-Site': 'cross-site' } })
  const response = await read(lease.url)
  assert.equal(response.status, 200)
  assert.match(await response.text(), /asset.js/)
  assert.notEqual(lease.url, upstreamUrl, 'upstream token stays on the server')
  assert.equal((await read(upstreamUrl)).status, 404, 'upstream token cannot consume the local store')
  assert.equal((await f.main.request('http://workspace.internal' + upstreamUrl)).status, 200)
  assert.equal((await f.main.request(base + upstreamUrl)).status, 404, 'Main lease retains its synthetic origin binding')
  const prefix = lease.url.slice(0, lease.url.lastIndexOf('/') + 1)
  const csp = response.headers.get('content-security-policy')!
  assert.ok(csp.includes(base + prefix))
  assert.ok(!csp.includes('workspace.internal'))
  assert.match(csp, /sandbox allow-scripts;/)
  assert.doesNotMatch(csp, /allow-same-origin/)
  assert.equal((await read(prefix + 'asset.js')).status, 200)
  assert.equal((await fetch(base + lease.url, { method: 'HEAD' })).status, 200)
  assert.equal((await read(prefix + '%2e%2e%2fsecret.txt')).status, 404)
  assert.equal((await read('/api/projects')).status, 401)
  assert.equal((await f.main.request('http://main.test:3124' + lease.url)).status, 404, 'Child token is not a Main capability')
  assert.equal((await f.child.request('http://other-child.test' + lease.url, { headers })).status, 404, 'another store/origin cannot consume Child token')
  assert.equal((await fetch(base + lease.revokeUrl, { method: 'DELETE' })).status, 401)
  assert.equal((await fetch(base + lease.revokeUrl, { method: 'DELETE', headers })).status, 204)
  assert.equal((await read(lease.url)).status, 404)
  await revoked.promise
  assert.equal(revokedPath, '/api/html-preview-leases/' + upstreamUrl.split('/')[3])
  assert.equal((await f.main.request('http://workspace.internal' + upstreamUrl)).status, 404, 'local revoke also disposes the Main lease')
  const removed = await create()
  available = false
  assert.equal((await read(removed.url)).status, 404, 'Main ownership is rechecked on relay reads')
  available = true
  const untrusted = await create()
  f.registry.revoke({ deviceId: 'device-1', nodeId: 'node-1', credentialId: 'credential-1' }, 'removed', new Date())
  assert.equal((await read(untrusted.url)).status, 404, 'fresh device proof is required for every relay read')
})


test('history gzip survives real Main/Child HTTP hops without double decoding or losing Vary', { timeout: 15_000 }, async t => {
  const f = await fixture(); t.after(() => f.bridge.close())
  const project = new Hono()
  const channel = new WebChannel(new Bus(), { authorize: request => f.bridge.authorize(request), sessionManager: {
    getSessionState: () => ({ sessionId: 'web:large', segmentIndex: 0 }),
    getContext: async () => ({ systemPrompt: 'Prompt', tools: [] }),
    getHistory: async () => ({ messages: [{ role: 'user', content: 'history fixture '.repeat(20_000) }] }),
    getCommandResults: async () => [], getYieldRecords: async () => [],
  } as unknown as SessionManager })
  await channel.start(project); t.after(() => channel.stop())
  f.main.all('/projects/test/*', c => {
    const url = new URL(c.req.url); url.pathname = url.pathname.slice('/projects/test'.length)
    const request = new Request(url, c.req.raw)
    f.addresses.inherit(c.req.raw, request)
    return project.fetch(request)
  })
  f.main.get('/api/range-fixture', c => c.body('234', 206, { 'Content-Type': 'application/octet-stream', 'Content-Range': 'bytes 2-4/10' }))
  f.main.get('/api/opaque-fixture', c => c.body('opaque', 200, { 'Content-Type': 'application/octet-stream', 'Content-Encoding': 'fixture-unknown' }))
  // Simulate an older Main that serves identity history even to an updated Child.
  f.main.get('/api/chat/session', c => c.json({ history: [{ content: 'old Main '.repeat(2000) }] }))
  const mainServer = serveGateway(f.ingress, { host: '127.0.0.1', port: 0 }); await mainServer.ready
  t.after(() => mainServer.shutdown())
  const endpoint = `http://127.0.0.1:${mainServer.addr.port}`; f.setEndpoint(endpoint)
  const transportEncodings: (string | null)[] = []
  const transport: typeof fetch = async (input, init) => {
    const response = await fetch(input, init)
    transportEncodings.push(response.headers.get('content-encoding'))
    return response
  }
  const child = new ChildLocalControlService({ port: 0, launchCredential: 'child-private', requestShutdown: () => {},
    workspace: childWorkspacePlugin({ endpoint, proof: f.proof, fetch: transport }),
  })
  await child.start(new AbortController().signal); t.after(() => child.shutdown())
  const base = `http://127.0.0.1:${child.address!.port}`
  const read = (encoding: string, etag?: string, path = '/projects/test/api/chat/session?chatId=large', authorized = true) => new Promise<{
    status: number; headers: import('node:http').IncomingHttpHeaders; bytes: Buffer
  }>((resolve, reject) => {
    // Native HTTP deliberately does NOT auto-decompress: assert actual wire bytes.
    const request = httpGet(base + path, { headers: { Origin: base, 'Accept-Encoding': encoding,
      ...(authorized ? { Authorization: 'Bearer child-private' } : {}), ...(etag ? { 'If-None-Match': etag } : {}),
    } }, response => {
      const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, bytes: Buffer.concat(chunks) }))
      response.on('error', reject)
    })
    request.on('error', reject)
  })
  for (const compatibility of [undefined, 'unsupported-version']) {
    const proof = await f.proof(new AbortController().signal, DEVICE_UI_CHALLENGE)
    const legacy = await fetch(endpoint + DEVICE_UI_REQUEST, { method: 'POST', headers: {
      'X-Shadow-Device-Proof': proof, 'X-Shadow-Ui-Path': '/projects/test/api/chat/session?chatId=large',
      'X-Shadow-Ui-Method': 'GET', 'Accept-Encoding': 'gzip',
      ...(compatibility ? { 'X-Shadow-Ui-Compression': compatibility } : {}),
    } })
    assert.equal(legacy.status, 200)
    assert.equal(legacy.headers.get('content-encoding'), null, 'old/unknown Child keeps identity responses despite Node fetch defaults')
    assert.equal((await legacy.json()).history[0].content, 'history fixture '.repeat(20_000))
  }
  const compressed = await read('gzip, deflate, br')
  assert.equal(compressed.status, 200)
  assert.equal(transportEncodings.at(-1), 'gzip', 'Main history is compressed across the network tunnel')
  assert.equal(compressed.headers['content-encoding'], 'gzip', 'Child negotiates browser-facing compression after fetch decoding')
  assert.match(String(compressed.headers.vary), /Accept-Encoding/i)
  assert.match(String(compressed.headers.vary), /Origin/i)
  const decoded = gunzipSync(compressed.bytes)
  assert.equal(JSON.parse(decoded.toString()).history[0].content, 'history fixture '.repeat(20_000))
  assert.ok(compressed.bytes.length < decoded.length / 10)
  for (const encoding of ['identity', 'gzip;q=0, *;q=1']) {
    const plain = await read(encoding)
    assert.equal(plain.status, 200)
    assert.equal(plain.headers['content-encoding'], undefined)
    assert.deepEqual(plain.bytes, decoded)
  }
  const olderMain = await read('gzip', undefined, '/api/chat/session?chatId=old')
  assert.equal(transportEncodings.at(-1), null)
  assert.equal(olderMain.headers['content-encoding'], 'gzip')
  assert.equal(JSON.parse(gunzipSync(olderMain.bytes).toString()).history[0].content, 'old Main '.repeat(2000))
  const unchanged = await read('gzip', String(compressed.headers.etag))
  assert.equal(unchanged.status, 304)
  assert.equal(unchanged.bytes.length, 0)
  const range = await read('gzip', undefined, '/api/range-fixture')
  assert.equal(range.status, 206)
  assert.equal(range.headers['content-encoding'], undefined)
  assert.equal(range.headers['content-range'], 'bytes 2-4/10')
  assert.equal(range.bytes.toString(), '234')
  const opaque = await read('gzip', undefined, '/api/opaque-fixture')
  assert.equal(opaque.headers['content-encoding'], 'fixture-unknown', 'do not strip an encoding that fetch did not decode')
  assert.equal(opaque.bytes.toString(), 'opaque')
  assert.equal((await read('gzip', undefined, undefined, false)).status, 401)
})

test('approved Child can browse role definitions and context without opening role mutations', async t => {
  const f = await fixture(); t.after(() => f.bridge.close())
  const headers = { Authorization: 'Bearer child-private' }
  for (const path of ['/api/agent-types', '/projects/p1/api/agent-types/general/context']) {
    assert.equal(deviceUiPath(path), true, path)
    assert.equal(deviceUiPath(path, 'HEAD'), true, path)
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      assert.equal(deviceUiPath(path, method), false, `${method} ${path}`)
      assert.equal((await f.child.request(path, { method, headers })).status, 404)
    }
  }
  const list = '/projects/p1/api/agent-types'
  assert.equal((await f.child.request(list)).status, 401)
  const response = await f.child.request(list, { headers })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), [{ name: 'general', source: 'builtin' }])
  const context = await f.child.request(`${list}/general/context?channel=web`, { headers })
  assert.equal(context.status, 200)
  assert.deepEqual(await context.json(), { systemPrompt: 'Role preview', tools: [], channel: 'web' })
})
