import assert, {
  deepEqual as assertEquals,
  rejects as assertRejects,
  throws as assertThrows,
} from 'node:assert/strict'
import { test } from 'node:test'
import { inspect } from 'node:util'
import {
  DeterministicFakeDeviceCredentialProvider,
  DeviceCredentialProof,
  ProtectedEd25519DeviceCredentialProvider,
  type ProtectedDeviceKeyStore,
  resolveDeviceCredentialForConnect,
  validateDeviceCredentialReferenceV1,
} from './device-credentials.ts'
import { decodeBase64Url } from './device-challenge.ts'

const reference = {
  version: 1,
  kind: 'protected-device-credential',
  providerId: 'windows-credential-manager',
  keyId: 'shadow.device.1',
  deviceId: 'device-1',
  nodeId: 'node-1',
  credentialId: 'credential-1',
  deviceIdentityFingerprint: 'fingerprint-1',
} as const

const resolved = {
  authentication: {
    deviceId: reference.deviceId,
    nodeId: reference.nodeId,
    credentialId: reference.credentialId,
  },
  deviceIdentityFingerprint: reference.deviceIdentityFingerprint,
}

function context(localNodeId: string = reference.nodeId) {
  return {
    endpoint: 'https://main.test',
    localNodeId,
    signal: new AbortController().signal,
  }
}

test('device credential references reject secrets and unknown fields', () => {
  assert(validateDeviceCredentialReferenceV1(reference).success)
  for (
    const secretField of ['token', 'rawToken', 'privateKey', 'secret', 'proof']
  ) {
    assertEquals(
      validateDeviceCredentialReferenceV1({
        ...reference,
        [secretField]: 'must-not-persist',
      }).success,
      false,
    )
  }
  assertEquals(
    validateDeviceCredentialReferenceV1({ ...reference, futureField: true })
      .success,
    false,
  )
  assertEquals(
    validateDeviceCredentialReferenceV1({ ...reference, version: 2 }).success,
    false,
  )
})

test('device credential proof is opaque, redacted, and not JSON serializable', async () => {
  const proof = new DeviceCredentialProof((input) => input)

  assertEquals(Object.keys(proof), [])
  assertEquals(String(proof), '[DeviceCredentialProof redacted]')
  assertEquals(inspect(proof), '[DeviceCredentialProof redacted]')
  assertThrows(() => JSON.stringify(proof), {
    name: 'TypeError',
    message: /cannot be serialized/,
  })
  assertEquals(
    await proof.sign(new Uint8Array([1, 2, 3])),
    new Uint8Array([1, 2, 3]),
  )
})

test('device credentials resolve separately for every connect attempt', async () => {
  const provider = new DeterministicFakeDeviceCredentialProvider(
    resolved,
    (input) => input,
  )

  const first = await resolveDeviceCredentialForConnect(
    provider,
    reference,
    context(),
  )
  const second = await resolveDeviceCredentialForConnect(
    provider,
    reference,
    context(),
  )

  assertEquals(provider.resolutions.length, 2)
  assert(first.proof !== second.proof)
  assertEquals(first.authentication, resolved.authentication)
})

test('device credential identity mismatches fail before an adapter can dial', async () => {
  let dialed = false
  const provider = new DeterministicFakeDeviceCredentialProvider(
    resolved,
    (input) => input,
  )
  const connect = async (localNodeId: string): Promise<void> => {
    await resolveDeviceCredentialForConnect(
      provider,
      reference,
      context(localNodeId),
    )
    dialed = true
  }

  await assertRejects(
    () => connect('node-2'),
    (error) => error instanceof Error && error.message.includes('does not match'),
  )
  assertEquals(dialed, false)
  assertEquals(provider.resolutions.length, 0)

  const mismatchedProvider = new DeterministicFakeDeviceCredentialProvider({
    ...resolved,
    authentication: { ...resolved.authentication, deviceId: 'device-2' },
  }, (input) => input)
  await assertRejects(
    () =>
      resolveDeviceCredentialForConnect(
        mismatchedProvider,
        reference,
        context(),
      ),
    (error) => error instanceof Error && error.message.includes('deviceId does not match'),
  )
  assertEquals(dialed, false)
})

test('protected Ed25519 credentials persist private material only in the key store', async () => {
  const values = new Map<string, Uint8Array>()
  const store: ProtectedDeviceKeyStore = {
    providerId: 'test-protected-store',
    load: (keyId) => Promise.resolve(values.get(keyId)?.slice() ?? null),
    save: (keyId, value) => {
      values.set(keyId, value.slice())
      return Promise.resolve()
    },
  }
  const provider = new ProtectedEd25519DeviceCredentialProvider(store)
  const controller = new AbortController()
  const identity = await provider.loadOrCreateKey('device-key-1', controller.signal)
  const repeated = await provider.loadOrCreateKey('device-key-1', controller.signal)
  const credentialReference = {
    ...reference,
    providerId: store.providerId,
    keyId: identity.keyId,
    deviceIdentityFingerprint: identity.deviceIdentityFingerprint,
  }
  const credential = await resolveDeviceCredentialForConnect(
    provider,
    credentialReference,
    context(),
  )
  const signature = await credential.proof.sign(new Uint8Array([1, 2, 3]))
  const publicKey = await crypto.subtle.importKey(
    'raw',
    new Uint8Array(decodeBase64Url(identity.devicePublicKey)),
    { name: 'Ed25519' },
    false,
    ['verify'],
  )

  assertEquals(repeated, identity)
  assertEquals(values.size, 1)
  assertEquals(
    await crypto.subtle.verify(
      { name: 'Ed25519' },
      publicKey,
      new Uint8Array(signature),
      new Uint8Array([1, 2, 3]),
    ),
    true,
  )
  assertEquals(JSON.stringify(identity).includes('privateKey'), false)
})
