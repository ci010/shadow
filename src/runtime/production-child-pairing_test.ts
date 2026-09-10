import { deepEqual as assertEquals, rejects as assertRejects } from 'node:assert/strict'
import { test } from 'node:test'
import type { DeviceCredentialReferenceStore } from '../cluster/device-credential-reference-store.ts'
import type { ProtectedDeviceKeyStore } from '../cluster/device-credentials.ts'
import { pairProductionChild } from './production-child-pairing.ts'
import type { RuntimeDerivedPaths } from './runtime-cli.ts'

const paths: RuntimeDerivedPaths = {
  bootstrapConfigPath: '/state/bootstrap.json',
  bootstrapDirectory: '/state',
  dataDir: '/state/data',
  mutableAgentConfigPath: '/state/data/config/bot.config.json',
  clusterSnapshotPath: '/state/data/cluster/registry.v1.json',
  childCredentialPath: '/state/data/credentials/device-credential.v1.json',
}

function setup() {
  const keys = new Map<string, Uint8Array>()
  const keyStore: ProtectedDeviceKeyStore = {
    providerId: 'test-protected-store',
    load: (keyId) => Promise.resolve(keys.get(keyId)?.slice() ?? null),
    save: (keyId, value) => {
      keys.set(keyId, value.slice())
      return Promise.resolve()
    },
  }
  let reference: unknown
  const referenceStore: DeviceCredentialReferenceStore = {
    load: () => Promise.resolve(reference ?? null),
    save: (value) => {
      reference = structuredClone(value)
      return Promise.resolve()
    },
  }
  return { keyStore, referenceStore, reference: () => reference }
}

test('production Child pairing creates a protected key and non-secret reference', async () => {
  const state = setup()
  const ids = ['device-1', 'pending-1', 'credential-1']
  const result = await pairProductionChild({
    version: 1,
    mode: 'child',
    dataDir: './data',
    localNodeId: 'node-1',
    mainEndpoint: 'http://main.internal:3123',
    allowInsecureLocalTransport: true,
  }, paths, {
    offerId: 'offer-1',
    pin: '123456',
    displayName: 'WSL Child',
    keyStore: state.keyStore,
    referenceStore: state.referenceStore,
    idFactory: () => ids.shift() as string,
    fetchPairing: (_input, init) => {
      const body = JSON.parse(init?.body as string)
      return Promise.resolve(Response.json({
        version: 1,
        state: 'pending',
        pendingId: body.pendingId,
        requestedAt: '2026-08-26T00:00:00.000Z',
      }, { status: 202 }))
    },
  })

  assertEquals(result.reference, state.reference())
  assertEquals(JSON.stringify(state.reference()).includes('privateKey'), false)
})

test('production Child pairing refuses to overwrite an existing reference', async () => {
  const state = setup()
  await state.referenceStore.save({
    version: 1,
    kind: 'protected-device-credential',
    providerId: 'test-protected-store',
    keyId: 'device-key-1',
    deviceId: 'device-1',
    nodeId: 'node-1',
    credentialId: 'credential-1',
    deviceIdentityFingerprint: 'sha256:fingerprint',
  })

  await assertRejects(
    () =>
      pairProductionChild({
        version: 1,
        mode: 'child',
        dataDir: './data',
        localNodeId: 'node-1',
        mainEndpoint: 'https://main.example.test',
      }, paths, {
        offerId: 'offer-1',
        pin: '123456',
        displayName: 'WSL Child',
        keyStore: state.keyStore,
        referenceStore: state.referenceStore,
      }),
    (error) => error instanceof Error && error.message.includes('already has'),
  )
})