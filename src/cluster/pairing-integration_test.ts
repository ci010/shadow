import { deepEqual as assertEquals } from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { registerGatewayRoutes } from '../gateway/server.ts'
import { pairProductionChild } from '../runtime/production-child-pairing.ts'
import type { RuntimeDerivedPaths } from '../runtime/runtime-cli.ts'
import { requestDeviceChallengeProtocol } from './device-challenge-client.ts'
import type { DeviceCredentialReferenceStore } from './device-credential-reference-store.ts'
import {
  ProtectedEd25519DeviceCredentialProvider,
  type ProtectedDeviceKeyStore,
  resolveDeviceCredentialForConnect,
} from './device-credentials.ts'
import {
  createMainCluster,
  MAIN_CLUSTER_LAUNCH_CREDENTIAL_EXEMPTIONS,
} from './main-cluster.ts'
import { InMemoryRegistrySnapshotAdapter } from './persistence.ts'

const clock = new Date()
const launchCredential = 'integration-launch-credential'
const paths: RuntimeDerivedPaths = {
  bootstrapConfigPath: '/state/bootstrap.json',
  bootstrapDirectory: '/state',
  dataDir: '/state/data',
  mutableAgentConfigPath: '/state/data/config/bot.config.json',
  clusterSnapshotPath: '/state/data/cluster/registry.v1.json',
  childCredentialPath: '/state/data/credentials/device-credential.v1.json',
}

function protectedStore(): ProtectedDeviceKeyStore {
  const values = new Map<string, Uint8Array>()
  return {
    providerId: 'test-protected-store',
    load: (keyId) => Promise.resolve(values.get(keyId)?.slice() ?? null),
    save: (keyId, value) => {
      values.set(keyId, value.slice())
      return Promise.resolve()
    },
  }
}

async function main(adapter: InMemoryRegistrySnapshotAdapter) {
  const cluster = await createMainCluster({
    snapshotAdapter: adapter,
    localHello: {
      protocolMajor: 1,
      protocolMinor: 0,
      implementationVersion: 'integration-main',
      features: ['jobs-v1', 'capabilities-v1'],
    },
    authorizeOfferCreation: (request) =>
      request.headers.get('Authorization') === `Bearer ${launchCredential}`,
    clientKey: () => 'tcp:127.0.0.1',
    now: () => clock,
  })
  const app = new Hono()
  registerGatewayRoutes(app, [...cluster.plugins], {
    launchCredential,
    launchCredentialExemptions: MAIN_CLUSTER_LAUNCH_CREDENTIAL_EXEMPTIONS,
  })
  return { app, cluster }
}

test('PIN-paired Child proves the same protected key after Main restart', async () => {
  const adapter = new InMemoryRegistrySnapshotAdapter()
  const firstMain = await main(adapter)
  const offerResponse = await firstMain.app.request('https://main.test/pair/v1/offers', {
    method: 'POST',
    headers: { Authorization: `Bearer ${launchCredential}` },
  })
  const offer = await offerResponse.json()
  const keyStore = protectedStore()
  let referenceValue: unknown
  const referenceStore: DeviceCredentialReferenceStore = {
    load: () => Promise.resolve(referenceValue ?? null),
    save: (reference) => {
      referenceValue = structuredClone(reference)
      return Promise.resolve()
    },
  }
  const ids = ['device-1', 'pending-1', 'credential-1']
  const paired = await pairProductionChild({
    version: 1,
    mode: 'child',
    dataDir: './data',
    localNodeId: 'node-1',
    mainEndpoint: 'https://main.test',
  }, paths, {
    offerId: offer.offerId,
    pin: offer.pin,
    displayName: 'Integration Child',
    keyStore,
    referenceStore,
    idFactory: () => ids.shift() as string,
    fetchPairing: async (input, init) =>
      await firstMain.app.fetch(new Request(input, init)),
  })
  const approvalResponse = await firstMain.app.request(
    'https://main.test/nodes/v1/pending/pending-1/approve',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${launchCredential}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        version: 1,
        expectedDeviceIdentityFingerprint:
          paired.reference.deviceIdentityFingerprint,
        uiScopes: [],
        nodePrivileges: ['capabilities:advertise', 'jobs:execute'],
      }),
    },
  )
  assertEquals(approvalResponse.status, 200)

  const provider = new ProtectedEd25519DeviceCredentialProvider(keyStore)
  const credential = await resolveDeviceCredentialForConnect(
    provider,
    paired.reference,
    {
      endpoint: 'https://main.test',
      localNodeId: 'node-1',
      signal: new AbortController().signal,
    },
  )
  const protocol = await requestDeviceChallengeProtocol(
    'https://main.test',
    credential.authentication,
    credential.proof,
    async (input, init) =>
      await firstMain.app.fetch(new Request(input, init)),
  )
  const verified = await firstMain.cluster.authority.verifyWebSocketRequest(
    new Request('https://main.test/cluster/v1/node', {
      headers: { 'Sec-WebSocket-Protocol': protocol },
    }),
    clock,
  )
  assertEquals(verified?.authentication, credential.authentication)

  await firstMain.cluster.closeNodeConnections()
  await firstMain.cluster.save(clock)
  const restoredMain = await main(adapter)
  const restoredProtocol = await requestDeviceChallengeProtocol(
    'https://main.test',
    credential.authentication,
    credential.proof,
    async (input, init) =>
      await restoredMain.app.fetch(new Request(input, init)),
  )
  const restoredVerified = await restoredMain.cluster.authority
    .verifyWebSocketRequest(
      new Request('https://main.test/cluster/v1/node', {
        headers: { 'Sec-WebSocket-Protocol': restoredProtocol },
      }),
      clock,
    )
  assertEquals(restoredVerified?.authentication, credential.authentication)
  await restoredMain.cluster.closeNodeConnections()
})