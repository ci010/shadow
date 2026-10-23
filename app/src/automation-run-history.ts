import { t } from './i18n.ts'
import { AutomationRequestError, fetchAutomationRuns, type AutomationRunSummary } from './automations.ts'
import { createLiveRefresh } from './live-refresh.ts'

export interface AutomationRunHistory {
  runs: AutomationRunSummary[]
  total: number
  nextOffset: number
  loaded: boolean
  loading: boolean
  error: string
}

export function emptyAutomationRunHistory(): AutomationRunHistory {
  return { runs: [], total: 0, nextOffset: 0, loaded: false, loading: false, error: '' }
}

/** Refresh the loaded window without dropping rows or mixing it with an appended page. */
export function createAutomationRunHistory(
  base: string, id: string, state: AutomationRunHistory,
  options: { request?: typeof fetch; delayMs?: number } = {},
) {
  let refreshRequested = false
  let retryAppend = false
  let disposed = false
  const snapshot = createLiveRefresh({
    delayMs: options.delayMs,
    load: async signal => {
      const append = state.loaded && !refreshRequested
      refreshRequested = false
      retryAppend = append
      const target = append ? 0 : Math.max(1, state.nextOffset)
      let offset = append ? state.nextOffset : 0
      let total = state.total
      const runs: AutomationRunSummary[] = []
      do {
        const page = await fetchAutomationRuns(base, id, offset, signal, options.request)
        runs.push(...page.runs)
        total = page.total
        offset += page.runs.length
        if (!page.runs.length) break
      } while (!append && offset < Math.min(target, total))
      return { append, runs, total, offset }
    },
    apply: page => {
      const bySession = new Map((page.append ? state.runs : []).map(run => [run.sessionId, run]))
      for (const run of page.runs) bySession.set(run.sessionId, run)
      state.runs = [...bySession.values()].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
      state.total = page.total
      state.nextOffset = page.offset
      state.loaded = true
      state.loading = refreshRequested
      state.error = ''
    },
    onError: cause => {
      state.loading = refreshRequested
      state.error = cause instanceof AutomationRequestError ? cause.message : t('Runs could not be loaded. Check Main and retry.')
    },
  })
  function refresh() {
    if (disposed) return
    refreshRequested = true
    state.loading = true
    snapshot.refresh()
  }
  function loadMore() {
    if (disposed || state.loading || !state.loaded || state.nextOffset >= state.total) return
    state.loading = true
    snapshot.refresh()
  }
  return {
    refresh, loadMore,
    retry() { if (retryAppend && state.loaded) loadMore(); else refresh() },
    dispose() { disposed = true; snapshot.dispose(); state.loading = false },
  }
}
