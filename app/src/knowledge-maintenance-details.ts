import { t } from './i18n.ts'
import { shallowReactive } from 'vue'
import type { KnowledgeMaintenanceReport } from '../../src/knowledge/maintenance-contracts.ts'

/** Full diagnostic details are fetched only after disclosure; a report ID is immutable. */
export function createMaintenanceDetails(load: (reportId: string, signal: AbortSignal) => Promise<KnowledgeMaintenanceReport>) {
  const state = shallowReactive({ report: undefined as KnowledgeMaintenanceReport | undefined, loading: false, error: '' })
  let controller: AbortController | undefined
  let selected: string | undefined
  let pending: Promise<void> | undefined
  function cancel() { controller?.abort(); controller = undefined; pending = undefined; state.loading = false }
  return {
    state,
    select(reportId: string | undefined, expanded: boolean, active = true): Promise<void> {
      if (selected !== reportId) { cancel(); selected = reportId; state.report = undefined; state.error = '' }
      if (!active || !expanded || !reportId) { cancel(); return Promise.resolve() }
      if (state.report?.id === reportId) return Promise.resolve()
      if (pending) return pending
      const current = controller = new AbortController()
      state.loading = true; state.error = ''
      pending = (async () => {
        try {
          const report = await load(reportId, current.signal)
          if (current.signal.aborted || selected !== reportId) return
          if (report.id !== reportId) throw new Error(t('Main returned invalid maintenance data. Refresh and retry.'))
          state.report = report
        } catch (error) {
          if (!current.signal.aborted) state.error = error instanceof Error ? error.message : String(error)
        } finally {
          if (controller === current) { controller = undefined; pending = undefined; state.loading = false }
        }
      })()
      return pending
    },
    dispose() { cancel(); selected = undefined; state.report = undefined; state.error = '' },
  }
}
