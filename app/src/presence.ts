import { apiUrl } from './api-url.ts'
import type { DesktopPresenceApi } from '../../desktop/src/presence.ts'

/** A heartbeat is transport only, never evidence of actual input. */
export function startPresence(base: string, window: Window, document: Document,
  native?: DesktopPresenceApi, request: typeof fetch = fetch): () => void {
  const clientId = crypto.randomUUID()
  let lastInteraction: number | null = null
  let stopped = false
  let sending = false
  const lifetime = new AbortController()
  const interact = (event: Event) => {
    if (event.isTrusted) lastInteraction = performance.now()
  }
  const send = async () => {
    if (stopped || sending) return
    sending = true
    try {
      const system = await native?.system().catch(() => null) ?? null
      if (stopped) return
      const response = await request(apiUrl(base, '/api/chat/presence'), {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(10_000)]),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId, visible: document.visibilityState === 'visible', focused: document.hasFocus(),
          interactionAgeMs: lastInteraction === null ? null : Math.min(86_400_000, Math.floor(performance.now() - lastInteraction)), system }),
      })
      // fetch resolves at headers. Drain even error/legacy JSON responses so the
      // request finishes before its timeout signal fires; presence has no payload.
      await response.arrayBuffer()
    } catch { /* Missing/expired authentication and offline clients naturally become unknown. */ }
    finally { sending = false }
  }
  const changed = () => { void send() }
  for (const event of ['pointerdown', 'keydown', 'wheel', 'touchstart']) window.addEventListener(event, interact, { passive: true })
  document.addEventListener('visibilitychange', changed)
  window.addEventListener('focus', changed)
  window.addEventListener('blur', changed)
  const timer = setInterval(changed, 15_000)
  changed()
  return () => {
    stopped = true
    lifetime.abort()
    clearInterval(timer)
    for (const event of ['pointerdown', 'keydown', 'wheel', 'touchstart']) window.removeEventListener(event, interact)
    document.removeEventListener('visibilitychange', changed)
    window.removeEventListener('focus', changed)
    window.removeEventListener('blur', changed)
  }
}
