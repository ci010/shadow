import { deepEqual as assertEquals, match as assertMatch } from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import {
  devicePublicKeyFingerprint,
  encodeBase64Url,
} from './device-challenge.ts'
import { pairingApiPlugin } from './pairing-api.ts'
import { PinPairingService } from './pin-pairing.ts'
import { InMemoryPairingNodeRegistry } from './registry.ts'

const baseTime = new Date('2026-08-26T00:00:00.000Z')
const devicePublicKey = encodeBase64Url(new Uint8Array(32).fill(7))
const deviceIdentityFingerprint = await devicePublicKeyFingerprint(
  new Uint8Array(32).fill(7),
)

function createApp(
  options: { presentationLimit?: number; maxBodyBytes?: number } = {},
) {
  const registry = new InMemoryPairingNodeRegistry()
  const service = new PinPairingService(registry, {
    offerIdFactory: () => 'offer-pin',
    randomBytes: (length) =>
      length === 3
        ? new Uint8Array([0x01, 0xe2, 0x40])
        : new Uint8Array(length).fill(7),
  })
  const app = new Hono()
  pairingApiPlugin({
    service,
    authorizeOfferCreation: (request) =>
      request.headers.get('Authorization') === 'Bearer admin',
    clientKey: (request) => request.headers.get('X-Test-Client') ?? '',
    now: () => baseTime,
    ...options,
  })(app)
  return { app, registry }
}

function presentation(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: 1,
    offerId: 'offer-pin',
    pin: '123456',
    pendingId: 'pending-pin',
    deviceId: 'device-wsl',
    nodeId: 'node-wsl',
    deviceIdentityFingerprint,
    devicePublicKey,
    credentialId: 'credential-wsl',
    displayName: 'WSL Child',
    ...overrides,
  }
}

async function createOffer(app: Hono): Promise<Response> {
  return await app.request('/pair/v1/offers', {
    method: 'POST',
    headers: { Authorization: 'Bearer admin' },
  })
}

test('pairing offer creation requires admin authorization and is never cacheable', async () => {
  const { app } = createApp()
  const unauthorized = await app.request('/pair/v1/offers', { method: 'POST' })
  const created = await createOffer(app)

  assertEquals(unauthorized.status, 401)
  assertEquals(await unauthorized.json(), { error: 'unauthorized' })
  assertEquals(created.status, 201)
  assertEquals(created.headers.get('Cache-Control'), 'no-store')
  const offer = await created.json()
  assertEquals(offer.offerId, 'offer-pin')
  assertMatch(offer.pin, /^\d{6}$/)
})

test('correct PIN creates a redacted pending response through the existing registry', async () => {
  const { app, registry } = createApp()
  await createOffer(app)
  const response = await app.request('/pair/v1/present', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Test-Client': 'wsl' },
    body: JSON.stringify(presentation()),
  })

  assertEquals(response.status, 202)
  const responseBody = await response.text()
  assertEquals(JSON.parse(responseBody), {
    version: 1,
    state: 'pending',
    pendingId: 'pending-pin',
    requestedAt: baseTime.toISOString(),
  })
  assertEquals(registry.getPending().length, 1)
  assertEquals(registry.getPending()[0]?.devicePublicKey, devicePublicKey)
  assertEquals(responseBody.includes('123456'), false)
})

test('pairing presentation enforces JSON, exact schema, and bounded bodies', async () => {
  const { app } = createApp({ maxBodyBytes: 600 })
  await createOffer(app)
  const wrongType = await app.request('/pair/v1/present', {
    method: 'POST',
    headers: { 'X-Test-Client': 'type' },
    body: '{}',
  })
  const unknownField = await app.request('/pair/v1/present', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Test-Client': 'schema' },
    body: JSON.stringify(presentation({ secret: 'forbidden' })),
  })
  const oversized = await app.request('/pair/v1/present', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': '601',
      'X-Test-Client': 'size',
    },
    body: '{}',
  })

  assertEquals(wrongType.status, 415)
  assertEquals(unknownField.status, 400)
  assertEquals(await unknownField.json(), { error: 'invalid_presentation' })
  assertEquals(oversized.status, 413)
  assertEquals(await oversized.json(), { error: 'body_too_large' })
})

test('pairing presentation rate limit is isolated by trusted client key', async () => {
  const { app } = createApp({ presentationLimit: 1 })
  await createOffer(app)
  const request = (client: string) =>
    app.request('/pair/v1/present', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Test-Client': client },
      body: JSON.stringify(presentation({ pin: '000000' })),
    })

  assertEquals((await request('source-a')).status, 401)
  const limited = await request('source-a')
  assertEquals(limited.status, 429)
  assertEquals(limited.headers.get('Retry-After'), '60')
  assertEquals((await request('source-b')).status, 401)
})

test('pairing presentation fails closed when listener cannot identify the client', async () => {
  const { app } = createApp()
  await createOffer(app)
  const response = await app.request('/pair/v1/present', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(presentation()),
  })

  assertEquals(response.status, 503)
  assertEquals(await response.json(), { error: 'client_identity_unavailable' })
})
