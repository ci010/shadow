import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { DeviceCredentialProof } from './device-credentials.ts'
import { MainDeviceUi, deviceUiPath, DEVICE_UI_REQUEST, DEVICE_UI_CHALLENGE } from './device-ui.ts'
import { DeviceChallengeAuthority, devicePublicKeyFingerprint, encodeBase64Url } from './device-challenge.ts'
import { InMemoryPairingNodeRegistry } from './registry.ts'
import type { MainCluster } from './main-cluster.ts'
import { GatewayClientAddressRegistry, registerGatewayRoutes } from '../gateway/server.ts'
import { childWorkspacePlugin } from '../runtime/child-workspace.ts'
import { requestDeviceChallengeProtocol } from './device-challenge-client.ts'
import { deviceChallengeApiPlugin } from './device-challenge-api.ts'

async function fixture() {
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
  const bridge = new MainDeviceUi({ registry, authority } as MainCluster, addresses, request => Promise.resolve(main.fetch(request)))
  const ingress = new Hono()
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
  const proof = (signal: AbortSignal, path: string) => requestDeviceChallengeProtocol('http://main.test:3124', identity, new DeviceCredentialProof(async bytes =>
    new Uint8Array(await crypto.subtle.sign('Ed25519', keys.privateKey, new Uint8Array(bytes)))), networkFetch, signal, path)
  const child = new Hono()
  registerGatewayRoutes(child, [], { launchCredential: 'child-private' })
  childWorkspacePlugin({ endpoint: 'http://main.test:3124', proof, fetch: networkFetch })(child)
  return { bridge, main, ingress, child, registry, proof }
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
