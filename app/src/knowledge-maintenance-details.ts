import { t } from './i18n.ts'
import { shallowRef } from 'vue'
import type { KnowledgeMaintenanceReport } from '../../src/knowledge/maintenance-contracts.ts'
import { resourceViews } from './resources/vue-resource.ts'

/** Compatibility selector for non-app consumers. The engine owns reads and abort generations. */
export function createMaintenanceDetails(load: (reportId: string, signal: AbortSignal) => Promise<KnowledgeMaintenanceReport>) {
  const views = resourceViews()
  type Lease = ReturnType<typeof views.acquire<KnowledgeMaintenanceReport>>
  const lease = shallowRef<Lease>()
  let selected: string | undefined
  const state = {
    get report() { return lease.value?.state.value.value },
    get loading() { return lease.value?.state.value.loading ?? false },
    get error() { return lease.value?.state.value.error ?? '' },
  }
  return {
    state,
    select(reportId: string | undefined, expanded: boolean, active = true): Promise<void> {
      if (selected !== reportId) { lease.value?.release(); lease.value = undefined; selected = reportId }
      if (!active || !expanded || !reportId) {
        if (lease.value?.state.value.loading) { lease.value.release(); lease.value = undefined }
        return Promise.resolve()
      }
      if (!lease.value) lease.value = views.acquire(reportId, signal => load(reportId, signal), { validate(report) {
        if (report.id !== reportId) throw new Error(t('Main returned invalid maintenance data. Refresh and retry.'))
      } })
      return lease.value.state.value.error ? lease.value.refresh() : lease.value.read()
    },
    dispose() { lease.value?.release(); lease.value = undefined; selected = undefined; views.dispose() },
  }
}
