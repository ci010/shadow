import type { SidecarReadinessProbe, SidecarReadinessResult, SidecarRole } from './supervisor.js'

export type LocalControlFetch = (input: string | URL, init?: RequestInit) => Promise<Response>

export interface LocalControlRequestOptions {
  readonly fetch?: LocalControlFetch
  readonly requestTimeoutMs?: number
  readonly timeoutSignal?: (timeoutMs: number) => AbortSignal
}

export interface SidecarReadinessProbeOptions extends LocalControlRequestOptions {
  readonly expectedRole: SidecarRole
}

export interface SidecarShutdownRequest {
  readonly apiBase: string
  readonly launchToken: string
}

export interface SidecarShutdownResponse {
  readonly version: 1
  readonly accepted: true
}

export type AuthenticatedShutdownRequest = (
  request: SidecarShutdownRequest,
) => Promise<SidecarShutdownResponse>

export type LocalControlRequestErrorKind = 'configuration-error' | 'transient-error' | 'contract-error'

export class LocalControlRequestError extends Error {
  constructor(
    readonly kind: LocalControlRequestErrorKind,
    message: string,
  ) {
    super(message)
    this.name = 'LocalControlRequestError'
  }
}

const DEFAULT_REQUEST_TIMEOUT_MS = 2_000
const JSON_CONTENT_TYPE = 'application/json'

function configurationFailure(message: string): SidecarReadinessResult {
  return { ready: false, failure: { kind: 'configuration-error', message } }
}

function hasJsonContentType(response: Response): boolean {
  return response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() === JSON_CONTENT_TYPE
}

function isExactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const actualKeys = Object.keys(value)
  return actualKeys.length === keys.length && keys.every((key) => actualKeys.includes(key))
}

function isReadinessBody(value: unknown): value is {
  version: 1
  role: SidecarRole
  status: 'starting' | 'ready' | 'stopping'
} {
  if (!isExactObject(value, ['version', 'role', 'status'])) return false
  return value.version === 1
    && (value.role === 'main' || value.role === 'child')
    && (value.status === 'starting' || value.status === 'ready' || value.status === 'stopping')
}

function isShutdownBody(value: unknown): value is SidecarShutdownResponse {
  return isExactObject(value, ['version', 'accepted'])
    && value.version === 1
    && value.accepted === true
}

async function readJson(response: Response): Promise<unknown> {
  if (!hasJsonContentType(response)) throw new Error('Local control response has an invalid content type')
  try {
    return await response.json()
  } catch {
    throw new Error('Local control response contains invalid JSON')
  }
}

function requestSignal(options: LocalControlRequestOptions): AbortSignal {
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Local control request timeout must be a positive finite number')
  }
  return (options.timeoutSignal ?? AbortSignal.timeout)(timeoutMs)
}

function requestHeaders(launchToken: string): HeadersInit {
  return {
    accept: JSON_CONTENT_TYPE,
    authorization: `Bearer ${launchToken}`,
  }
}

export function createSidecarReadinessProbe(options: SidecarReadinessProbeOptions): SidecarReadinessProbe {
  const request = options.fetch ?? globalThis.fetch
  return async (apiBase, launchToken) => {
    let response: Response
    try {
      response = await request(new URL('/local/v1/readiness', apiBase), {
        method: 'GET',
        headers: requestHeaders(launchToken),
        signal: requestSignal(options),
      })
    } catch {
      return { ready: false }
    }

    if (response.status === 401 || response.status === 403) {
      return configurationFailure('Local control authentication was rejected')
    }
    if (response.status >= 500 && response.status !== 503) return { ready: false }
    if (response.status !== 200 && response.status !== 503) {
      return configurationFailure(`Local control readiness returned unexpected status ${response.status}`)
    }

    let body: unknown
    try {
      body = await readJson(response)
    } catch (error) {
      return configurationFailure(error instanceof Error ? error.message : 'Local control readiness response is invalid')
    }
    if (!isReadinessBody(body)) return configurationFailure('Local control readiness response has an invalid schema')
    if (body.role !== options.expectedRole) return configurationFailure('Local control readiness role does not match the launched sidecar')
    if (response.status === 200 && body.status !== 'ready') {
      return configurationFailure('Local control readiness status is inconsistent with HTTP status 200')
    }
    if (response.status === 503 && body.status === 'ready') {
      return configurationFailure('Local control readiness status is inconsistent with HTTP status 503')
    }
    return { ready: response.status === 200 }
  }
}

export function createAuthenticatedShutdownRequest(
  options: LocalControlRequestOptions = {},
): AuthenticatedShutdownRequest {
  const request = options.fetch ?? globalThis.fetch
  return async ({ apiBase, launchToken }) => {
    let response: Response
    try {
      response = await request(new URL('/local/v1/shutdown', apiBase), {
        method: 'POST',
        headers: requestHeaders(launchToken),
        signal: requestSignal(options),
      })
    } catch {
      throw new LocalControlRequestError('transient-error', 'Local control shutdown request failed')
    }
    if (response.status === 401 || response.status === 403) {
      throw new LocalControlRequestError('configuration-error', 'Local control shutdown authentication was rejected')
    }
    if (response.status !== 202) {
      const kind = response.status >= 500 ? 'transient-error' : 'contract-error'
      throw new LocalControlRequestError(kind, `Local control shutdown returned unexpected status ${response.status}`)
    }
    let body: unknown
    try {
      body = await readJson(response)
    } catch (error) {
      throw new LocalControlRequestError(
        'contract-error',
        error instanceof Error ? error.message : 'Local control shutdown response is invalid',
      )
    }
    if (!isShutdownBody(body)) {
      throw new LocalControlRequestError('contract-error', 'Local control shutdown response has an invalid schema')
    }
    return body
  }
}