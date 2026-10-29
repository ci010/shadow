/** Development metadata only: no headers, query, bodies or arbitrary paths.
 * Chromium's native error codes are not exposed by fetch/EventSource. */
export function installFrontendNetworkLog(
  target: Window & typeof globalThis,
  base: string,
  capture: (message: string) => void,
): () => void {
  const scope = new URL(base)
  const prefix = scope.pathname.replace(/\/$/, '')
  const label = (input: unknown): string | undefined => {
    try {
      const raw = typeof input === 'string' || input instanceof URL ? input : input instanceof Request ? input.url : undefined
      if (!raw) return
      const url = new URL(String(raw), target.location.href)
      if (url.origin !== scope.origin) return
      let path = url.pathname
      if (path.startsWith(`${prefix}/api/`)) path = path.slice(prefix.length)
      else if (path.startsWith('/projects/')) return
      // Only fixed endpoint identities; excludes diagnostic transport itself.
      const endpoint = /^\/api\/(live|projects|service-groups|agent-types|work\/history|background-tasks)(?:\/|$)/.exec(path)?.[1]
      return endpoint ? `API ${endpoint}` : undefined
    } catch { return }
  }
  let active = true
  const report = (message: string) => { if (active) { try { capture(message) } catch { /* diagnostic only */ } } }
  const originalFetch = target.fetch
  const wrappedFetch: typeof fetch = function(this: unknown, input, init) {
    const endpoint = label(input)
    return Reflect.apply(originalFetch, this, [input, init]).then((response: Response) => {
      if (endpoint && response.status >= 400) report(`${endpoint}: HTTP ${response.status}`)
      return response
    }, (error: unknown) => {
      if (endpoint && !(init?.signal?.aborted || (input instanceof Request && input.signal.aborted))) report(`${endpoint}: fetch failed (network/CORS/connection; browser code unavailable)`)
      throw error
    })
  }
  target.fetch = wrappedFetch
  const OriginalSource = target.EventSource
  const controller = new AbortController()
  const WrappedSource = OriginalSource && new Proxy(OriginalSource, {
    construct(ctor, args, newTarget) {
      const source = Reflect.construct(ctor, args, newTarget) as EventSource
      const endpoint = label(args[0])
      if (endpoint) {
        const listener = () => report(`${endpoint}: EventSource error (connection interrupted or rejected; HTTP status/browser code unavailable)`)
        source.addEventListener('error', listener, { signal: controller.signal })
      }
      return source
    },
  })
  if (WrappedSource) target.EventSource = WrappedSource
  return () => {
    active = false
    if (target.fetch === wrappedFetch) target.fetch = originalFetch
    if (target.EventSource === WrappedSource) target.EventSource = OriginalSource
    controller.abort()
  }
}
