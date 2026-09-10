import type { PendingPairingV1 } from './contracts.ts'
import {
  type InMemoryPairingNodeRegistry,
  type PairingPresentationV1,
} from './registry.ts'

export interface PinPairingOfferV1 {
  readonly version: 1
  readonly offerId: string
  readonly pin: string
  readonly expiresAt: string
}

export interface PinPairingPresentationV1 extends PairingPresentationV1 {
  readonly pin: string
}

export type PinPairingErrorCode =
  | 'invalid-pin-format'
  | 'pin-invalid'
  | 'pin-attempts-exhausted'
  | 'offer-not-found'
  | 'offer-expired'

export class PinPairingError extends Error {
  constructor(readonly code: PinPairingErrorCode, message: string) {
    super(message)
    this.name = 'PinPairingError'
  }
}

export interface PinPairingServiceOptions {
  readonly ttlMs?: number
  readonly maxAttempts?: number
  readonly offerIdFactory?: () => string
  readonly randomBytes?: (length: number) => Uint8Array
  readonly onRegistryMutation?: (now: Date) => void | Promise<void>
}

interface ActivePinOffer {
  readonly expiresAt: Date
  readonly salt: Uint8Array
  readonly hash: Uint8Array
  attemptsRemaining: number
}

const PIN_PATTERN = /^\d{6}$/
const DEFAULT_TTL_MS = 5 * 60_000
const DEFAULT_MAX_ATTEMPTS = 5
const PIN_RANGE = 1_000_000
const RANDOM_RANGE = 2 ** 24
const UNBIASED_LIMIT = Math.floor(RANDOM_RANGE / PIN_RANGE) * PIN_RANGE

export class PinPairingService {
  readonly #active = new Map<string, ActivePinOffer>()
  readonly #ttlMs: number
  readonly #maxAttempts: number
  readonly #offerIdFactory: () => string
  readonly #randomBytes: (length: number) => Uint8Array
  readonly #onRegistryMutation: (now: Date) => void | Promise<void>
  #operation: Promise<unknown> = Promise.resolve()

  constructor(
    readonly registry: InMemoryPairingNodeRegistry,
    options: PinPairingServiceOptions = {},
  ) {
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    this.#maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
    if (!Number.isSafeInteger(this.#ttlMs) || this.#ttlMs <= 0) {
      throw new TypeError('PIN pairing TTL must be a positive safe integer')
    }
    if (
      !Number.isSafeInteger(this.#maxAttempts) || this.#maxAttempts < 1 ||
      this.#maxAttempts > 100
    ) {
      throw new TypeError('PIN pairing maxAttempts must be between 1 and 100')
    }
    this.#offerIdFactory = options.offerIdFactory ?? (() => crypto.randomUUID())
    this.#randomBytes = options.randomBytes ?? secureRandomBytes
    this.#onRegistryMutation = options.onRegistryMutation ?? (() => {})
  }

  createOffer(now = new Date()): Promise<PinPairingOfferV1> {
    return this.#serialize(async () => {
      const offerId = this.#offerIdFactory()
      const pin = createPin(this.#randomBytes)
      const salt = this.#randomBytes(16)
      if (salt.length !== 16) {
        throw new TypeError('PIN pairing random source returned invalid salt')
      }
      const expiresAt = new Date(now.getTime() + this.#ttlMs)
      const hash = await hashPin(pin, salt)
      this.registry.createOffer(offerId, now, expiresAt)
      this.#active.set(offerId, {
        expiresAt,
        salt: new Uint8Array(salt),
        hash,
        attemptsRemaining: this.#maxAttempts,
      })
      await this.#onRegistryMutation(now)
      return {
        version: 1,
        offerId,
        pin,
        expiresAt: expiresAt.toISOString(),
      }
    })
  }

  present(
    presentation: PinPairingPresentationV1,
    now = new Date(),
  ): Promise<PendingPairingV1> {
    return this.#serialize(async () => {
      if (!PIN_PATTERN.test(presentation.pin)) {
        throw new PinPairingError(
          'invalid-pin-format',
          'Pairing PIN must contain exactly 6 digits',
        )
      }
      const active = this.#active.get(presentation.offerId)
      if (!active) {
        throw new PinPairingError(
          'offer-not-found',
          'PIN pairing offer was not found',
        )
      }
      if (now.getTime() >= active.expiresAt.getTime()) {
        await this.#invalidate(presentation.offerId, now)
        throw new PinPairingError(
          'offer-expired',
          'PIN pairing offer has expired',
        )
      }

      const candidateHash = await hashPin(presentation.pin, active.salt)
      if (!constantTimeEqual(candidateHash, active.hash)) {
        active.attemptsRemaining--
        if (active.attemptsRemaining === 0) {
          await this.#invalidate(presentation.offerId, now)
          throw new PinPairingError(
            'pin-attempts-exhausted',
            'PIN pairing attempts are exhausted',
          )
        }
        throw new PinPairingError('pin-invalid', 'Pairing PIN is invalid')
      }

      this.#active.delete(presentation.offerId)
      const { pin: _pin, ...registryPresentation } = presentation
      const pending = this.registry.presentOffer(registryPresentation, now)
      await this.#onRegistryMutation(now)
      return pending
    })
  }

  async #invalidate(offerId: string, now: Date): Promise<void> {
    this.#active.delete(offerId)
    if (this.registry.invalidateOffer(offerId)) {
      await this.#onRegistryMutation(now)
    }
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operation.then(operation, operation)
    this.#operation = result.then(() => undefined, () => undefined)
    return result
  }
}

function secureRandomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length))
}

function createPin(randomBytes: (length: number) => Uint8Array): string {
  while (true) {
    const bytes = randomBytes(3)
    if (bytes.length !== 3) {
      throw new TypeError('PIN pairing random source returned invalid bytes')
    }
    const value = (bytes[0] << 16) | (bytes[1] << 8) | bytes[2]
    if (value < UNBIASED_LIMIT) {
      return String(value % PIN_RANGE).padStart(6, '0')
    }
  }
}

async function hashPin(pin: string, salt: Uint8Array): Promise<Uint8Array> {
  const pinBytes = new TextEncoder().encode(pin)
  const input = new Uint8Array(salt.length + pinBytes.length)
  input.set(salt)
  input.set(pinBytes, salt.length)
  return new Uint8Array(await crypto.subtle.digest('SHA-256', input))
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index++) {
    difference |= left[index] ^ right[index]
  }
  return difference === 0
}
