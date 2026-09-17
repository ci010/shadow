import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { registerGatewayRoutes, serveGateway, validateLaunchCredential } from '../gateway/server.ts'
import { MAIN_CLUSTER_LAUNCH_CREDENTIAL_EXEMPTIONS } from './main-cluster.ts'
import type { CapabilityDescriptorV1, VersionHelloV1 } from './contracts.ts'
import { mainNodeInventory, nodeInventoryApiPlugin, type NodeInventoryEntry } from './node-inventory.ts'
import { createNodeWebSocketApi } from './node-websocket-api.ts'
import { InMemoryPairingNodeRegistry } from './registry.ts'
import { setTimeout } from 'node:timers/promises'

const now = new Date('2026-09-01T00:00:00.000Z')
const auth = { deviceId: 'private-device', nodeId: 'child-1', credentialId: 'private-credential' }
const hello: VersionHelloV1 = {
  protocolMajor: 1,
  protocolMinor: 0,
  implementationVersion: 'test-version',
  features: ['capabilities-v1'],
}
const local: NodeInventoryEntry = {
  nodeId: 'configured-main',
  displayName: 'Main host',
  role: 'main',
  connection: 'connected',
  capabilities: [],
}
const capability: CapabilityDescriptorV1 = {
  version: 1,
  nodeId: auth.nodeId,
  capabilityId: 'workdir-1',
  kind: 'workdir',
  displayName: 'Remote folder',
  displayPath: '/child/opaque/folder',
  permissions: ['private-operation'],
  online: true,
}

function registryFixture(): InMemoryPairingNodeRegistry {
  const registry = new InMemoryPairingNodeRegistry()
  registry.createOffer('offer-1', now, new Date(now.getTime() + 60_000))
  registry.presentOffer({
    offerId: 'offer-1',
    pendingId: 'pending-1',
    ...auth,
    displayName: 'Child host',
    deviceIdentityFingerprint: 'private-fingerprint',
    devicePublicKey: Buffer.alloc(32, 9).toString('base64url'),
  }, now)
  registry.approve({
    pendingId: 'pending-1',
    expectedDeviceIdentityFingerprint: 'private-fingerprint',
    credentialId: auth.credentialId,
  }, now)
  registry.advertiseCapability(auth, capability)
  return registry
}

test('inventory authorization fails closed independently and retains launch protection', async () => {
  let reads = 0
  const inventory = () => {
    reads++
    return { version: 1 as const, nodes: [local] }
  }
  const app = new Hono()
  nodeInventoryApiPlugin({
    path: '/nodes/v1',
    authorize: () => false,
    inventory,
  })(app)
  const denied = await app.request('/nodes/v1', {
    headers: { Authorization: 'Bearer arbitrary' },
  })
  assert.equal(denied.status, 401)
  assert.equal(denied.headers.get('Cache-Control'), 'no-store')
  assert.equal(reads, 0)

  const protectedApp = new Hono()
  const credential = 'fixture-launch'
  registerGatewayRoutes(protectedApp, [nodeInventoryApiPlugin({
    path: '/nodes/v1',
    authorize: (request) => validateLaunchCredential(
      request.headers.get('Authorization') ?? undefined, credential,
    ),
    inventory,
  })], {
    launchCredential: credential,
    launchCredentialExemptions: MAIN_CLUSTER_LAUNCH_CREDENTIAL_EXEMPTIONS,
  })
  const unauthorizedHeaders: HeadersInit[] = [{}, { Authorization: 'Bearer incorrect' }]
  for (const headers of unauthorizedHeaders) {
    assert.equal((await protectedApp.request('/nodes/v1', { headers })).status, 401)
  }
  assert.equal(reads, 0)
  const allowed = await protectedApp.request('/nodes/v1', {
    headers: { Authorization: `Bearer ${credential}` },
  })
  assert.equal(allowed.status, 200)
  assert.equal(allowed.headers.get('Cache-Control'), 'no-store')
  assert.deepEqual(await allowed.json(), { version: 1, nodes: [local] })
  assert.equal(reads, 1)
  assert.equal((await protectedApp.request('/nodes/v1', {
    method: 'POST', headers: { Authorization: `Bearer ${credential}` },
  })).status, 404)
})

test('restored inventory is offline and only folders allowlisted remote fields', () => {
  const registry = registryFixture()
  const restored = new InMemoryPairingNodeRegistry()
  restored.restoreSnapshot(registry.exportSnapshot(now), now)
  assert.equal(restored.listCapabilities(auth.nodeId)[0].online, true)
  const inventory = mainNodeInventory(local, restored, {
    isNodeConnected: () => false,
    hasAdvertisedCapability: () => false,
  })
  assert.deepEqual(inventory.nodes[1], {
    nodeId: auth.nodeId,
    displayName: 'Child host',
    role: 'child',
    connection: 'offline',
    capabilities: [{
      capabilityId: 'workdir-1',
      kind: 'workdir',
      displayName: 'Remote folder',
      displayPath: '/child/opaque/folder',
      online: false,
    }],
  })
  assert.ok(!JSON.stringify(inventory).includes('private'))
  assert.ok(!JSON.stringify(inventory).includes(Buffer.alloc(32, 9).toString('base64url')))
  assert.ok(!JSON.stringify(inventory).includes('2026-'))
  const connected = mainNodeInventory(local, restored, {
    isNodeConnected: () => true,
    hasAdvertisedCapability: () => false,
  })
  assert.equal(connected.nodes[1].connection, 'connected')
  assert.equal(connected.nodes[1].capabilities[0].online, false)
  restored.advertiseCapability(auth, { ...capability, online: false })
  assert.equal(mainNodeInventory(local, restored, {
    isNodeConnected: () => true,
    hasAdvertisedCapability: () => true,
  }).nodes[1].capabilities[0].online, false)
  restored.revoke(auth, 'private-revocation-reason', now)
  const revoked = mainNodeInventory(local, restored, {
    isNodeConnected: () => true,
    hasAdvertisedCapability: () => true,
  })
  assert.deepEqual(revoked.nodes[1], {
    nodeId: auth.nodeId,
    displayName: 'Child host',
    role: 'child',
    connection: 'revoked',
    capabilities: [],
  })
  assert.ok(!JSON.stringify(revoked).includes('private'))
})

test('inventory follows actual node WebSocket authentication, advertisements and disconnects', async (t) => {
  const registry = registryFixture()
  const api = createNodeWebSocketApi({
    registry,
    localHello: hello,
    authorizeUpgrade: () => ({ authentication: auth }),
    session: { maxOutboundQueue: 16, heartbeatTimeoutMs: 60_000 },
  })
  const app = new Hono()
  registerGatewayRoutes(app, [
    api.plugin,
    nodeInventoryApiPlugin({
      path: '/nodes/v1',
      authorize: () => true,
      inventory: () => mainNodeInventory(local, registry, api),
    }),
  ])
  const server = serveGateway(app, { host: '127.0.0.1', port: 0 })
  await server.ready
  t.after(async () => {
    await api.closeAll()
    await server.shutdown()
  })
  const base = `http://127.0.0.1:${server.addr.port}`
  const remote = async () => (await (await fetch(`${base}/nodes/v1`)).json()).nodes[1]
  assert.equal((await remote()).connection, 'offline')
  const socket = new WebSocket(`${base.replace('http:', 'ws:')}/cluster/v1/node`)
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  assert.equal((await remote()).connection, 'offline')
  socket.send(JSON.stringify({ version: 1, sequence: 0, type: 'hello', hello }))
  socket.send(JSON.stringify({ version: 1, sequence: 1, type: 'authenticate', authentication: auth }))
  await waitFor(() => api.isNodeConnected(auth.nodeId))
  assert.equal((await remote()).connection, 'connected')
  assert.equal((await remote()).capabilities[0].online, false)
  socket.send(JSON.stringify({
    version: 1, sequence: 2, type: 'capability-advertise',
    capability: { ...capability, capabilityId: 'new-workdir' },
  }))
  await waitFor(() => registry.listCapabilities(auth.nodeId).length === 2)
  const advertised = await remote()
  assert.equal(advertised.capabilities.length, 2)
  assert.equal(advertised.capabilities[0].online, false)
  assert.equal(advertised.capabilities[1].online, true)
  assert.equal(advertised.capabilities[1].displayPath, '/child/opaque/folder')
  socket.send(JSON.stringify({
    version: 1, sequence: 3, type: 'capability-withdraw',
    nodeId: auth.nodeId, capabilityId: 'new-workdir',
  }))
  await waitFor(() => registry.listCapabilities(auth.nodeId).length === 1)
  assert.equal(api.hasAdvertisedCapability(auth.nodeId, 'new-workdir'), false)
  socket.close()
  await waitFor(() => !api.isNodeConnected(auth.nodeId))
  const disconnected = await remote()
  assert.equal(disconnected.connection, 'offline')
  assert.ok(disconnected.capabilities.every((value: { online: boolean }) => !value.online))
  assert.equal(disconnected.capabilities[0].displayPath, '/child/opaque/folder')
  const reconnected = new WebSocket(`${base.replace('http:', 'ws:')}/cluster/v1/node`)
  await new Promise<void>((resolve, reject) => {
    reconnected.addEventListener('open', () => resolve(), { once: true })
    reconnected.addEventListener('error', reject, { once: true })
  })
  reconnected.send(JSON.stringify({ version: 1, sequence: 0, type: 'hello', hello }))
  reconnected.send(JSON.stringify({
    version: 1, sequence: 1, type: 'authenticate', authentication: auth,
  }))
  await waitFor(() => api.isNodeConnected(auth.nodeId))
  assert.equal((await remote()).capabilities[0].online, false)
  reconnected.send(JSON.stringify({
    version: 1, sequence: 2, type: 'capability-advertise', capability,
  }))
  await waitFor(() => api.hasAdvertisedCapability(auth.nodeId, capability.capabilityId))
  assert.equal((await remote()).capabilities[0].online, true)
  registry.revoke(auth, 'private-revocation-reason', now)
  assert.equal((await remote()).connection, 'revoked')
  assert.deepEqual((await remote()).capabilities, [])
  reconnected.close()
})

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return
    await setTimeout(10)
  }
  assert.fail('Node connection state did not settle')
}
