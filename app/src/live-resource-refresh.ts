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
  refresh: (reason?: string) => void
  revoke?: () => void
  fallbackMs?: number
  initialFallbackMs?: number
  delayMs?: number
}) {
  let disposed = false, live = false, revoked = false, recovered = false
  let fallback: ReturnType<typeof setTimeout> | undefined
  let pending: ReturnType<typeof setTimeout> | undefined
  let pendingReason: 'poll' | 'recovery' | 'event' | undefined
  function cancelPending() { clearTimeout(pending); pending = undefined; pendingReason = undefined }
  function invalidate(reason: NonNullable<typeof pendingReason>) {
    if (disposed || revoked) return
    if (!pendingReason || reason === 'event' || pendingReason === 'poll') pendingReason = reason
    if (pending !== undefined) return
    pending = setTimeout(() => {
      const next = pendingReason
      cancelPending()
      if (!disposed && !revoked) options.refresh(next)
    }, options.delayMs ?? 50)
  }
  function scheduleFallback() {
    if (disposed || revoked || live || fallback !== undefined) return
    fallback = setTimeout(() => {
      fallback = undefined
      if (!disposed && !revoked && !live) { invalidate('poll'); scheduleFallback() }
    }, options.fallbackMs ?? 30_000)
  }
  let initialized = false
  const initial = createInitialLiveSnapshot({
    refresh() {
      if (initialized) invalidate('event')
      else { initialized = true; if (!disposed && !revoked) options.refresh('initial') }
    },
    recover() {
      if (pool.observeHost && recovered) return
      // Reset, late readiness and reconnected describe the same gap. Real
      // invalidations use the distinct event path and remain dirty during reads.
      recovered = true
      invalidate('recovery')
    },
    fallbackMs: options.initialFallbackMs,
  })
  const unobserve = pool.observeHost?.(options.base, status => {
    const next = status.phase === 'live'
    if (live && !next) recovered = false
    live = next
    if (live) {
      clearTimeout(fallback); fallback = undefined
      if (pendingReason === 'poll') cancelPending()
    } else scheduleFallback()
  })
  const subscription = pool.client(options.base).subscribe({ kind: 'resources', projectId: options.projectId }, {
    event: envelope => {
      const payload = envelope.payload
      if (payload && typeof payload === 'object' && 'event' in payload && payload.event === 'invalidate'
        && 'resource' in payload && payload.resource === options.resource) initial.invalidate()
    },
    reset(reason) {
      if (reason === 'project-removed' && !options.revoke) {
        // Notification-only adapters without a value to clear still need
        // their existing authoritative refresh/error handling on removal.
        recovered = false
        initial.reset()
        return
      }
      if (reason === 'project-removed') {
        revoked = true
        cancelPending(); clearTimeout(fallback); fallback = undefined
        options.revoke?.()
        return
      }
      if (reason === 'project-restored') {
        revoked = false; recovered = false
        scheduleFallback()
      }
      initial.reset()
    },
    reconnected: () => initial.reconnected(),
  })
  initial.attach(subscription)
  scheduleFallback()
  return {
    getPromise: initial.getPromise,
    get revoked() { return revoked },
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
