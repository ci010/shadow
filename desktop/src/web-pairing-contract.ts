import { normalizeLoopbackOrigin } from './runtime-authorization.js'

export interface DesktopWebPairing {
  readonly version: 1
  readonly code: string
  readonly expiresAt: string
  readonly url: string
}

export interface DesktopWebPairingApi {
  create(): Promise<DesktopWebPairing>
}

export function parseDesktopWebPairing(value: unknown, expectedOrigin?: string, now = Date.now()): DesktopWebPairing {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid browser pairing response')
  const data = value as Record<string, unknown>
  const origin = typeof data.url === 'string' ? normalizeLoopbackOrigin(data.url) : null
  if (Object.keys(data).length !== 4 || data.version !== 1
    || !origin || data.url !== `${origin}/` || (expectedOrigin !== undefined && origin !== expectedOrigin)
    || typeof data.code !== 'string' || !/^[A-F0-9]{4}(?:-[A-F0-9]{4}){5}$/.test(data.code)
    || typeof data.expiresAt !== 'string' || !Number.isFinite(Date.parse(data.expiresAt))
    || Date.parse(data.expiresAt) <= now || Date.parse(data.expiresAt) > now + 305_000) {
    throw new TypeError('Invalid browser pairing response')
  }
  return { version: 1, code: data.code, expiresAt: data.expiresAt, url: `${origin}/` }
}
