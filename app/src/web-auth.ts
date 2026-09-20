import { readonly, ref, watch, type InjectionKey } from 'vue'

export interface WebAuthStatus {
  version: 1
  required: boolean
  authenticated: boolean
  expiresAt?: string
}

export type WebAuthView = 'checking' | 'pairing' | 'authenticated' | 'error'

function parseStatus(value: unknown): WebAuthStatus {
  if (!value || typeof value !== 'object') throw new Error('Shadow returned an invalid browser session. Retry when the server is ready.')
  const status = value as Partial<WebAuthStatus>
  if (status.version !== 1 || typeof status.required !== 'boolean' || typeof status.authenticated !== 'boolean'
    || (!status.required && !status.authenticated)
    || (status.expiresAt !== undefined && (typeof status.expiresAt !== 'string' || !Number.isFinite(Date.parse(status.expiresAt))))) {
    throw new Error('Shadow returned an invalid browser session. Retry when the server is ready.')
  }
  return status as WebAuthStatus
}

export function createBrowserSession(apiBase: string, options: {
  fetch?: typeof fetch
  now?: () => number
  setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
} = {}) {
  const request = options.fetch ?? globalThis.fetch.bind(globalThis)
  const now = options.now ?? Date.now
  const setTimer = options.setTimer ?? setTimeout
  const clearTimer = options.clearTimer ?? clearTimeout
  const view = ref<WebAuthView>('checking')
  const status = ref<WebAuthStatus>()
  const error = ref('')
  const busy = ref(false)
  let expiration: ReturnType<typeof setTimeout> | undefined
  let current: AbortController | undefined
  let generation = 0
  let disposed = false
  let retryAction: 'check' | 'logout' = 'check'

  function clearExpiration() {
    if (expiration !== undefined) clearTimer(expiration)
    expiration = undefined
  }

  function accept(next: WebAuthStatus) {
    clearExpiration()
    status.value = next
    const remaining = next.expiresAt ? Date.parse(next.expiresAt) - now() : undefined
    if (!next.authenticated || (next.required && remaining !== undefined && remaining <= 0)) {
      view.value = 'pairing'
      return
    }
    view.value = 'authenticated'
    if (next.required && remaining !== undefined) {
      expiration = setTimer(() => {
        // Hide protected content immediately, even if the expiry check is offline.
        view.value = 'checking'
        void perform('check')
      }, Math.min(remaining, 2_147_483_647))
    }
  }

  async function perform(action: 'check' | 'pair' | 'logout', code?: string): Promise<void> {
    if (disposed || (action === 'check' && busy.value)) return
    current?.abort()
    const controller = new AbortController()
    current = controller
    const ownGeneration = ++generation
    busy.value = true
    error.value = ''
    retryAction = action === 'logout' ? 'logout' : 'check'
    if (action === 'logout') {
      clearExpiration()
      view.value = 'checking'
    }
    const timeout = setTimer(() => controller.abort(), 15_000)
    try {
      const response = await request(new URL(action === 'pair' ? '/api/web-auth/pair' : '/api/web-auth/session', apiBase), {
        method: action === 'pair' ? 'POST' : action === 'logout' ? 'DELETE' : 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        signal: controller.signal,
        ...(action === 'pair' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) } : {}),
      })
      if (!response.ok) {
        if (action === 'check' && response.status === 401) {
          if (ownGeneration === generation && !disposed) accept({ version: 1, required: true, authenticated: false })
          return
        }
        if (action === 'pair' && response.status === 401) throw new Error('That pairing code is invalid or expired. Generate a new code in the trusted Shadow CLI.')
        if (action === 'pair' && response.status === 429) throw new Error('Too many pairing attempts. Wait a moment before trying again.')
        if (action === 'pair' && response.status === 400) throw new Error('The pairing code could not be accepted. Check the code and try again.')
        throw new Error(`Shadow could not ${action === 'logout' ? 'sign out' : 'verify this browser'} (HTTP ${response.status}). Retry when the server is ready.`)
      }
      const next = parseStatus(await response.json())
      if (ownGeneration !== generation || disposed) return
      if (action === 'pair' && !next.authenticated) throw new Error('Pairing did not authorize this browser. Generate a new code and try again.')
      if (action === 'logout' && next.required && next.authenticated) throw new Error('Shadow did not revoke this browser session. Retry signing out.')
      accept(next)
    } catch (cause) {
      if (ownGeneration !== generation || disposed) return
      clearExpiration()
      error.value = controller.signal.aborted
        ? 'Shadow did not respond in time. Check that the server is running and retry.'
        : cause instanceof Error && !(cause instanceof TypeError) && !(cause instanceof SyntaxError)
          ? cause.message : 'Could not verify this browser with Shadow. Check that the server is running and retry.'
      view.value = action === 'pair' ? 'pairing' : 'error'
    } finally {
      clearTimer(timeout)
      if (ownGeneration === generation) busy.value = false
    }
  }

  return {
    view: readonly(view),
    status: readonly(status),
    error: readonly(error),
    busy: readonly(busy),
    refresh: () => perform('check'),
    pair: (code: string) => perform('pair', code.trim()),
    logout: () => perform('logout'),
    retry: () => perform(retryAction),
    listen(target: Window, document: Document) {
      const refresh = () => { if (view.value !== 'error') void perform('check') }
      const visible = () => { if (document.visibilityState === 'visible') refresh() }
      target.addEventListener('focus', refresh)
      target.addEventListener('online', refresh)
      document.addEventListener('visibilitychange', visible)
      return () => {
        target.removeEventListener('focus', refresh)
        target.removeEventListener('online', refresh)
        document.removeEventListener('visibilitychange', visible)
      }
    },
    dispose() {
      disposed = true
      ++generation
      current?.abort()
      clearExpiration()
    },
  }
}

export type BrowserSession = ReturnType<typeof createBrowserSession>
export const browserSessionKey: InjectionKey<BrowserSession> = Symbol('shadow.browser-session')

export function mountBrowserSession(session: BrowserSession, mounts: {
  authenticated: () => () => void
  unauthenticated: () => () => void
}): () => void {
  let unmount: (() => void) | undefined
  const stop = watch(() => session.view.value === 'authenticated', (authenticated) => {
    unmount?.()
    unmount = authenticated ? mounts.authenticated() : mounts.unauthenticated()
  }, { immediate: true, flush: 'sync' })
  return () => { stop(); unmount?.() }
}
