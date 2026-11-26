import { childTransportError } from './bootstrap/pairing-transport.js'

export interface RuntimeAuthorization {
  readonly apiBase: string
  readonly launchToken: string
  /** Only the privileged Electron host has this IPC closure; never send it to preload. */
  readonly deviceGrant?: () => Promise<string | null>
}

export type RuntimeAuthorizationChanged = (
  authorization: RuntimeAuthorization | null,
) => void

interface BeforeSendHeadersDetails {
  readonly url: string
  readonly method?: string
  readonly requestHeaders: Record<string, string>
  readonly webContentsId?: number
  readonly frame?: { readonly parent: unknown | null } | null
}

interface BeforeSendHeadersResponse {
  readonly requestHeaders: Record<string, string>
}

interface WebRequestLike {
  onBeforeSendHeaders(
    filter: { readonly urls: readonly string[] },
    listener: (
      details: BeforeSendHeadersDetails,
      callback: (response: BeforeSendHeadersResponse) => void,
    ) => void,
  ): void
}

export interface RuntimeAuthorizationSession {
  readonly webRequest: WebRequestLike
}

export function installRuntimeRequestAuthorization(
  targetSession: RuntimeAuthorizationSession,
  isTrustedRequest: (details: BeforeSendHeadersDetails) => boolean,
): RuntimeAuthorizationChanged {
  let current: RuntimeAuthorization | null = null

  targetSession.webRequest.onBeforeSendHeaders(
    { urls: ['<all_urls>'] },
    (details, callback) => {
      const requestHeaders = details.requestHeaders
      const authorization = current
      if (
        authorization !== null &&
        isTrustedRequest(details) &&
        details.frame?.parent === null &&
        isPairedApiUrl(details.url, details.method, authorization) &&
        !hasAuthorizationHeader(requestHeaders)
      ) {
        if (authorization.deviceGrant) {
          void runtimeAuthorizationHeaders(authorization).then(headers => {
            // Main can be behind a proxy that rewrites both Host and path. Only
            // trusted top-frame lease creation gets the configured public mount.
            const admitted = { ...requestHeaders, ...headers }
            for (const key of Object.keys(admitted)) {
              if (key.toLowerCase() === 'x-shadow-preview-base') delete admitted[key]
            }
            if (headers.Authorization && details.method === 'POST' && /\/html-preview$/.test(new URL(details.url).pathname)) {
              admitted['X-Shadow-Preview-Base'] = authorization.apiBase
            }
            callback({ requestHeaders: current === authorization ? admitted : requestHeaders })
          }, () => callback({ requestHeaders }))
        } else {
          callback({ requestHeaders: { ...requestHeaders, Authorization: `Bearer ${authorization.launchToken}` } })
        }
        return
      }
      callback({ requestHeaders })
    },
  )

  return (authorization) => {
    current = authorization !== null && (authorization.deviceGrant ? normalizePairedEndpoint(authorization.apiBase) !== null : isLoopbackOrigin(authorization.apiBase))
      ? authorization
      : null
  }
}

export function normalizeLoopbackOrigin(apiBase: string): string | null {
  try {
    const url = new URL(apiBase)
    if (
      url.protocol !== 'http:' ||
      (url.hostname !== '127.0.0.1' && url.hostname !== '[::1]') ||
      url.username !== '' ||
      url.password !== '' ||
      url.pathname !== '/' ||
      url.search !== '' ||
      url.hash !== ''
    ) {
      return null
    }
    return url.origin
  } catch {
    return null
  }
}

function isLoopbackOrigin(apiBase: string): boolean {
  return normalizeLoopbackOrigin(apiBase) === apiBase
}

export function normalizePairedEndpoint(value: string): string | null {
  if (childTransportError(value, true)) return null
  const url = new URL(value)
  return url.origin + url.pathname.replace(/\/+$/, '')
}

export function runtimeAuthorizationHeaders(authorization: RuntimeAuthorization): Promise<Record<string, string>> {
  if (!authorization.deviceGrant) return Promise.resolve({ Authorization: `Bearer ${authorization.launchToken}` })
  return authorization.deviceGrant().then((token): Record<string, string> => token ? { Authorization: `ShadowDevice ${token}` } : {})
}

export function runtimeUrl(base: string, pathname: string): URL {
  return new URL(pathname.replace(/^\//, ''), `${base.replace(/\/+$/, '')}/`)
}

export function isPairedApiUrl(requestUrl: string, method: string | undefined, authorization: RuntimeAuthorization): boolean {
  try {
    const url = new URL(requestUrl)
    if (url.protocol === 'ws:') url.protocol = 'http:'
    if (url.protocol === 'wss:') url.protocol = 'https:'
    const base = new URL(authorization.apiBase)
    if (url.origin !== base.origin || url.username || url.password) return false
    if (!authorization.deviceGrant) return true
    if (method === 'OPTIONS') return false
    const prefix = base.pathname.replace(/\/+$/, '')
    if (!url.pathname.startsWith(`${prefix}/`)) return false
    const path = url.pathname.slice(prefix.length).replace(/^\/projects\/[^/]+(?=\/)/, '')
    if (path === '/api/live/ws' && requestUrl.startsWith('ws')) return false // Upgrade uses the exact, one-use POST ticket.
    return /^\/(?:api(?:\/|$)|(?:host\/)?v1\/query(?:\/|$))/.test(path) || path === '/nodes/v1'
  } catch { return false }
}

function hasAuthorizationHeader(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((name) =>
    name.toLowerCase() === 'authorization'
  )
}
