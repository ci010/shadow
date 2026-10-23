import { deepEqual as assertEquals, rejects as assertRejects, throws as assertThrows } from 'node:assert/strict'
import { test } from 'node:test'
import { InMemoryPairingNodeRegistry, RegistryError } from './registry.ts'
import {
  PinPairingError,
  type PinPairingPresentationV1,
  PinPairingService,
} from './pin-pairing.ts'

const baseTime = new Date('2026-08-26T00:00:00.000Z')

function createService(options: { maxAttempts?: number; ttlMs?: number } = {}) {
  const registry = new InMemoryPairingNodeRegistry()
  const randomBytes = (length: number): Uint8Array => {
    if (length === 3) return new Uint8Array([0x01, 0xe2, 0x40])
    return new Uint8Array(length).fill(7)
  }
  const service = new PinPairingService(registry, {
    ...options,
    offerIdFactory: () => 'offer-pin',
    randomBytes,
  })
  return { registry, service }
}

function presentation(pin: string): PinPairingPresentationV1 {
  return {
    offerId: 'offer-pin',
    pin,
    pendingId: 'pending-pin',
    deviceId: 'device-wsl',
    nodeId: 'node-wsl',
    deviceIdentityFingerprint: 'fingerprint-wsl',
    displayName: 'WSL Child',
  }
}

async function expectPinCode(
  code: PinPairingError['code'],
  action: () => Promise<unknown>,
): Promise<void> {
  await assertRejects(
    action,
    (error) => error instanceof PinPairingError && error.code === code,
  )
}

test('PIN offer is six digits, short-lived, and never enters the registry snapshot', async () => {
  const { registry, service } = createService()
  const offer = await service.createOffer(baseTime)

  assertEquals(offer, {
    version: 1,
    offerId: 'offer-pin',
    pin: '123456',
    expiresAt: '2026-08-26T00:05:00.000Z',
  })
  assertEquals(
    JSON.stringify(registry.exportSnapshot(baseTime)).includes('123456'),
    false,
  )
})

test('correct PIN consumes the offer once and enters the existing pending flow', async () => {
  const { registry, service } = createService()
  await service.createOffer(baseTime)

  const pending = await service.present(
    presentation('123456'),
    new Date(baseTime.getTime() + 1_000),
  )
  assertEquals(pending.state, 'pending')
  assertEquals(registry.getPending(), [pending])
  await expectPinCode(
    'offer-not-found',
    () => service.present(presentation('123456'), baseTime),
  )
  assertThrows(
    () => registry.presentOffer(presentation('123456'), baseTime),
    (error) => error instanceof RegistryError && error.code === 'offer-replayed',
  )
})

test('wrong PIN is bounded and exhausts the underlying offer', async () => {
  const { registry, service } = createService({ maxAttempts: 2 })
  await service.createOffer(baseTime)

  await expectPinCode(
    'pin-invalid',
    () => service.present(presentation('000000'), baseTime),
  )
  await expectPinCode(
    'pin-attempts-exhausted',
    () => service.present(presentation('000001'), baseTime),
  )
  await expectPinCode(
    'offer-not-found',
    () => service.present(presentation('123456'), baseTime),
  )
  assertEquals(registry.exportSnapshot(baseTime).consumedOfferIds, [
    'offer-pin',
  ])
})

test('expired and malformed PIN submissions fail without creating pending state', async () => {
  const { registry, service } = createService({ ttlMs: 1_000 })
  await service.createOffer(baseTime)

  await expectPinCode(
    'invalid-pin-format',
    () => service.present(presentation('12345'), baseTime),
  )
  await expectPinCode(
    'offer-expired',
    () =>
      service.present(
        presentation('123456'),
        new Date(baseTime.getTime() + 1_000),
      ),
  )
  assertEquals(registry.getPending(), [])
  assertEquals(registry.exportSnapshot(baseTime).consumedOfferIds, [
    'offer-pin',
  ])
})
