import { shallowReactive, readonly } from 'vue'
import { apiUrl } from './api-url.ts'
import { fetchAutomations, type AutomationSummary } from './automations.ts'
import { liveProjectId } from './composables/useLiveClient.ts'
import type { LiveClient } from './live-client.ts'
import { createLiveRefresh } from './live-refresh.ts'
import { isRecord } from './folders-sidebar.ts'

export interface AutomationCatalogState {
  jobs: AutomationSummary[]
  loading: boolean
  loaded: boolean
  error: string
  revision: number
}

export function createAutomationCatalog(
  pool: { client: (base: string) => Pick<LiveClient, 'subscribe'> },
  options: { load?: typeof fetchAutomations; delayMs?: number } = {},
) {
  const entries = new Map<string, ReturnType<typeof createEntry>>()
  let disposed = false

  function createEntry(base: string) {
    const state = shallowReactive<AutomationCatalogState>({ jobs: [], loading: true, loaded: false, error: '', revision: 0 })
    const snapshot = createLiveRefresh({
      delayMs: options.delayMs,
      load: signal => {
        state.loading = true
        return (options.load ?? fetchAutomations)(base, signal)
      },
      apply: jobs => { state.jobs = jobs; state.error = ''; state.loaded = true; state.loading = false },
      onError: cause => {
        state.error = cause instanceof Error ? cause.message : 'Automations are unavailable. Retry.'
        state.loading = false
      },
    })
    let closed = false
    const refresh = () => {
      if (closed) return
      state.revision++
      snapshot.refresh()
    }
    const subscription = pool.client(base).subscribe({ kind: 'sessions', projectId: liveProjectId(base) }, {
      event: event => { if (!isRecord(event.payload) || event.payload.event !== 'activity') refresh() },
      reset: refresh,
    })
    const timer = setInterval(refresh, 20_000)
    snapshot.refresh()
    return {
      state: readonly(state), users: 0, refresh,
      dispose() {
        if (closed) return
        closed = true
        snapshot.dispose()
        subscription.close()
        clearInterval(timer)
      },
    }
  }

  return {
    acquire(base: string) {
      if (disposed) throw new Error('Automation catalog has been disposed.')
      const key = apiUrl(base, '/').toString()
      let entry = entries.get(key)
      if (!entry) { entry = createEntry(key); entries.set(key, entry) }
      const current = entry
      current.users++
      let released = false
      return {
        state: current.state,
        refresh: () => { if (!released) current.refresh() },
        release() {
          if (released) return
          released = true
          if (--current.users === 0) {
            current.dispose()
            if (entries.get(key) === current) entries.delete(key)
          }
        },
      }
    },
    dispose() {
      disposed = true
      for (const entry of entries.values()) entry.dispose()
      entries.clear()
    },
  }
}
