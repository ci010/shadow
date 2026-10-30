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
  started(): boolean
  load(fresh?: boolean): Promise<unknown>
  invalidate(): void
  dispose(): void
}
interface Entry {
  listeners: Set<() => void>
  value?: unknown
  started: boolean
  valid: boolean
  version: number
  pending?: Promise<unknown>
  controller?: AbortController
  observer: ReturnType<typeof observeInteractions>
}
const pools = new WeakMap<Pool, Map<string, Entry>>()

/** Only non-secret GET envelopes are shared. Approval writes remain local to each pane. */
export function acquireInteractionRead(pool: Pool, base: string, projectId: string, url: string, refresh: () => void): SharedRead {
  let entries = pools.get(pool)
  if (!entries) { entries = new Map(); pools.set(pool, entries) }
  const key = JSON.stringify([base, projectId, url])
  let entry = entries.get(key)
  function invalidate(target: Entry) {
    target.valid = false
    target.version++
    if (!target.pending) for (const listener of target.listeners) listener()
  }
  if (!entry) {
    entry = { listeners: new Set(), valid: false, started: false, version: 0, observer: undefined! }
    const target = entry
    entry.observer = observeInteractions(pool, base, projectId, () => invalidate(target), () => { target.valid = false; target.version++; target.controller?.abort() })
    entries.set(key, entry)
  }
  const target = entry
  target.listeners.add(refresh)
  let released = false
  return {
    started: () => target.started,
    async load(fresh = false) {
      if (!fresh) await target.observer.getPromise()
      if (released || !target.listeners.size || !target.observer.visible()) throw new Error('Interaction read cancelled')
      target.started = true
      if (fresh) { target.valid = false; target.version++ }
      if (target.pending) return target.pending
      if (target.valid) return Promise.resolve(target.value)
      const controller = new AbortController()
      target.controller = controller
      target.pending = (async () => {
        // Never hand an invalidated in-flight snapshot to an approval pane.
        // All waiters follow the same catch-up read instead.
        while (true) {
          const version = target.version
          const response = await fetch(url, { cache: 'no-store', redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) })
          if (!response.ok) throw new Error('Interaction requests unavailable')
          const value: unknown = await response.json()
          if (controller.signal.aborted) throw new Error('Interaction read cancelled')
          if (target.version !== version) continue
          target.value = value
          target.valid = true
          return value
        }
      })().finally(() => {
        target.pending = undefined
        target.controller = undefined
      })
      return target.pending
    },
    invalidate() { invalidate(target) },
    dispose() {
      released = true
      target.listeners.delete(refresh)
      if (!target.listeners.size) {
        target.observer.dispose()
        target.controller?.abort()
        entries!.delete(key)
      }
    },
  }
}
