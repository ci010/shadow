import type { RealtimeResource } from '../../src/realtime/protocol.ts'
import { createInitialLiveSnapshot } from './initial-live-snapshot.ts'
import type { LiveObserver, LiveStatus, LiveSubscription } from './live-client.ts'

export interface ResourceLivePool {
  client(base: string): { subscribe(topic: { kind: 'resources'; projectId: string }, observer: LiveObserver): LiveSubscription }
  onDispose?: (callback: () => void) => () => void
  observeHost?: (base: string, observer: (status: LiveStatus) => void) => () => void
}

/** Notifications carry no data or authority. HTTP snapshots remain authoritative.
 * Healthy live connections need no recurring snapshot reads; bounded polling is
 * only a disconnected fallback. The helper owns initial reads; callers own visibility and
 * snapshot serialization, including invalidations received during a read.
 */
export function createLiveResourceRefresh(pool: ResourceLivePool, options: {
  base: string
  projectId: string
  resource: RealtimeResource
  refresh: () => void
  fallbackMs?: number
  initialFallbackMs?: number
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
  let initialized = false
  const initial = createInitialLiveSnapshot({ refresh: () => {
    if (initialized) invalidate()
    else { initialized = true; if (!disposed) options.refresh() }
  }, fallbackMs: options.initialFallbackMs })
  const unobserve = pool.observeHost?.(options.base, status => {
    live = status.phase === 'live'
    if (live) { clearTimeout(fallback); fallback = undefined }
    else scheduleFallback()
  })
  const subscription = pool.client(options.base).subscribe({ kind: 'resources', projectId: options.projectId }, {
    event: envelope => {
      const payload = envelope.payload
      if (payload && typeof payload === 'object' && 'event' in payload && payload.event === 'invalidate'
        && 'resource' in payload && payload.resource === options.resource) initial.invalidate()
    },
    reset: () => initial.reset(),
    reconnected: () => initial.reconnected(),
  })
  initial.attach(subscription)
  scheduleFallback()
  return {
    getPromise: initial.getPromise,
    dispose() {
      if (disposed) return
      disposed = true
      initial.dispose()
      clearTimeout(pending); clearTimeout(fallback)
      pending = fallback = undefined
      unobserve?.()
      subscription.close()
    },
  }
}
