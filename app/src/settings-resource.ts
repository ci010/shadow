import { apiUrl } from './api-url.ts'
import { liveProjectId } from './composables/useLiveClient.ts'
import { createLiveResourceRefresh, type ResourceLivePool } from './live-resource-refresh.ts'

import { callerRead, sharedTransport } from './shared-read.ts'
import { budgetLiveHttp } from './live-http-budget.ts'
import { fetchTransportIdentity } from './frontend-network-log.ts'
import { createResource } from './resources/engine.ts'
export { callerRead, sharedTransport } from './shared-read.ts'

// External credentials/files have no complete invalidation source: share only pending reads.
const requests = new WeakMap<typeof fetch, Map<string, Promise<unknown>>>()
export function coalescedRead<T>(request: typeof fetch, url: string, load: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
  request = fetchTransportIdentity(request)
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
const pools = new WeakMap<ResourceLivePool, Map<typeof fetch, Map<string, { users: number; resource: ReturnType<typeof createSettingsResource> }>>>()
function createSettingsResource(pool: ResourceLivePool, base: string, load: (signal: AbortSignal) => Promise<unknown>) {
  let queued: AbortSignal | undefined
  const snapshot = createResource(signal => {
    queued = signal
    const dispatched = () => { if (queued === signal) queued = undefined }
    return budgetLiveHttp(base, signal, inner => { dispatched(); return load(inner) }).finally(dispatched)
  }, 0, { initialLoading: true })
  function invalidate(reason?: string) {
    // An undispatched GET already sees every event before it starts. Only
    // changes after dispatch mark the engine dirty for a trailing GET.
    if (!queued || queued.aborted) snapshot.invalidate(reason)
  }
  const live = createLiveResourceRefresh(pool, { base, projectId: liveProjectId(base), resource: 'config',
    refresh: invalidate, revoke: () => snapshot.revoke('Project is unavailable') })
  return {
    async read(signal?: AbortSignal, fresh = false) {
      await callerRead(live.getPromise(), signal)
      signal?.throwIfAborted()
      if (!live.revoked && (fresh || snapshot.state.error)) invalidate('explicit-read')
      await callerRead(snapshot.read(), signal)
      if (snapshot.state.error) throw new Error(snapshot.state.error)
      if (snapshot.state.status === 'disposed') throw new DOMException('Settings resource disposed', 'AbortError')
      return structuredClone(snapshot.state.value)
    },
    subscribe(listener: (state: typeof snapshot.state) => void) {
      let previous = snapshot.state.value
      listener(snapshot.state)
      return snapshot.subscribe(state => {
        if (state.value === previous) return
        previous = state.value
        listener(state)
      })
    },
    invalidate() { if (!live.revoked) invalidate() },
    dispose() { live.dispose(); snapshot.dispose() },
  }
}

/** A lease per visible reader. Last release drops both the subscription and all
 * cached data, including any queued/active GET; no inactive Project timers. */
export function settingsResource(pool: ResourceLivePool, base: string, request: typeof fetch, path: string, load: (signal: AbortSignal) => Promise<unknown>) {
  let clients = pools.get(pool)
  if (!clients) { clients = new Map(); pools.set(pool, clients) }
  const transport = fetchTransportIdentity(request)
  let entries = clients.get(transport)
  if (!entries) { entries = new Map(); clients.set(transport, entries) }
  const key = apiUrl(base, path).toString()
  let entry = entries.get(key)
  if (!entry) {
    const resource = createSettingsResource(pool, base, load)
    const stop = pool.onDispose?.(() => resource.dispose())
    entry = { users: 0, resource: { ...resource, dispose() { stop?.(); resource.dispose() } } }
    entries.set(key, entry)
  }
  entry.users++
  const current = entry
  let released = false
  const { dispose: _dispose, ...resource } = current.resource
  return { ...resource, release() {
    if (released) return
    released = true
    if (--current.users) return
    entries.delete(key)
    if (!entries.size) clients.delete(transport)
    current.resource.dispose()
  } }
}

export function configResource(pool: ResourceLivePool, base: string, request: typeof fetch, load: (signal: AbortSignal) => Promise<unknown>) {
  return settingsResource(pool, base, request, '/api/config', load)
}
