import { shallowRef, ref } from 'vue'
import { apiUrl } from './api-url.ts'
import { liveProjectId } from './composables/useLiveClient.ts'
import { createLiveResourceRefresh, type ResourceLivePool } from './live-resource-refresh.ts'
import { callerRead, sharedTransport } from './settings-resource.ts'
import { fetchModelCatalog } from './project-settings.ts'

export function createModelCatalog(base: string, pool?: ResourceLivePool, request: typeof fetch = fetch) {
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
  const live = pool && createLiveResourceRefresh(pool, { base, projectId, resource: 'config', refresh() {
    if (initialized) invalidate()
    initialized = true
  } })
  return {
    revision, value,
    async read(signal?: AbortSignal) {
      await callerRead(live?.getPromise() ?? Promise.resolve(), signal)
      signal?.throwIfAborted()
      if (disposed) throw new DOMException('Model catalog disposed', 'AbortError')
      if (value.value) return value.value
      if (!pending) {
        const controller = transport = new AbortController()
        const next = sharedTransport(signal => fetchModelCatalog(base, request, signal), controller.signal)
        pending = next
        void next.then(result => { if (pending === next) value.value = result }, () => {}).finally(() => {
          if (pending === next) { pending = undefined; transport = undefined }
        })
      }
      return callerRead(pending, signal)
    },
    invalidate,
    dispose() {
      disposed = true
      invalidate()
      live?.dispose()
      events?.removeEventListener('shadow:config-changed', configChanged)
    },
  }
}

const catalogs = new WeakMap<ResourceLivePool, Map<string, ReturnType<typeof createModelCatalog>>>()
export function scopedModelCatalog(base: string, pool: ResourceLivePool) {
  let entries = catalogs.get(pool)
  if (!entries) { entries = new Map(); catalogs.set(pool, entries) }
  const key = apiUrl(base, '/api/models').toString()
  let entry = entries.get(key)
  if (!entry) {
    entry = createModelCatalog(base, pool)
    entries.set(key, entry)
    const catalog = entry
    pool.onDispose?.(() => { catalog.dispose(); entries.delete(key) })
  }
  return entry
}
