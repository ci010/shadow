import { deepEqual as assertEquals, rejects as assertRejects } from 'node:assert/strict'
import { test } from 'node:test'
import type { DeviceCredentialReferenceStore } from './device-credential-reference-store.ts'
import {
  ProtectedEd25519DeviceCredentialProvider,
  type ProtectedDeviceKeyStore,
} from './device-credentials.ts'
import { presentPinPairing } from './pin-pairing-client.ts'

function setup() {
  const keys = new Map<string, Uint8Array>()
  const protectedStore: ProtectedDeviceKeyStore = {
    providerId: 'test-protected-store',
    load: (keyId) => Promise.resolve(keys.get(keyId)?.slice() ?? null),
    save: (keyId, value) => {
      keys.set(keyId, value.slice())
      return Promise.resolve()
    },
  }
  let saved: unknown
  const referenceStore: DeviceCredentialReferenceStore = {
    load: () => Promise.resolve(saved ?? null),
    save: (value) => {
      saved = structuredClone(value)
      return Promise.resolve()
    },
  }
  return {
    provider: new ProtectedEd25519DeviceCredentialProvider(protectedStore),
    referenceStore,
    saved: () => saved,
  }
}

test('Child PIN pairing persists only a correlated credential reference', async () => {
  const { provider, referenceStore, saved } = setup()
  const ids = ['device-1', 'pending-1', 'credential-1']
  let requestBody: Record<string, unknown> | undefined
  const result = await presentPinPairing({
    endpoint: 'https://main.example.test/base',
    offerId: 'offer-1',
    pin: '123456',
    localNodeId: 'node-1',
    displayName: 'WSL Child',
    credentialProvider: provider,
    referenceStore,
    idFactory: () => ids.shift() as string,
    fetchPairing: async (input, init) => {
      assertEquals(
        String(input),
        'https://main.example.test/base/pair/v1/present',
      )
      requestBody = JSON.parse(init?.body as string)
      return Response.json({
        version: 1,
        state: 'pending',
        pendingId: 'pending-1',
        requestedAt: '2026-08-26T00:00:00.000Z',
      }, { status: 202 })
    },
  })

  assertEquals(requestBody?.credentialId, 'credential-1')
  assertEquals(typeof requestBody?.devicePublicKey, 'string')
  assertEquals(JSON.stringify(requestBody).includes('privateKey'), false)
  assertEquals(result.reference, saved())
  assertEquals(JSON.stringify(saved()).includes('privateKey'), false)
})

test('Child PIN pairing rejects non-loopback cleartext by default', async () => {
  const { provider, referenceStore } = setup()
  await assertRejects(
    () =>
      presentPinPairing({
        endpoint: 'http://192.0.2.10:3123',
        offerId: 'offer-1',
        pin: '123456',
        localNodeId: 'node-1',
        displayName: 'WSL Child',
        credentialProvider: provider,
        referenceStore,
      }),
    { name: 'TypeError', message: /requires https/ },
  )
})