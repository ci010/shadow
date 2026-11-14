import { readonly } from 'vue'
import { apiUrl } from './api-url.ts'
import { fetchAutomations, type AutomationSummary } from './automations.ts'
import { liveProjectId } from './composables/useLiveClient.ts'
import { createLiveResourceRefresh, type ResourceLivePool } from './live-resource-refresh.ts'
import { resourceViews } from './resources/vue-resource.ts'

export interface AutomationCatalogState {
  jobs: readonly AutomationSummary[]
  loading: boolean
  loaded: boolean
  error: string
  revision: number
}

/** Non-component compatibility facade. There is no legacy scheduler/cache here:
 * reads, commits, generations and lease disposal use the same resource engine.
 * First-party Vue consumers acquire the app's catalog Pinia module instead. */
export function createAutomationCatalog(pool: ResourceLivePool, options: { load?: typeof fetchAutomations; delayMs?: number } = {}) {
  const views = resourceViews()
  const selectors = new WeakMap<object, Readonly<AutomationCatalogState>>()
  return {
    acquire(base: string) {
      const key = apiUrl(base, '/').toString()
      const lease = views.acquire(key, signal => (options.load ?? fetchAutomations)(key, signal), { initialLoading: true }, invalidate => {
        const live = createLiveResourceRefresh(pool, { base: key, projectId: liveProjectId(key), resource: 'automations', refresh: invalidate, delayMs: options.delayMs })
        return live.dispose
      })
      let state = selectors.get(lease.state)
      if (!state) {
        state = readonly({
          get jobs() { return lease.state.value.value ?? [] },
          get loading() { return lease.state.value.loading },
          get loaded() { return lease.state.value.value !== undefined },
          get error() { return lease.state.value.error },
          get revision() { return lease.state.value.revision },
        })
        selectors.set(lease.state, state)
      }
      let released = false
      return { state, refresh() { if (!released) void lease.refresh() }, release() { if (!released) { released = true; lease.release() } } }
    },
    dispose: views.dispose,
  }
}
