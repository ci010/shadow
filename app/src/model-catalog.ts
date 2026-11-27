import { shallowRef, ref } from 'vue'
import { apiUrl } from './api-url.ts'
import { liveProjectId } from './composables/useLiveClient.ts'
import { createLiveResourceRefresh, type ResourceLivePool } from './live-resource-refresh.ts'
import { callerRead, sharedTransport } from './shared-read.ts'
import { budgetLiveHttp } from './live-http-budget.ts'
import { diagnosticFetch, fetchTransportIdentity } from './frontend-network-log.ts'
import { fetchModelCatalog } from './project-settings.ts'

export function createModelCatalog(base: string, pool?: ResourceLivePool, request: typeof fetch = fetch) {
  const dispatch = diagnosticFetch(request)
  const revision = ref(0)
  const value = shallowRef<Awaited<ReturnType<typeof fetchModelCatalog>>>()
  let pending: ReturnType<typeof fetchModelCatalog> | undefined
  let transport: AbortController | undefined
  let disposed = false
  function invalidate() {
    value.value = undefined
    pending = undefined
    transport?.abort()
    transport = undefined
    revision.value++
  }
  const projectId = liveProjectId(base)
  function configChanged(event: Event) {
    const id = (event as CustomEvent<{ projectId?: string }>).detail?.projectId
    if (!id || id === projectId) invalidate()
  }
  const events = typeof window === 'undefined' ? undefined : window
  events?.addEventListener('shadow:config-changed', configChanged)
  let initialized = false
  const live = pool && createLiveResourceRefresh(pool, { base, projectId, resource: 'config', revoke: invalidate, refresh() {
    if (initialized) invalidate()
    initialized = true
  } })
  return {
    revision, value,
    async read(signal?: AbortSignal) {
      await callerRead(live?.getPromise() ?? Promise.resolve(), signal)
      signal?.throwIfAborted()
      if (live?.revoked) throw new Error('Project is unavailable')
      if (disposed) throw new DOMException('Model catalog disposed', 'AbortError')
      if (value.value) return value.value
      if (!pending) {
        const controller = transport = new AbortController()
        const load = (signal: AbortSignal) => fetchModelCatalog(base, dispatch, signal)
        const next = pool ? budgetLiveHttp(base, controller.signal, load) : sharedTransport(load, controller.signal)
        pending = next
        void next.then(result => { if (pending === next) value.value = result }, () => {}).finally(() => {
          if (pending === next) { pending = undefined; transport = undefined }
        })
      }
      return callerRead(pending, signal)
    },
    invalidate,
    dispose() {
      if (disposed) return
      disposed = true
      invalidate()
      live?.dispose()
      events?.removeEventListener('shadow:config-changed', configChanged)
    },
  }
}

const catalogs = new WeakMap<ResourceLivePool, Map<typeof fetch, Map<string, { catalog: ReturnType<typeof createModelCatalog>; users: number }>>>()
export function scopedModelCatalog(base: string, pool: ResourceLivePool, request: typeof fetch = fetch) {
  let transports = catalogs.get(pool)
  if (!transports) { transports = new Map(); catalogs.set(pool, transports) }
  const identity = fetchTransportIdentity(request)
  let entries = transports.get(identity)
  if (!entries) { entries = new Map(); transports.set(identity, entries) }
  const key = apiUrl(base, '/api/models').toString()
  let entry = entries.get(key)
  if (!entry) {
    const catalog = createModelCatalog(base, pool, request)
    const stop = pool.onDispose?.(() => catalog.dispose())
    entry = { catalog: { ...catalog, dispose() { stop?.(); catalog.dispose() } }, users: 0 }
    entries.set(key, entry)
  }
  const current = entry
  current.users++
  let released = false
  const { dispose, ...catalog } = current.catalog
  return { ...catalog, release() {
    if (released) return
    released = true
    if (--current.users) return
    entries.delete(key)
    if (!entries.size) transports.delete(identity)
    dispose()
  } }
}
