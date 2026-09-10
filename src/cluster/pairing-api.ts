import type { Context, Hono } from 'hono'
import type { GatewayPlugin } from '../gateway/types.ts'
import { isClusterIdentifier } from './contracts.ts'
import {
  decodeBase64Url,
  devicePublicKeyFingerprint,
} from './device-challenge.ts'
import {
  PinPairingError,
  type PinPairingPresentationV1,
  type PinPairingService,
} from './pin-pairing.ts'
import { RegistryError } from './registry.ts'

export interface PairingApiOptions {
  readonly service: PinPairingService
  readonly authorizeOfferCreation: (
    request: Request,
  ) => boolean | Promise<boolean>
  readonly clientKey: (request: Request) => string
  readonly now?: () => Date
  readonly maxBodyBytes?: number
  readonly presentationLimit?: number
  readonly presentationWindowMs?: number
}

interface RateWindow {
  startedAt: number
  attempts: number
}

const DEFAULT_MAX_BODY_BYTES = 4 * 1024
const DEFAULT_PRESENTATION_LIMIT = 10
const DEFAULT_PRESENTATION_WINDOW_MS = 60_000
const PRESENTATION_FIELDS = new Set([
  'version',
  'offerId',
  'pin',
  'pendingId',
  'deviceId',
  'nodeId',
  'deviceIdentityFingerprint',
  'devicePublicKey',
  'credentialId',
  'displayName',
])

export function pairingApiPlugin(options: PairingApiOptions): GatewayPlugin {
  const maxBodyBytes = positiveInteger(
    options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    'maxBodyBytes',
  )
  const presentationLimit = positiveInteger(
    options.presentationLimit ?? DEFAULT_PRESENTATION_LIMIT,
    'presentationLimit',
  )
  const presentationWindowMs = positiveInteger(
    options.presentationWindowMs ?? DEFAULT_PRESENTATION_WINDOW_MS,
    'presentationWindowMs',
  )
  const now = options.now ?? (() => new Date())
  const rateWindows = new Map<string, RateWindow>()

  return (app: Hono) => {
    app.post('/pair/v1/offers', async (context) => {
      if (!await options.authorizeOfferCreation(context.req.raw)) {
        return context.json({ error: 'unauthorized' }, 401, {
          'Cache-Control': 'no-store',
          'WWW-Authenticate': 'Bearer',
        })
      }
      const offer = await options.service.createOffer(now())
      return context.json(offer, 201, { 'Cache-Control': 'no-store' })
    })

    app.post('/pair/v1/present', async (context) => {
      const requestTime = now()
      const clientKey = options.clientKey(context.req.raw).trim()
      if (!clientKey) {
        return context.json({ error: 'client_identity_unavailable' }, 503)
      }
      const retryAfterSeconds = consumeRateLimit(
        rateWindows,
        clientKey,
        requestTime,
        presentationLimit,
        presentationWindowMs,
      )
      if (retryAfterSeconds !== null) {
        return context.json({ error: 'rate_limited' }, 429, {
          'Cache-Control': 'no-store',
          'Retry-After': String(retryAfterSeconds),
        })
      }

      const contentType = context.req.header('Content-Type')?.split(';', 1)[0]
        .trim().toLowerCase()
      if (contentType !== 'application/json') {
        return context.json({ error: 'content_type_required' }, 415)
      }

      let value: unknown
      try {
        value = JSON.parse(await readBoundedBody(context.req.raw, maxBodyBytes))
      } catch (error) {
        if (error instanceof PairingRequestError) {
          return context.json({ error: error.code }, error.status)
        }
        return context.json({ error: 'invalid_json' }, 400)
      }

      let presentation: PinPairingPresentationV1
      try {
        presentation = await parsePresentation(value)
      } catch {
        return context.json({ error: 'invalid_presentation' }, 400)
      }

      try {
        const pending = await options.service.present(presentation, requestTime)
        return context.json(
          {
            version: 1,
            state: pending.state,
            pendingId: pending.pendingId,
            requestedAt: pending.requestedAt,
          },
          202,
          { 'Cache-Control': 'no-store' },
        )
      } catch (error) {
        return pairingFailure(context, error)
      }
    })
  }
}

class PairingRequestError extends Error {
  constructor(readonly code: string, readonly status: 400 | 413) {
    super(code)
  }
}

async function readBoundedBody(
  request: Request,
  maxBytes: number,
): Promise<string> {
  const contentLength = request.headers.get('Content-Length')
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength)
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0) {
      throw new PairingRequestError('invalid_content_length', 400)
    }
    if (declaredBytes > maxBytes) {
      throw new PairingRequestError('body_too_large', 413)
    }
  }
  if (request.body === null) return ''

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      bytes += result.value.byteLength
      if (bytes > maxBytes) {
        await reader.cancel('pairing request body too large')
        throw new PairingRequestError('body_too_large', 413)
      }
      chunks.push(result.value)
    }
  } finally {
    reader.releaseLock()
  }
  const body = new Uint8Array(bytes)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(body)
}

async function parsePresentation(
  value: unknown,
): Promise<PinPairingPresentationV1> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('presentation must be an object')
  }
  const candidate = value as Record<string, unknown>
  if (
    candidate.version !== 1 ||
    Object.keys(candidate).some((field) => !PRESENTATION_FIELDS.has(field)) ||
    Object.keys(candidate).length !== PRESENTATION_FIELDS.size
  ) {
    throw new TypeError('presentation schema is invalid')
  }
  for (
    const field of [
      'offerId',
      'pendingId',
      'deviceId',
      'nodeId',
      'credentialId',
    ]
  ) {
    if (!isClusterIdentifier(candidate[field])) {
      throw new TypeError(`${field} is invalid`)
    }
  }
  if (typeof candidate.pin !== 'string' || !/^\d{6}$/.test(candidate.pin)) {
    throw new TypeError('pin is invalid')
  }
  if (
    typeof candidate.deviceIdentityFingerprint !== 'string' ||
    candidate.deviceIdentityFingerprint.length < 16 ||
    candidate.deviceIdentityFingerprint.length > 256
  ) {
    throw new TypeError('deviceIdentityFingerprint is invalid')
  }
  if (typeof candidate.devicePublicKey !== 'string') {
    throw new TypeError('devicePublicKey is invalid')
  }
  const publicKey = decodeBase64Url(candidate.devicePublicKey)
  if (
    publicKey.length !== 32 ||
    await devicePublicKeyFingerprint(publicKey) !==
      candidate.deviceIdentityFingerprint
  ) {
    throw new TypeError('devicePublicKey fingerprint is invalid')
  }
  if (
    typeof candidate.displayName !== 'string' ||
    candidate.displayName.trim().length === 0 ||
    candidate.displayName.length > 100
  ) {
    throw new TypeError('displayName is invalid')
  }
  return {
    offerId: candidate.offerId as string,
    pin: candidate.pin,
    pendingId: candidate.pendingId as string,
    deviceId: candidate.deviceId as string,
    nodeId: candidate.nodeId as string,
    deviceIdentityFingerprint: candidate.deviceIdentityFingerprint,
    devicePublicKey: candidate.devicePublicKey,
    credentialId: candidate.credentialId as string,
    displayName: candidate.displayName,
  }
}

function consumeRateLimit(
  windows: Map<string, RateWindow>,
  clientKey: string,
  now: Date,
  limit: number,
  windowMs: number,
): number | null {
  const nowMs = now.getTime()
  for (const [key, window] of windows) {
    if (nowMs - window.startedAt >= windowMs) windows.delete(key)
  }
  const existing = windows.get(clientKey)
  if (!existing) {
    windows.set(clientKey, { startedAt: nowMs, attempts: 1 })
    return null
  }
  if (existing.attempts >= limit) {
    return Math.max(
      1,
      Math.ceil((existing.startedAt + windowMs - nowMs) / 1_000),
    )
  }
  existing.attempts++
  return null
}

function pairingFailure(context: Context, error: unknown): Response {
  if (error instanceof PinPairingError) {
    const status = error.code === 'offer-expired'
      ? 410
      : error.code === 'pin-attempts-exhausted'
      ? 429
      : error.code === 'offer-not-found'
      ? 404
      : 401
    return context.json({ error: error.code }, status, {
      'Cache-Control': 'no-store',
    })
  }
  if (error instanceof RegistryError) {
    const status = error.code === 'offer-expired'
      ? 410
      : error.code === 'offer-not-found'
      ? 404
      : error.code === 'invalid-contract'
      ? 400
      : 409
    return context.json({ error: error.code }, status, {
      'Cache-Control': 'no-store',
    })
  }
  return context.json({ error: 'pairing_failed' }, 500)
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`)
  }
  return value
}
