import { inject, onActivated, onDeactivated, onScopeDispose, reactive, type ObjectDirective } from 'vue'
import { mobileSessionKey } from './mobile-client.ts'

export function mobileResourcePath(value: string, origin: string): string | null {
  let url: URL
  try { url = new URL(value, origin) } catch { return null }
  if (url.origin !== origin || url.username || url.password || /%(?:2f|5c|2e)/i.test(url.pathname)) return null
  // Markdown-relative static assets use the same exact-file raw endpoint.
  const staticMatch = url.pathname.match(/^(.*\/api\/(?:sessions|folders)\/[^/]+)\/static\/(.+)$/)
  if (staticMatch) {
    url.pathname = `${staticMatch[1]}/raw`
    url.search = ''
    try { url.searchParams.set('path', staticMatch[2].split('/').map(decodeURIComponent).join('/')) }
    catch { return null }
  }
  if (!/^(?:\/projects\/[^/]+)?\/api\/(?:media|(?:sessions|folders)\/[^/]+\/raw|io\/runs\/[^/]+\/artifacts\/[^/]+)$/.test(url.pathname)) return null
  url.searchParams.delete('ticket')
  return url.pathname + url.search
}
export function validateResourceTicket(data: unknown, path: string, origin: string): { url: string; expires: number } {
  const value = data as Record<string, unknown> | null
  if (!value || value.version !== 1 || typeof value.url !== 'string' || typeof value.expiresAt !== 'string') throw new Error('Main returned an invalid resource ticket.')
  const url = new URL(value.url)
  const expires = Date.parse(value.expiresAt)
  if (url.origin !== origin || url.protocol !== 'https:' || url.username || url.password || url.hash ||
    !url.searchParams.get('ticket') || mobileResourcePath(url.href, origin) !== path ||
    !Number.isFinite(expires) || expires <= Date.now() || expires > Date.now() + 65_000) {
    throw new Error('Main returned an invalid resource ticket.')
  }

  return { url: url.href, expires }
}

const mediaRestores = new WeakMap<HTMLMediaElement, () => void>()
/** Renewing a range-capable ticket must not restart a playing recording at zero. */
export const vMobileMedia: ObjectDirective<HTMLMediaElement, string | undefined> = {
  beforeUpdate(element, binding, next, previous) {
    if (!binding.value || binding.value !== binding.oldValue || next.props?.src === previous.props?.src) return
    mediaRestores.get(element)?.()
    const time = element.currentTime
    const playing = !element.paused && !element.ended
    const restore = () => {
      if (Number.isFinite(time) && time > 0) element.currentTime = time
      if (playing) void element.play().catch(() => {})
      cleanup()
    }
    const cleanup = () => { element.removeEventListener('loadedmetadata', restore); mediaRestores.delete(element) }
    mediaRestores.set(element, cleanup)
    element.addEventListener('loadedmetadata', restore, { once: true })
  },
  beforeUnmount(element) { mediaRestores.get(element)?.() },
}

export function useMobileResources() {
  const session = inject(mobileSessionKey, null)
  const cache = reactive(new Map<string, string>())
  const pending = new Set<string>()
  let controller = new AbortController()
  let active = true
  const expiries = new Map<string, number>()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  function pause() {
    active = false
    controller.abort()
    pending.clear()
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
  }
  onScopeDispose(pause)
  onDeactivated(pause)
  onActivated(() => {
    if (active) return
    active = true
    controller = new AbortController()
    for (const [path, expires] of expiries) {
      if (expires <= Date.now() + 5000) void load(path)
      else schedule(path, expires)
    }
  })
  function schedule(path: string, expires: number) {
    if (!active) return
    const timer = setTimeout(() => {
      timers.delete(timer)
      void load(path)
    }, Math.max(1, expires - Date.now() - 5000))
    timers.add(timer)
  }
  async function load(path: string) {
    if (!session || !active || pending.has(path) || controller.signal.aborted) return
    const request = controller
    pending.add(path)
    if (!expiries.has(path)) expiries.set(path, 0)
    try {
      const value = await session.resourceTicket(path, request.signal)
      const ticket = validateResourceTicket(value, path, session.origin.value)
      if (request.signal.aborted) return
      cache.set(path, ticket.url)
      expiries.set(path, ticket.expires)
      schedule(path, ticket.expires)
    } catch {
      if (!request.signal.aborted) {
        cache.set(path, '')
        expiries.delete(path)
        session.resourceError.value = 'A file preview or download could not be authorized. Retry the connection to reload protected resources.'
      }
    } finally { if (request === controller) pending.delete(path) }
  }
  function resolve(value: string | null | undefined): string | undefined {
    if (!session || !value) return value ?? undefined
    const path = mobileResourcePath(value, session.origin.value)
    if (!path) {
      try {
        const url = new URL(value, session.origin.value)
        // Never navigate an authenticated Main API without a scoped ticket.
        if (url.origin === session.origin.value && /\/(?:api|debug|local|cluster|pair|nodes)(?:\/|$)/.test(url.pathname)) return undefined
        return value
      } catch { return undefined }
    }
    const cached = cache.get(path)
    if (cached === undefined) void load(path)
    return cached || undefined
  }
  function html(value: string): string {
    if (!session) return value
    const template = document.createElement('template')
    template.innerHTML = value
    for (const element of template.content.querySelectorAll('[src], [href], [srcset], [poster]')) {
      element.removeAttribute('srcset')
      for (const attr of ['src', 'href', 'poster']) {
        const original = element.getAttribute(attr)
        if (!original || original.startsWith('#')) continue
        const safe = resolve(original)
        if (safe) element.setAttribute(attr, safe)
        else element.removeAttribute(attr)
      }
      element.setAttribute('referrerpolicy', 'no-referrer')
    }
    return template.innerHTML
  }
  return { resolve, html, native: !!session }
}
