import type { LiveSubscription } from './live-client.ts'

/** Subscribe first, then attach. The first snapshot covers pre-ready resets;
 * after the gate opens every invalidation is delivered (including during reads).
 * Callers serialize reads and abort HTTP work when hidden/disposed.
 */
export function createInitialLiveSnapshot(options: { refresh: () => void; fallbackMs?: number }) {
  let disposed = false, started = false, attached = false, readyPending = true, recoveryPending = false
  const controller = new AbortController()
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  let timer: ReturnType<typeof setTimeout> | undefined
  function start() {
    if (disposed || started) return
    started = true
    clearTimeout(timer)
    resolve()
    options.refresh()
  }
  function recover() {
    if (disposed || !started) return
    if (readyPending) recoveryPending = true
    else options.refresh()
  }
  return {
    /** Resolve at initial ready or bounded fallback; consumers still apply their GET result. */
    getPromise: () => promise,
    attach(subscription: Pick<LiveSubscription, 'ready'>) {
      if (attached || disposed) return
      attached = true
      timer = setTimeout(start, options.fallbackMs ?? 750)
      void subscription.ready(controller.signal).then(() => {
        readyPending = false
        if (disposed) return
        if (started) options.refresh() // fallback snapshot predates subscription readiness
        else start()
      }, () => {
        readyPending = false
        if (!disposed && started && recoveryPending) options.refresh()
      })
    },
    invalidate() { if (!disposed && started) options.refresh() },
    reset: recover,
    reconnected: recover,
    dispose() { disposed = true; clearTimeout(timer); controller.abort(); resolve() },
  }
}
