import { deepEqual as assertEquals } from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { deviceChallengeApiPlugin } from './device-challenge-api.ts'
import {
  DeviceChallengeAuthority,
  devicePublicKeyFingerprint,
  encodeBase64Url,
} from './device-challenge.ts'
import { InMemoryPairingNodeRegistry } from './registry.ts'

const baseTime = new Date('2026-08-26T00:00:00.000Z')
const auth = {
  deviceId: 'device-1',
  nodeId: 'node-1',
  credentialId: 'credential-1',
}

async function createApp(requestLimit = 20) {
  const keys = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])
  if (!('publicKey' in keys)) throw new TypeError('Expected Ed25519 key pair')
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
    displayName: 'WSL Child',
  }, baseTime)
  registry.approve({
    pendingId: 'pending-1',
    expectedDeviceIdentityFingerprint: fingerprint,
    credentialId: auth.credentialId,
  }, baseTime)
  const authority = new DeviceChallengeAuthority(registry, {
    challengeIdFactory: () => 'challenge-1',
    randomBytes: (length) => new Uint8Array(length).fill(3),
  })
  await authority.registerCredential(auth, encodeBase64Url(publicKey))
  const app = new Hono()
  deviceChallengeApiPlugin({
    authority,
    clientKey: (request) => request.headers.get('X-Test-Client') ?? '',
    now: () => baseTime,
    requestsPerMinute: requestLimit,
  })(app)
  return app
}

async function request(app: Hono, body: unknown, client = 'wsl'): Promise<Response> {
  return app.request('http://127.0.0.1:43124/cluster/v1/challenges', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Test-Client': client },
    body: JSON.stringify(body),
  })
}

test('challenge endpoint issues a no-store nonce only for a registered approved identity', async () => {
  const app = await createApp()
  const response = await request(app, { version: 1, ...auth })

  assertEquals(response.status, 201)
  assertEquals(response.headers.get('Cache-Control'), 'no-store')
  const challenge = await response.json()
  assertEquals(challenge.challengeId, 'challenge-1')
  assertEquals(challenge.audience, 'ws://127.0.0.1:43124/cluster/v1/node')

  const unavailable = await request(app, {
    version: 1,
    ...auth,
    credentialId: 'credential-other',
  }, 'other')
  assertEquals(unavailable.status, 404)
  assertEquals(await unavailable.json(), { error: 'credential_not_available' })
})

test('challenge endpoint enforces exact input, client identity, and rate limit', async () => {
  const app = await createApp(1)
  const missingClient = await request(app, { version: 1, ...auth }, '')
  const invalid = await request(app, {
    version: 1,
    ...auth,
    secret: 'forbidden',
  }, 'limited')
  const limited = await request(app, { version: 1, ...auth }, 'limited')

  assertEquals(missingClient.status, 503)
  assertEquals(invalid.status, 400)
  assertEquals(limited.status, 429)
  assertEquals(limited.headers.get('Retry-After'), '60')
})
