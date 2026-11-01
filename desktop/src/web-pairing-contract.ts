import { normalizeLoopbackOrigin } from './runtime-authorization.js'

export interface DesktopWebPairing {
  readonly version: 1
  readonly code: string
  readonly expiresAt: string
  readonly url: string
  readonly urls?: readonly string[]
}

export interface DesktopWebPairingApi {
  create(lan?: boolean): Promise<DesktopWebPairing>
}

export function parseDesktopWebPairing(value: unknown, expectedOrigin?: string, now = Date.now()): DesktopWebPairing {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid browser pairing response')
  const data = value as Record<string, unknown>
  const lanUrl = (value: unknown): boolean => {
    if (typeof value !== 'string') return false
    try {
      const u = new URL(value)
      const parts = u.hostname.split('.').map(Number)
      const privateAddress = parts[0] === 10
        || (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31)
        || (parts[0] === 192 && parts[1] === 168)
      return u.protocol === 'http:' && /^\d+\.\d+\.\d+\.\d+$/.test(u.hostname)
        && parts.every(n => n >= 0 && n <= 255) && privateAddress
        && !!u.port && value === `${u.origin}/`
    } catch { return false }
  }
  const origin = typeof data.url === 'string' ? (normalizeLoopbackOrigin(data.url) ?? (lanUrl(data.url) ? new URL(data.url).origin : null)) : null
  if (![4, 5].includes(Object.keys(data).length) || Object.keys(data).some(key => !['version', 'url', 'urls', 'code', 'expiresAt'].includes(key)) || data.version !== 1
    || !origin || data.url !== `${origin}/` || (expectedOrigin !== undefined && !lanUrl(data.url) && origin !== expectedOrigin)
    || (data.urls !== undefined && (!Array.isArray(data.urls) || data.urls.length > 32 || !data.urls.every(lanUrl) || (data.urls.length > 0 && data.urls[0] !== data.url)))
    || typeof data.code !== 'string' || !/^\d{8}$/.test(data.code)
    || typeof data.expiresAt !== 'string' || !Number.isFinite(Date.parse(data.expiresAt))
    || Date.parse(data.expiresAt) <= now || Date.parse(data.expiresAt) > now + 305_000) {
    throw new TypeError('Invalid browser pairing response')
  }
  return { version: 1, code: data.code, expiresAt: data.expiresAt, url: `${origin}/`, ...(data.urls !== undefined ? { urls: data.urls as string[] } : {}) }
}
