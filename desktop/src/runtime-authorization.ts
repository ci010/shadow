export interface RuntimeAuthorization {
  readonly apiBase: string
  readonly launchToken: string
}

export type RuntimeAuthorizationChanged = (
  authorization: RuntimeAuthorization | null,
) => void

interface BeforeSendHeadersDetails {
  readonly url: string
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
      if (
        current !== null &&
        isTrustedRequest(details) &&
        details.frame?.parent === null &&
        isExactOrigin(details.url, current.apiBase) &&
        !hasAuthorizationHeader(requestHeaders)
      ) {
        callback({
          requestHeaders: {
            ...requestHeaders,
            Authorization: `Bearer ${current.launchToken}`,
          },
        })
        return
      }
      callback({ requestHeaders })
    },
  )

  return (authorization) => {
    current = authorization !== null && isLoopbackOrigin(authorization.apiBase)
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

function isExactOrigin(requestUrl: string, apiBase: string): boolean {
  try {
    const url = new URL(requestUrl)
    if (url.protocol === 'ws:') url.protocol = 'http:'
    return url.origin === apiBase
  } catch {
    return false
  }
}

function hasAuthorizationHeader(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((name) =>
    name.toLowerCase() === 'authorization'
  )
}
