import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { Bus } from '../bus/bus.ts'
import { WebChannel } from '../channels/web.ts'
import { GltfCaptureBridge } from '../gateway/gltf-capture.ts'
import { createGltfCaptureOwner } from '../gateway/gltf-capture-auth.ts'
import { GatewayClientAddressRegistry, registerGatewayRoutes } from '../gateway/server.ts'
import { GLTF_CAPTURE_HEADER, GLTF_CAPTURE_PATH } from '../gltf-capture-contract.ts'
import { DeviceChallengeAuthority, devicePublicKeyFingerprint, encodeBase64Url } from './device-challenge.ts'
import { requestDeviceChallengeProtocol } from './device-challenge-client.ts'
import { DeviceCredentialProof } from './device-credentials.ts'
import { DirectDeviceUi, DEVICE_UI_SESSION, DEVICE_UI_SESSION_CHALLENGE, DIRECT_DEVICE_UI_ROUTES, directDeviceUiPath, directDeviceCapturePath } from './direct-device-ui.ts'
import type { MainCluster } from './main-cluster.ts'
import { InMemoryPairingNodeRegistry } from './registry.ts'

const scope = { projectId: 'capture', sessionId: 'web:main', assetId: 'asset', version: 'v1' }
const image = { mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGNgAAIAAAUAAen63NgAAAAASUVORK5CYII=',
  camera: { position: [1, 2, 3], target: [0, 0, 0] }, objectIds: ['mesh'] }

test('direct paired workspace grants bind only a single device to its Viewer across Project routing', async t => {
  const endpoint = 'http://main.test:3124'
  const registry = new InMemoryPairingNodeRegistry(), authority = new DeviceChallengeAuthority(registry)
  const main = new Hono(), project = new Hono()
  const clientAddresses = new GatewayClientAddressRegistry()
  const ui = new DirectDeviceUi({ registry, authority, observeInventory: () => () => {} } as unknown as MainCluster, () => true)
  t.after(() => ui.close())
  registerGatewayRoutes(main, [ui.plugin()], { launchCredential: 'main-token', clientAddresses, authorizeClient: ui.authorize,
    launchCredentialExemptions: DIRECT_DEVICE_UI_ROUTES, delegatedViewer: { authorize: ui.authorize, ownerSignal: ui.ownerSignal,
      hasCredential: request => ui.hasCredential(request), allowsCrossOrigin: directDeviceUiPath, allowsCaptureBinding: directDeviceCapturePath } })
  const bridge = new GltfCaptureBridge(scope.projectId, createGltfCaptureOwner({ clientAddresses, launchCredential: 'main-token', deviceViewer: ui.captureSignal, delegated: ui.authorize,
  }), id => id === scope.sessionId)
  t.after(() => bridge.close())
  bridge.mount(project)
  const web = new WebChannel(new Bus(), { authorize: request => ui.authorize(request) })
  web.setReceiver(async message => {
    await bridge.admitWebInput(message)
    return { status: 'accepted', sessionId: `web:${message.chatId}`, inputId: message.messageId }
  })
  await web.start(project)
  t.after(() => web.stop())
  project.post('/api/echo-header', c => c.json({ binding: c.req.header(GLTF_CAPTURE_HEADER) ?? null, principal: !!ui.captureSignal(c.req.raw) }))
  main.all('/projects/capture/*', c => {
    const url = new URL(c.req.url)
    url.pathname = url.pathname.slice('/projects/capture'.length)
    const inner = new Request(url, c.req.raw)
    clientAddresses.inherit(c.req.raw, inner)
    return project.fetch(inner)
  })
  const networkFetch: typeof fetch = async (input, init) => main.fetch(new Request(input, init))
  async function child(n: number) {
    const keys = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey))
    const fingerprint = await devicePublicKeyFingerprint(raw)
    const now = new Date()
    registry.createOffer(`offer-${n}`, now, new Date(now.getTime() + 60_000))
    const presentation = { deviceId: `device-${n}`, nodeId: `node-${n}`, credentialId: `credential-${n}`,
      deviceIdentityFingerprint: fingerprint, devicePublicKey: encodeBase64Url(raw), displayName: 'Same display name' }
    registry.presentOffer({ ...presentation, offerId: `offer-${n}`, pendingId: `pending-${n}` }, now)
    const approved = registry.approve({ pendingId: `pending-${n}`, expectedDeviceIdentityFingerprint: fingerprint, credentialId: `credential-${n}` }, now)
    const identity = { deviceId: approved.deviceId, nodeId: approved.nodeId, credentialId: approved.credentialId }
    await authority.registerCredential(identity, encodeBase64Url(raw))
    const signer = new DeviceCredentialProof(async data => new Uint8Array(await crypto.subtle.sign('Ed25519', keys.privateKey, new Uint8Array(data))))
    const issue = async () => {
      const proof = await requestDeviceChallengeProtocol(endpoint, identity, signer, networkFetch,
        AbortSignal.timeout(5000), DEVICE_UI_SESSION_CHALLENGE)
      const result = await main.request(endpoint + DEVICE_UI_SESSION, { method: 'POST', headers: { 'X-Shadow-Device-Proof': proof } })
      assert.equal(result.status, 200)
      return (await result.json()).token
    }
    let token = await issue()
    const post = (path: string, data?: unknown, binding?: string) => main.request(endpoint + `/projects/capture${path}`, {
      method: 'POST', headers: { authorization: `ShadowDevice ${token}`, 'Content-Type': 'application/json', ...(binding ? { [GLTF_CAPTURE_HEADER]: binding } : {}) },
      body: data === undefined ? undefined : JSON.stringify(data),
    })
    const reapprove = async () => {
      const fresh = new Date()
      const offerId = `retry-offer-${n}`, pendingId = `retry-pending-${n}`
      registry.createOffer(offerId, fresh, new Date(fresh.getTime() + 60_000))
      registry.presentOffer({ ...presentation, offerId, pendingId }, fresh)
      registry.approve({ pendingId, expectedDeviceIdentityFingerprint: fingerprint, credentialId: identity.credentialId }, fresh)
      await authority.registerCredential(identity)
      token = await issue()
    }
    return { identity, post, reapprove }
  }
  const a = await child(1), b = await child(2)
  const forged = await main.request('/projects/capture' + GLTF_CAPTURE_PATH + '/register', {
    method: 'POST', headers: { authorization: 'Bearer main-token', 'Content-Type': 'application/json' }, body: JSON.stringify(scope),
  })
  assert.equal(forged.status, 403)
  const register = await a.post(`${GLTF_CAPTURE_PATH}/register`, scope)
  assert.equal(register.status, 200)
  const { binding } = await register.json() as { binding: string }
  const chat = { chatId: 'main', content: 'Inspect the bound canvas' }
  const [{ requestId: aTurn }, { requestId: bTurn }] = await Promise.all([
    (await a.post('/api/chat/send', chat, binding)).json(), (await b.post('/api/chat/send', chat, binding)).json(),
  ])
  assert(bridge.available(scope.sessionId, aTurn))
  assert(!bridge.available(scope.sessionId, bTurn))
  assert.equal((await b.post(`${GLTF_CAPTURE_PATH}/poll`, undefined, binding)).status, 409)
  const pending = bridge.capture(scope, aTurn, { mode: 'current' }, AbortSignal.timeout(3000))
  const job = await (await a.post(`${GLTF_CAPTURE_PATH}/poll`, undefined, binding)).json()
  assert.equal((await b.post(`${GLTF_CAPTURE_PATH}/result`, { id: job.id, result: image }, binding)).status, 409)
  assert.equal((await a.post(`${GLTF_CAPTURE_PATH}/result`, { id: job.id, result: image }, binding)).status, 204)
  assert.deepEqual(await pending, { ...image, version: 'v1' })
  assert.deepEqual(await (await a.post('/api/echo-header', undefined, binding)).json(), { binding: null, principal: false })
  const revokedJob = bridge.capture(scope, aTurn, { mode: 'top' }, AbortSignal.timeout(3000))
  const rejected = assert.rejects(revokedJob, /cancelled/)
  await a.post(`${GLTF_CAPTURE_PATH}/poll`, undefined, binding)
  registry.revoke(a.identity, 'unpaired', new Date())
  await rejected
  assert(!bridge.available(scope.sessionId, aTurn))
  assert.notEqual((await a.post(`${GLTF_CAPTURE_PATH}/register`, scope)).status, 200)
  await a.reapprove()
  assert.equal((await a.post(`${GLTF_CAPTURE_PATH}/poll`, undefined, binding)).status, 409)
  assert.equal((await a.post(`${GLTF_CAPTURE_PATH}/register`, scope)).status, 200)
})
