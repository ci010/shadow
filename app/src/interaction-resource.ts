import { createLiveResourceRefresh, type ResourceLivePool } from './live-resource-refresh.ts'

type Pool = ResourceLivePool

/** Visibility is a read boundary, not a credential/state boundary. */
export function observeInteractions(pool: Pool, base: string, projectId: string, refresh: () => void, hidden?: () => void) {
  let live: ReturnType<typeof createLiveResourceRefresh> | undefined
  let disposed = false
  const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden'
  function resume() {
    live?.dispose()
    live = undefined
    if (!disposed && visible()) live = createLiveResourceRefresh(pool, { base, projectId, resource: 'interactions', refresh })
  }
  function visibility() { if (!visible()) hidden?.(); resume() }
  resume()
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', visibility)
  return {
    visible,
    getPromise: () => live?.getPromise() ?? Promise.resolve(),
    dispose() {
      disposed = true
      live?.dispose()
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', visibility)
    },
  }
}

interface SharedRead {
  /** Distinguish an in-flight HTTP read from waiting on initial readiness. */
  started(): boolean
  load(fresh?: boolean): Promise<unknown>
  invalidate(): void
  dispose(): void
}
interface Entry {
  listeners: Set<() => void>
  value?: unknown
  valid: boolean
  version: number
  pending?: Promise<unknown>
  controller?: AbortController
  observer?: ReturnType<typeof observeInteractions>
  eviction?: ReturnType<typeof setTimeout>
  disposed?: boolean
  unobserveDispose?: () => void
}
function destroy(target: Entry) {
  target.disposed = true
  target.valid = false
  target.version++
  clearTimeout(target.eviction)
  target.observer?.dispose()
  target.unobserveDispose?.()
  target.controller?.abort()
  target.listeners.clear()
}
const pools = new WeakMap<Pool, Map<string, Entry>>()

/** Only non-secret GET envelopes are shared. Approval writes remain local to each pane. */
export function acquireInteractionRead(pool: Pool, base: string, projectId: string, url: string, refresh: () => void): SharedRead {
  let entries = pools.get(pool)
  if (!entries) { entries = new Map(); pools.set(pool, entries) }
  const key = JSON.stringify([base, projectId, url])
  let entry = entries.get(key)
  function invalidate(target: Entry) {
    if (target.disposed) return
    target.valid = false
    target.version++
    if (!target.pending) for (const listener of target.listeners) listener()
  }
  if (!entry) {
    entry = { listeners: new Set(), valid: false, version: 0 }
    const target = entry
    entries.set(key, entry)
    // Disposed pools call back synchronously, before any subscription is made.
    entry.unobserveDispose = pool.onDispose?.(() => {
      destroy(target)
      entries!.delete(key)
    })
    if (!target.disposed) entry.observer = observeInteractions(pool, base, projectId, () => invalidate(target), () => { target.valid = false; target.version++; target.controller?.abort() })
  }
  const target = entry
  clearTimeout(target.eviction)
  target.eviction = undefined
  if (!target.disposed) target.listeners.add(refresh)
  let released = false
  return {
    started: () => !!target.pending,
    async load(fresh = false) {
      if (!fresh) await target.observer?.getPromise()
      if (released || target.disposed || !target.listeners.size || !target.observer?.visible()) throw new Error('Interaction read cancelled')
      if (fresh) { target.valid = false; target.version++ }
      if (target.pending) return target.pending
      if (target.valid) return Promise.resolve(target.value)
      const controller = new AbortController()
      target.controller = controller
      const pending = (async () => {
        // Never hand an invalidated in-flight snapshot to an approval pane.
        // All waiters follow the same catch-up read instead.
        while (true) {
          const version = target.version
          const response = await fetch(url, { cache: 'no-store', redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) })
          if (!response.ok) throw new Error('Interaction requests unavailable')
          const value: unknown = await response.json()
          if (controller.signal.aborted || target.disposed) throw new Error('Interaction read cancelled')
          if (target.version !== version) continue
          target.value = value
          target.valid = true
          return value
        }
      })().finally(() => {
        if (target.pending === pending) {
          target.pending = undefined
          target.controller = undefined
        }
      })
      target.pending = pending
      return pending
    },
    invalidate() { invalidate(target) },
    dispose() {
      if (released) return
      released = true
      target.listeners.delete(refresh)
      if (!target.listeners.size && !target.disposed) {
        // Keep the live invalidation observer, not a freshness deadline. An idle
        // cache never starts HTTP; a later pane can reuse its valid envelope.
        if (target.pending) {
          invalidate(target)
          target.controller?.abort()
          target.pending = undefined
          target.controller = undefined
        }
        target.eviction = setTimeout(() => {
          destroy(target)
          entries!.delete(key)
        }, 60_000)
        target.eviction.unref?.()
      }
    },
  }
}
