import { isLanHttpHost } from '../../src/shared/lan-http.ts'
import { t } from './i18n.ts'
import { ref, type InjectionKey } from 'vue'

export interface MobileCredentials {
  version: 1
  origin: string
  allowLanHttp?: boolean
  accessToken: string
  expiresAt: string
}
export interface CredentialStore {
  get(): Promise<{ value: string | null }>
  set(options: { value: string }): Promise<void>
  remove(): Promise<void>
}
export function mobileBootTarget(mode: string, native: boolean): 'native' | 'unavailable' | 'standard' {
  return mode === 'mobile' ? native ? 'native' : 'unavailable' : 'standard'
}
export function validateMainOrigin(value: string, allowLanHttp = false): string {
  const trimmed = value.trim()
  let url: URL
  try { url = new URL(trimmed) } catch { throw new Error(t('Enter a complete HTTPS Main address, such as https://shadow.example.com.')) }
  if ((url.protocol !== 'https:' && !(allowLanHttp && url.protocol === 'http:' && isLanHttpHost(url.hostname))) || !url.hostname || url.username || url.password ||
    url.pathname !== '/' || url.search || url.hash || /[\\?#]/.test(trimmed) ||
    !/^https?:\/\/[^/]+\/?$/i.test(trimmed)) {
    throw new Error(t('Use an HTTPS origin only, or explicitly enable LAN HTTP with a private/loopback numeric IP; no username, password, path, query, or fragment.'))
  }
  return url.origin
}
function validExpiry(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && Date.parse(value) > Date.now()
}
export function parseMobileCredentials(value: string): MobileCredentials {
  const data = JSON.parse(value)
  if (!data || data.version !== 1 || typeof data.origin !== 'string' ||
    validateMainOrigin(data.origin, data.allowLanHttp === true) !== data.origin || typeof data.accessToken !== 'string' ||
    !/^[\x21-\x7e]{16,4096}$/.test(data.accessToken) || !validExpiry(data.expiresAt)) {
    throw new Error(t('Saved mobile credentials are invalid or expired. Pair this device again.'))
  }
  return { version: 1, origin: data.origin, ...(data.allowLanHttp === true ? { allowLanHttp: true } : {}), accessToken: data.accessToken, expiresAt: data.expiresAt }
}

export function isMobileBusinessPath(path: string, method = 'GET'): boolean {
  if (/%(?:2f|5c|2e)/i.test(path) || path.includes('\\')) return false
  const local = path.replace(/^\/projects\/[^/]+(?=\/)/, '')
  if (method.toUpperCase() === 'GET' && (
    /^\/(?:host\/)?v1\/query(?:\/|$)/.test(local) || local === '/debug/models' || path === '/nodes/v1'
  )) return true
  if (/^\/(?:local|cluster|pair|nodes|devices)(?:\/|$)/.test(local) ||
    /^\/api\/(?:local|cluster|pair|nodes|devices)(?:\/|$)/.test(local)) return false
  return /^\/api(?:\/|$)/.test(local)
}

export function createMobileFetch(options: {
  fetch: typeof fetch
  credentials: () => MobileCredentials | undefined
  webviewOrigin: string
  signal: () => AbortSignal
  unauthorized: () => void
}): typeof fetch {
  return async (input, init) => {
    const original = input instanceof Request ? input.url : String(input)
    const url = new URL(original, options.webviewOrigin)
    const webview = new URL(options.webviewOrigin)
    const credentials = options.credentials()
    const local = url.protocol === webview.protocol && url.host === webview.host
    const remote = !!credentials && url.origin === credentials.origin
    if (!local && !remote) {
      // Tool-returned URLs are not Main APIs and never inherit Main authorization.
      const request = new Request(input instanceof Request ? input : url, init)
      const headers = new Headers(request.headers)
      if (credentials && headers.get('authorization') === `Bearer ${credentials.accessToken}`) headers.delete('authorization')
      return options.fetch(new Request(request, { headers, credentials: 'omit', redirect: 'error' }))
    }
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    if (!isMobileBusinessPath(url.pathname, method)) throw new Error(t('This operation is not available to the mobile client.'))
    if (!credentials || options.signal().aborted) throw new Error(t('Connect to Main before continuing.'))
    if (Date.parse(credentials.expiresAt) <= Date.now()) {
      options.unauthorized()
      throw new Error(t('Your mobile session expired. Pair this device again.'))
    }
    const target = new URL(url.pathname + url.search, credentials.origin)
    const request = new Request(input instanceof Request ? input : target, init)
    const headers = new Headers(request.headers)
    headers.set('authorization', `Bearer ${credentials.accessToken}`)
    const signal = AbortSignal.any([request.signal, options.signal()])
    // Chromium requires HTTP/2 for ReadableStream uploads, even JSON bodies
    // rewrapped through Request. Buffer before forwarding to LAN HTTP/1.1.
    const body = request.body ? await request.blob() : undefined
    const response = await options.fetch(new Request(target, {
      method: request.method, headers, body, credentials: 'omit', redirect: 'error', signal,
    }))
    if (response.status === 401) options.unauthorized()
    return response
  }
}

export function createMobileSession(store: CredentialStore, request: typeof fetch) {
  const view = ref<'loading' | 'pairing' | 'connected' | 'paused' | 'error'>('loading')
  const origin = ref('')
  const error = ref('')
  const resourceError = ref('')
  const busy = ref(false)
  let credentials: MobileCredentials | undefined
  let lifetime = new AbortController()
  let operation: AbortController | undefined
  let generation = 0
  let expiryTimer: ReturnType<typeof setTimeout> | undefined
  let active = true
  let disposed = false
  let storeQueue: Promise<unknown> = Promise.resolve()
  const persist = (work: () => Promise<void>) => {
    const next = storeQueue.then(work, work)
    storeQueue = next.catch(() => {})
    return next
  }
  function stop() {
    generation++
    operation?.abort()
    operation = undefined
    lifetime.abort()
    clearTimeout(expiryTimer)
    busy.value = false
  }
  function fail(message: string) { error.value = message; view.value = 'error' }
  async function remove() {
    credentials = undefined
    try { await persist(() => store.remove()) }
    catch { fail(t('Could not clear credentials from secure storage. Retry disconnect before using this device again.')); return false }
    return true
  }
  async function loseAuth() {
    stop()
    const id = generation
    busy.value = true
    view.value = 'pairing'
    error.value = t('Your session expired or was revoked. Generate a new one-use code on Main and pair again.')
    await remove()
    if (id === generation) busy.value = false
  }
  function begin() {
    stop()
    const id = generation
    operation = new AbortController()
    busy.value = true
    error.value = ''
    return { id, signal: AbortSignal.any([operation.signal, AbortSignal.timeout(15_000)]) }
  }
  async function json(path: string, init: RequestInit, token?: string) {
    const headers = new Headers(init.headers)
    headers.set('content-type', 'application/json')
    if (token) headers.set('authorization', `Bearer ${token}`)
    return request(new URL(path, origin.value), { ...init, headers, credentials: 'omit', redirect: 'error', cache: 'no-store' })
  }
  function connected() {
    if (!active || disposed || !credentials) return
    lifetime = new AbortController()
    resourceError.value = ''
    view.value = 'connected'
    expiryTimer = setTimeout(() => { void loseAuth() }, Math.min(2_147_483_647, Date.parse(credentials.expiresAt) - Date.now()))
  }
  async function refresh() {
    if (!active || disposed) return
    if (!credentials) { view.value = 'pairing'; return }
    const { id, signal } = begin()
    view.value = 'loading'
    try {
      const response = await json('/mobile/v1/session', { signal }, credentials.accessToken)
      if (id !== generation) return
      if (response.status === 401) { await loseAuth(); return }
      if (!response.ok) throw new Error()
      const data = await response.json()
      if (id !== generation) return
      if (data.version !== 1 || data.authenticated !== true || !validExpiry(data.expiresAt)) {
        fail(t('Main returned an invalid session response. Check that Main supports this mobile client.')); return
      }
      credentials = { ...credentials, expiresAt: data.expiresAt }
      const saved = JSON.stringify(credentials)
      await persist(() => store.set({ value: saved }))
      if (id === generation) connected()
    } catch {
      if (id === generation) fail(t('Could not verify the connection or save it securely. Check Main, HTTPS, and device secure storage, then retry.'))
    } finally { if (id === generation) busy.value = false }
  }
  async function pair(endpoint: string, code: string, allowLanHttp = false) {
    if (busy.value || disposed || !active) return
    const { id, signal } = begin()
    view.value = 'pairing'
    try {
      origin.value = validateMainOrigin(endpoint, allowLanHttp)
      if (!/^(?:[a-f\d]+-)*[a-f\d]+$/i.test(code.trim()) || code.trim().replaceAll('-', '').length !== 24) {
        throw new Error(t('Enter the 24-character one-use pairing code generated on Main.'))
      }
      const response = await json('/mobile/v1/pair', { method: 'POST', body: JSON.stringify({ code: code.trim() }), signal })
      if (id !== generation) return
      if (!response.ok) throw new Error(response.status === 401 || response.status === 400
        ? t('This code is invalid, expired, or already used. Generate a new code on Main.')
        : t('Main could not pair this device. Check the connection and try a new code.'))
      let next: MobileCredentials
      try {
        const data = await response.json()
        next = parseMobileCredentials(JSON.stringify({ ...data, origin: origin.value, allowLanHttp }))
      } catch { throw new Error(t('Main returned an invalid pairing response. Check that Main supports this mobile client, then generate a new code.')) }
      if (id !== generation) return
      try { await persist(() => store.set({ value: JSON.stringify(next) })) }
      catch {
        void json('/mobile/v1/session', { method: 'DELETE', signal: AbortSignal.timeout(5000) }, next.accessToken).catch(() => {})
        throw new Error(t('Could not save credentials in device secure storage. Nothing was saved in browser storage. Retry with a new code.'))
      }
      if (id !== generation) return
      credentials = next
      connected()
    } catch (cause) {
      if (id === generation) error.value = cause instanceof Error && !(cause instanceof TypeError) ? cause.message : t('Could not reach Main securely. Check its HTTPS address and connection, then try a new code.')
    } finally { if (id === generation) busy.value = false }
  }
  async function load() {
    if (disposed || !active) return
    const { id } = begin()
    view.value = 'loading'
    try {
      await storeQueue
      const saved = await store.get()
      if (id !== generation) return
      if (!saved.value) { view.value = 'pairing'; return }
      try { credentials = parseMobileCredentials(saved.value); origin.value = credentials.origin }
      catch { await loseAuth(); return }
      await refresh()
    } catch { if (id === generation) fail(t('Device secure storage is unavailable. Unlock the device and retry. Browser storage is never used for credentials.')) }
    finally { if (id === generation) busy.value = false }
  }
  async function disconnect() {
    const previous = credentials
    stop()
    const id = generation
    view.value = 'loading'
    busy.value = true
    const cleared = await remove()
    let revoked = !previous
    if (previous) {
      try {
        const response = await request(new URL('/mobile/v1/session', previous.origin), {
          method: 'DELETE', headers: { authorization: `Bearer ${previous.accessToken}` },
          credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(5000),
        })
        revoked = response.ok || response.status === 401
      } catch { /* Local removal still disconnects this client. */ }
    }
    if (id !== generation) return
    busy.value = false
    if (cleared) {
      view.value = 'pairing'
      error.value = revoked ? '' : t('Disconnected on this device. Main was unreachable, so remote revocation was not confirmed. Revoke the mobile session on Main.')
    }
  }
  function setActive(value: boolean) {
    if (disposed) return
    active = value
    if (!value) { stop(); view.value = 'paused' }
    else if (credentials) void refresh()
    else void load()
  }
  return {
    view, origin, error, resourceError, busy, pair, load, refresh, disconnect, setActive,
    credentials: () => credentials,
    signal: () => lifetime.signal,
    unauthorized: () => { if (credentials) void loseAuth() },
    async resourceTicket(path: string, signal: AbortSignal) {
      if (!credentials || lifetime.signal.aborted) throw new Error(t('Connect to Main to open this resource.'))
      const response = await json('/mobile/v1/resource-ticket', {
        method: 'POST', body: JSON.stringify({ path }),
        signal: AbortSignal.any([signal, lifetime.signal, AbortSignal.timeout(15_000)]),
      }, credentials.accessToken)
      if (response.status === 401) { await loseAuth(); throw new Error(t('Pair again to open this resource.')) }
      if (!response.ok) throw new Error(t('Could not authorize this resource. Retry the connection to reload it.'))
      return response.json() as Promise<unknown>
    },
    dispose() { disposed = true; stop(); credentials = undefined },
  }
}
export type MobileSession = ReturnType<typeof createMobileSession>
export const mobileSessionKey: InjectionKey<MobileSession> = Symbol('mobile-session')
