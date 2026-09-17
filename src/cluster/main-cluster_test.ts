import { deepEqual as assertEquals } from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { registerGatewayRoutes } from '../gateway/server.ts'
import {
  devicePublicKeyFingerprint,
  encodeBase64Url,
} from './device-challenge.ts'
import {
  createMainCluster,
  MAIN_CLUSTER_LAUNCH_CREDENTIAL_EXEMPTIONS,
} from './main-cluster.ts'
import { InMemoryRegistrySnapshotAdapter } from './persistence.ts'
import type { JobEventV1 } from '../execution/contracts.ts'

const baseTime = new Date('2026-08-26T00:00:00.000Z')
const launchCredential = 'launch-credential'

async function createCluster(adapter: InMemoryRegistrySnapshotAdapter) {
  return await createMainCluster({
    snapshotAdapter: adapter,
    localHello: {
      protocolMajor: 1,
      protocolMinor: 0,
      implementationVersion: 'test',
      features: ['jobs-v1'],
    },
    authorizeOfferCreation: (request) =>
      request.headers.get('Authorization') === `Bearer ${launchCredential}`,
    clientKey: () => 'tcp:127.0.0.1',
    now: () => baseTime,
  })
}

test('Main cluster pairs, approves, persists, and restores challenge credentials', async () => {
  const adapter = new InMemoryRegistrySnapshotAdapter()
  const cluster = await createCluster(adapter)
  const app = new Hono()
  registerGatewayRoutes(app, [...cluster.plugins], {
    launchCredential,
    launchCredentialExemptions: MAIN_CLUSTER_LAUNCH_CREDENTIAL_EXEMPTIONS,
  })

  const unauthorizedOffer = await app.request('/pair/v1/offers', {
    method: 'POST',
  })
  const offerResponse = await app.request('/pair/v1/offers', {
    method: 'POST',
    headers: { Authorization: `Bearer ${launchCredential}` },
  })
  const offer = await offerResponse.json()
  const publicKey = new Uint8Array(32).fill(9)
  const fingerprint = await devicePublicKeyFingerprint(publicKey)
  const presentationResponse = await app.request('/pair/v1/present', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      version: 1,
      offerId: offer.offerId,
      pin: offer.pin,
      pendingId: 'pending-1',
      deviceId: 'device-1',
      nodeId: 'node-1',
      deviceIdentityFingerprint: fingerprint,
      devicePublicKey: encodeBase64Url(publicKey),
      credentialId: 'credential-1',
      displayName: 'WSL Child',
    }),
  })
  const pendingResponse = await app.request('/nodes/v1/pending', {
    headers: { Authorization: `Bearer ${launchCredential}` },
  })
  const approvalResponse = await app.request(
    '/nodes/v1/pending/pending-1/approve',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${launchCredential}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        version: 1,
        expectedDeviceIdentityFingerprint: fingerprint,
      }),
    },
  )
  const authentication = await approvalResponse.json() as {
    deviceId: string
    nodeId: string
    credentialId: string
  }
  const challengeResponse = await app.request('/cluster/v1/challenges', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      version: 1,
      deviceId: authentication.deviceId,
      nodeId: authentication.nodeId,
      credentialId: authentication.credentialId,
    }),
  })

  assertEquals(unauthorizedOffer.status, 401)
  assertEquals(offerResponse.status, 201)
  assertEquals(presentationResponse.status, 202)
  assertEquals(pendingResponse.status, 200)
  assertEquals(approvalResponse.status, 200)
  assertEquals(challengeResponse.status, 201)

  cluster.registry.advertiseCapability(authentication, {
    version: 1, nodeId: authentication.nodeId, capabilityId: 'folder',
    kind: 'workdir', displayName: 'Folder', displayPath: '/child/folder',
    permissions: [], online: true,
  })
  const inventory = cluster.getNodeInventory()
  assertEquals(inventory.nodes[0].connection, 'offline')
  assertEquals(inventory.nodes[0].capabilities[0], {
    capabilityId: 'folder', kind: 'workdir', displayName: 'Folder',
    displayPath: '/child/folder', online: false,
  })
  assertEquals(cluster.workdirCapabilityLookup({
    version: 1, nodeId: authentication.nodeId, capabilityId: 'folder',
  }), { node: 'offline' })
  await cluster.save()

  await cluster.closeNodeConnections()
  const stoppingResponse = await app.request('/cluster/v1/challenges', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version: 1, ...authentication }),
  })
  assertEquals(stoppingResponse.status, 503)
  const stoppingAdminResponse = await app.request('/nodes/v1/pending', {
    headers: { Authorization: `Bearer ${launchCredential}` },
  })
  assertEquals(stoppingAdminResponse.status, 503)

  const restored = await createCluster(adapter)
  assertEquals(restored.getNodeInventory(), inventory)
  assertEquals(
    restored.registry.authenticate(authentication).devicePublicKey,
    encodeBase64Url(publicKey),
  )
  assertEquals(
    restored.authority.issue(
      authentication,
      'ws://main.example.test/cluster/v1/node',
      baseTime,
    ).version,
    1,
  )
  await Promise.all([
    restored.closeNodeConnections(),
  ])
})

test('Main cluster exposes structured remote execution failure while a node is offline', async () => {
  const cluster = await createCluster(new InMemoryRegistrySnapshotAdapter())
  const createdAt = new Date()
  const events: JobEventV1[] = []
  for await (
    const event of cluster.remoteExecutor.execute({
      version: 1,
      jobId: 'offline-job',
      idempotencyKey: 'offline-job-key',
      sessionId: 'session-1',
      turnId: 'turn-1',
      nodeId: 'offline-node',
      capabilityId: 'workdir-1',
      operation: 'filesystem.read',
      args: { path: 'README.md' },
      createdAt: createdAt.toISOString(),
      deadlineAt: new Date(createdAt.getTime() + 10_000).toISOString(),
    }, new AbortController().signal)
  ) events.push(event)

  assertEquals(events.map((event) => event.type), ['failed'])
  const terminal = events[0]
  assertEquals(
    terminal && 'receipt' in terminal ? terminal.receipt.reason?.code : undefined,
    'remote-node-unavailable',
  )
  await cluster.closeNodeConnections()
})