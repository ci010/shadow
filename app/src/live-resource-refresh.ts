import type { LiveObserver, LiveStatus, LiveSubscription } from './live-client.ts'

export interface ResourceLivePool {
  client(base: string): { subscribe(topic: { kind: 'resources'; projectId: string }, observer: LiveObserver): LiveSubscription }
  observeHost?: (base: string, observer: (status: LiveStatus) => void) => () => void
}

/** Notifications carry no data or authority. HTTP snapshots remain authoritative.
 * Healthy live connections need no recurring snapshot reads; bounded polling is
 * only a disconnected fallback. Callers own initial reads, visibility and
 * snapshot serialization, including invalidations received during a read.
 */
export function createLiveResourceRefresh(pool: ResourceLivePool, options: {
  base: string
  projectId: string
  resource: 'interactions' | 'service-groups'
  refresh: () => void
  fallbackMs?: number
  delayMs?: number
}) {
  let disposed = false
  let live = false
  let fallback: ReturnType<typeof setTimeout> | undefined
  let pending: ReturnType<typeof setTimeout> | undefined
  function invalidate() {
    if (disposed || pending !== undefined) return
    pending = setTimeout(() => {
      pending = undefined
      if (!disposed) options.refresh()
    }, options.delayMs ?? 50)
  }
  function scheduleFallback() {
    if (disposed || live || fallback !== undefined) return
    fallback = setTimeout(() => {
      fallback = undefined
      if (!disposed && !live) { invalidate(); scheduleFallback() }
    }, options.fallbackMs ?? 30_000)
  }
  const unobserve = pool.observeHost?.(options.base, status => {
    live = status.phase === 'live'
    if (live) { clearTimeout(fallback); fallback = undefined }
    else scheduleFallback()
  })
  const subscription = pool.client(options.base).subscribe({ kind: 'resources', projectId: options.projectId }, {
    event: envelope => {
      const payload = envelope.payload
      if (payload && typeof payload === 'object' && 'event' in payload && payload.event === 'invalidate'
        && 'resource' in payload && payload.resource === options.resource) invalidate()
    },
    reset: invalidate,
    reconnected: invalidate,
  })
  scheduleFallback()
  return {
    dispose() {
      if (disposed) return
      disposed = true
      clearTimeout(pending); clearTimeout(fallback)
      pending = fallback = undefined
      unobserve?.()
      subscription.close()
    },
  }
}
