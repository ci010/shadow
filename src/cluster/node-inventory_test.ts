import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { registerGatewayRoutes, serveGateway, validateLaunchCredential } from '../gateway/server.ts'
import { MAIN_CLUSTER_LAUNCH_CREDENTIAL_EXEMPTIONS } from './main-cluster.ts'
import type { ExecutionSupport, VersionHelloV1 } from './contracts.ts'
import { mainNodeInventory, nodeInventoryApiPlugin, type NodeInventoryEntry } from './node-inventory.ts'
import { createNodeWebSocketApi } from './node-websocket-api.ts'
import { InMemoryPairingNodeRegistry } from './registry.ts'
import { setTimeout } from 'node:timers/promises'
import { LEGACY_MANAGED_SERVICE_ID, MANAGED_SESSION_OPERATION } from '../execution/managed-workdir.ts'

const now = new Date('2026-09-01T00:00:00.000Z')
const auth = { deviceId: 'private-device', nodeId: 'child-1', credentialId: 'private-credential' }
const hello: VersionHelloV1 = {
  protocolMajor: 1,
  protocolMinor: 0,
  implementationVersion: 'test-version',
  features: ['workdir-execution-v2'],
}
const local: NodeInventoryEntry = {
  nodeId: 'configured-main',
  displayName: 'Main host',
  role: 'main',
  connection: 'connected',
  support: { operations: [] }, workdirs: [], executionProtocol: 'compatible',
}
const capability: ExecutionSupport = { operations: ['process.execute'] }

const workdir = { version: 2 as const, nodeId: auth.nodeId, workdirId: 'workdir-1', support: { operations: ['filesystem.read'] }, displayName: 'Remote folder', displayPath: '/child/opaque/folder', online: true }

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
  registry.advertiseWorkdir(auth, workdir)
  registry.advertiseNodeSupport(auth, auth.nodeId, capability)
  return registry
}

test('managed-session availability requires its actual live allocation permission', () => {
  const registry = registryFixture()
  let advertised = true
  const inventory = () => mainNodeInventory(undefined, registry, {
    isNodeConnected: () => true, hasAdvertisedNodeSupport: () => advertised, hasAdvertisedWorkdir: () => advertised, supportsExecutionProtocol: () => true,
  }).nodes[0]
  assert.equal(inventory().supportsManagedSessions, false)
  registry.advertiseNodeSupport(auth, auth.nodeId, { operations: ['process.execute'] })
  assert.equal(inventory().supportsManagedSessions, false)
  registry.advertiseNodeSupport(auth, auth.nodeId, { operations: [MANAGED_SESSION_OPERATION] })
  assert.equal(inventory().supportsManagedSessions, true)
  advertised = false
  assert.equal(inventory().supportsManagedSessions, false)
})

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
  assert.deepEqual(restored.nodeSupport(auth.nodeId), capability)
  const inventory = mainNodeInventory(local, restored, {
    isNodeConnected: () => false, hasAdvertisedWorkdir: () => false, supportsExecutionProtocol: () => true,
    hasAdvertisedNodeSupport: () => false,
  })
  assert.deepEqual(inventory.nodes[1], {
    nodeId: auth.nodeId,
    displayName: 'Child host',
    role: 'child',
    connection: 'offline',
    supportsManagedSessions: false,
    executionProtocol: 'unknown',
    workdirs: [{ ...workdir, online: false }],
    support: { operations: [] },
  })
  assert.ok(!JSON.stringify(inventory).includes('private'))
  assert.ok(!JSON.stringify(inventory).includes(Buffer.alloc(32, 9).toString('base64url')))
  assert.ok(!JSON.stringify(inventory).includes('2026-'))
  const connected = mainNodeInventory(local, restored, {
    isNodeConnected: () => true, hasAdvertisedWorkdir: () => true, supportsExecutionProtocol: () => true,
    hasAdvertisedNodeSupport: () => false,
  })
  assert.equal(connected.nodes[1].connection, 'connected')
  assert.equal(connected.nodes[1].support.operations.length, 0)
  restored.advertiseNodeSupport(auth, auth.nodeId, { operations: [] })
  assert.equal(mainNodeInventory(local, restored, {
    isNodeConnected: () => true, hasAdvertisedWorkdir: () => true, supportsExecutionProtocol: () => true,
    hasAdvertisedNodeSupport: () => true,
  }).nodes[1].support.operations.length, 0)
  restored.revoke(auth, 'private-revocation-reason', now)
  const revoked = mainNodeInventory(local, restored, {
    isNodeConnected: () => true, hasAdvertisedWorkdir: () => true, supportsExecutionProtocol: () => true,
    hasAdvertisedNodeSupport: () => true,
  })
  assert.deepEqual(revoked.nodes[1], {
    nodeId: auth.nodeId,
    displayName: 'Child host',
    role: 'child',
    connection: 'revoked',
    supportsManagedSessions: false,
    executionProtocol: 'unknown', workdirs: [],
    support: { operations: [] },
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
  ], { launchCredential: 'fixture-inventory', launchCredentialExemptions: MAIN_CLUSTER_LAUNCH_CREDENTIAL_EXEMPTIONS })
  const server = serveGateway(app, { host: '127.0.0.1', port: 0 })
  await server.ready
  t.after(async () => {
    await api.closeAll()
    await server.shutdown()
  })
  const base = `http://127.0.0.1:${server.addr.port}`
  const remote = async () => {
    const response = await fetch(`${base}/nodes/v1`, { headers: { Authorization: 'Bearer fixture-inventory' } })
    const body = await response.json()
    assert.equal(response.status, 200, JSON.stringify(body))
    return body.nodes[1]
  }
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
  assert.equal((await remote()).workdirs[0].online, false)
  socket.send(JSON.stringify({
    version: 1, sequence: 2, type: 'workdir-advertise',
    workdir: { ...workdir, workdirId: 'new-workdir' },
  }))
  await waitFor(() => registry.listWorkdirs(auth.nodeId).length === 2)
  const advertised = await remote()
  assert.equal(advertised.workdirs.length, 2)
  assert.equal(advertised.workdirs[0].online, false)
  assert.equal(advertised.workdirs[1].online, true)
  assert.equal(advertised.workdirs[1].displayPath, '/child/opaque/folder')
  socket.send(JSON.stringify({
    version: 1, sequence: 3, type: 'workdir-withdraw',
    nodeId: auth.nodeId, workdirId: 'new-workdir',
  }))
  await waitFor(() => registry.listWorkdirs(auth.nodeId).length === 1)
  assert.equal(api.hasAdvertisedWorkdir(auth.nodeId, 'new-workdir'), false)
  socket.close()
  await waitFor(() => !api.isNodeConnected(auth.nodeId))
  const disconnected = await remote()
  assert.equal(disconnected.connection, 'offline')
  assert.equal(disconnected.executionProtocol, 'unknown')
  assert.ok(disconnected.workdirs.every((value: { online: boolean }) => !value.online))
  assert.equal(disconnected.workdirs[0].displayPath, '/child/opaque/folder')
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
  assert.equal((await remote()).workdirs[0].online, false)
  reconnected.send(JSON.stringify({
    version: 1, sequence: 2, type: 'workdir-advertise', workdir,
  }))
  await waitFor(() => api.hasAdvertisedWorkdir(auth.nodeId, workdir.workdirId))
  assert.equal((await remote()).workdirs[0].online, true)
  registry.revoke(auth, 'private-revocation-reason', now)
  assert.equal((await remote()).connection, 'revoked')
  assert.deepEqual((await remote()).workdirs, [])
  reconnected.close()
})

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return
    await setTimeout(10)
  }
  assert.fail('Node connection state did not settle')
}

test('only a live negotiated peer is upgrade-required; offline and revoked protocol knowledge is unknown', () => {
  for (const compatible of [true, false]) {
    const registry = registryFixture()
    let connected = false
    const inventory = () => mainNodeInventory(undefined, registry, {
      isNodeConnected: () => connected, hasAdvertisedNodeSupport: () => true, hasAdvertisedWorkdir: () => true,
      supportsExecutionProtocol: () => compatible,
    }).nodes[0]
    assert.equal(inventory().executionProtocol, 'unknown')
    assert(inventory().workdirs.every(r => !r.online))
    assert(inventory().support.operations.length === 0)
    connected = true
    assert.equal(inventory().executionProtocol, compatible ? 'compatible' : 'upgrade-required')
    assert(inventory().workdirs.every(r => r.online === compatible))
    assert(inventory().support.operations.length === (compatible ? 1 : 0))
    registry.revoke(auth, 'fixture', now)
    assert.equal(inventory().connection, 'revoked')
    assert.equal(inventory().executionProtocol, 'unknown')
  }
})
