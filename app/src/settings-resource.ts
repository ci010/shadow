import { apiUrl } from './api-url.ts'
import { createSnapshot } from './project-live-state.ts'
import { liveProjectId } from './composables/useLiveClient.ts'
import { createLiveResourceRefresh, type ResourceLivePool } from './live-resource-refresh.ts'

/** A view never cancels a read owned by another view. */
export function callerRead<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort)
    const abort = () => { cleanup(); reject(signal.reason ?? new DOMException('Aborted', 'AbortError')) }
    if (signal.aborted) { void promise.catch(() => {}); abort(); return }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(value => { cleanup(); resolve(value) }, cause => { cleanup(); reject(cause) })
  })
}
/** Bound shared transport lifetime independently of any individual reader. */
export function sharedTransport<T>(load: (signal: AbortSignal) => Promise<T>, parent?: AbortSignal): Promise<T> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new DOMException('Shared read timed out. Retry.', 'TimeoutError')), 12_000)
  const abort = () => controller.abort(parent?.reason)
  if (parent?.aborted) abort()
  else parent?.addEventListener('abort', abort, { once: true })
  return callerRead(Promise.resolve().then(() => load(controller.signal)), controller.signal).finally(() => {
    clearTimeout(timeout)
    parent?.removeEventListener('abort', abort)
  })
}
// External credentials/files have no complete invalidation source: share only pending reads.
const requests = new WeakMap<typeof fetch, Map<string, Promise<unknown>>>()
export function coalescedRead<T>(request: typeof fetch, url: string, load: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
  let entries = requests.get(request)
  if (!entries) { entries = new Map(); requests.set(request, entries) }
  let pending = entries.get(url) as Promise<T> | undefined
  if (!pending) {
    pending = sharedTransport(load); entries.set(url, pending)
    const clear = () => { if (entries!.get(url) === pending) entries!.delete(url) }
    void pending.then(clear, clear)
  }
  return callerRead(pending, signal)
}
const pools = new WeakMap<ResourceLivePool, Map<typeof fetch, Map<string, ReturnType<typeof createConfigResource>>>>()
function createConfigResource(pool: ResourceLivePool, base: string, load: (signal: AbortSignal) => Promise<unknown>) {
  const snapshot = createSnapshot(signal => sharedTransport(load, signal), 0, { initialLoading: true })
  const live = createLiveResourceRefresh(pool, { base, projectId: liveProjectId(base), resource: 'config', refresh: snapshot.invalidate })
  return {
    read(signal?: AbortSignal) {
      return callerRead((async () => {
        await live.getPromise()
        if (snapshot.state.error) snapshot.invalidate()
        await snapshot.read()
        if (snapshot.state.error) throw new Error(snapshot.state.error)
        return structuredClone(snapshot.state.value)
      })(), signal)
    },
    invalidate: snapshot.invalidate,
    dispose() { live.dispose(); snapshot.dispose() },
  }
}
export function configResource(pool: ResourceLivePool, base: string, request: typeof fetch, load: (signal: AbortSignal) => Promise<unknown>) {
  let clients = pools.get(pool)
  if (!clients) {
    clients = new Map(); pools.set(pool, clients)
    pool.onDispose?.(() => { for (const entries of clients!.values()) for (const entry of entries.values()) entry.dispose(); clients!.clear(); pools.delete(pool) })
  }
  let entries = clients.get(request)
  if (!entries) { entries = new Map(); clients.set(request, entries) }
  const key = apiUrl(base, '/').toString()
  let entry = entries.get(key)
  if (!entry) { entry = createConfigResource(pool, key, load); entries.set(key, entry) }
  return entry
}
