import { deepEqual as assertEquals, rejects as assertRejects } from 'node:assert/strict'
import { test } from 'node:test'
import { DeviceCredentialProof } from './device-credentials.ts'
import {
  createDeviceChallengeProof,
  DeviceChallengeAuthority,
  devicePublicKeyFingerprint,
  encodeBase64Url,
  encodeDeviceChallengeProtocol,
} from './device-challenge.ts'
import { InMemoryPairingNodeRegistry } from './registry.ts'

const baseTime = new Date('2026-08-26T00:00:00.000Z')
const auth = {
  deviceId: 'device-1',
  nodeId: 'node-1',
  credentialId: 'credential-1',
}
const audience = 'ws://127.0.0.1:43124/cluster/v1/node'

async function setup() {
  const generatedKeys = await crypto.subtle.generateKey(
    { name: 'Ed25519' },
    true,
    ['sign', 'verify'],
  )
  if (!('publicKey' in generatedKeys) || !('privateKey' in generatedKeys)) {
    throw new TypeError('Ed25519 key generation did not return a key pair')
  }
  const keys = generatedKeys
  const publicKey = new Uint8Array(
    await crypto.subtle.exportKey('raw', keys.publicKey),
  )
  const fingerprint = await devicePublicKeyFingerprint(publicKey)
  const registry = new InMemoryPairingNodeRegistry()
  registry.createOffer(
    'offer-1',
    baseTime,
    new Date(baseTime.getTime() + 60_000),
  )
  registry.presentOffer({
    offerId: 'offer-1',
    pendingId: 'pending-1',
    deviceId: auth.deviceId,
    nodeId: auth.nodeId,
    deviceIdentityFingerprint: fingerprint,
    devicePublicKey: encodeBase64Url(publicKey),
    displayName: 'WSL Child',
  }, baseTime)
  registry.approve({
    pendingId: 'pending-1',
    expectedDeviceIdentityFingerprint: fingerprint,
    credentialId: auth.credentialId,
  }, baseTime)
  const authority = new DeviceChallengeAuthority(registry, {
    ttlMs: 1_000,
    challengeIdFactory: () => 'challenge-1',
    randomBytes: (length) => new Uint8Array(length).fill(9),
  })
  await authority.registerCredential(auth, encodeBase64Url(publicKey))
  const proof = new DeviceCredentialProof(async (input) =>
    new Uint8Array(
      await crypto.subtle.sign(
        { name: 'Ed25519' },
        keys.privateKey,
        new Uint8Array(input).buffer,
      ),
    )
  )
  return { authority, proof, publicKey }
}

test('Ed25519 challenge verifies once and binds exact identity and audience', async () => {
  const { authority, proof } = await setup()
  const challenge = authority.issue(auth, audience, baseTime)
  const signed = await createDeviceChallengeProof(challenge, proof)

  assertEquals(await authority.verify(signed, audience, baseTime), auth)
  assertEquals(await authority.verify(signed, audience, baseTime), null)
})

test('WebSocket subprotocol carries a verified one-time proof without custom headers', async () => {
  const { authority, proof } = await setup()
  const challenge = authority.issue(auth, audience, baseTime)
  const signed = await createDeviceChallengeProof(challenge, proof)
  const protocol = encodeDeviceChallengeProtocol(signed)
  const request = new Request('http://127.0.0.1:43124/cluster/v1/node', {
    headers: { 'Sec-WebSocket-Protocol': `unrelated, ${protocol}` },
  })

  assertEquals(await authority.verifyWebSocketRequest(request, baseTime), {
    authentication: auth,
    protocol,
  })
  assertEquals(await authority.verifyWebSocketRequest(request, baseTime), null)
})

test('challenge rejects wrong signature, audience, identity, and expiry', async (context) => {
  const cases: Array<
    [
      string,
      (
        value: Awaited<ReturnType<typeof createDeviceChallengeProof>>,
      ) => unknown,
      string,
      Date,
    ]
  > = [
    [
      'signature',
      (value) => ({ ...value, signature: encodeBase64Url(new Uint8Array(64)) }),
      audience,
      baseTime,
    ],
    [
      'audience',
      (value) => value,
      'ws://127.0.0.1:43125/cluster/v1/node',
      baseTime,
    ],
    [
      'identity',
      (value) => ({ ...value, nodeId: 'node-other' }),
      audience,
      baseTime,
    ],
    [
      'expiry',
      (value) => value,
      audience,
      new Date(baseTime.getTime() + 1_000),
    ],
  ]
  for (const [name, mutate, targetAudience, now] of cases) {
    await context.test(name, async () => {
      const { authority, proof } = await setup()
      const challenge = authority.issue(auth, audience, baseTime)
      const signed = await createDeviceChallengeProof(challenge, proof)
      assertEquals(
        await authority.verify(mutate(signed), targetAudience, now),
        null,
      )
    })
  }
})

test('credential registration requires approved matching Ed25519 public key', async () => {
  const { authority, publicKey } = await setup()
  const otherKey = new Uint8Array(publicKey)
  otherKey[0] ^= 1
  await assertRejects(
    () => authority.registerCredential(auth, encodeBase64Url(otherKey)),
    { name: 'TypeError', message: /fingerprint/ },
  )
  await assertRejects(
    () =>
      authority.registerCredential({
        ...auth,
        credentialId: 'credential-other',
      }, encodeBase64Url(publicKey)),
    (error) => error instanceof Error && error.message.includes('does not match'),
  )
})

test('challenge authority restores public keys from a registry snapshot', async () => {
  const { authority, publicKey } = await setup()
  const snapshot = authority.registry.exportSnapshot(baseTime)
  const restoredRegistry = new InMemoryPairingNodeRegistry()
  restoredRegistry.restoreSnapshot(snapshot, baseTime)
  const restoredAuthority = new DeviceChallengeAuthority(restoredRegistry, {
    challengeIdFactory: () => 'restored-challenge',
    randomBytes: (length) => new Uint8Array(length).fill(5),
  })

  assertEquals(await restoredAuthority.restoreRegisteredCredentials(), 1)
  assertEquals(
    restoredRegistry.authenticate(auth).devicePublicKey,
    encodeBase64Url(publicKey),
  )
  assertEquals(restoredAuthority.issue(auth, audience, baseTime).challengeId, 'restored-challenge')
})
