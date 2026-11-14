import { t } from '../i18n.ts'
import { getCurrentInstance } from 'vue'
import { requireResourcePinia } from '../stores/app.ts'
import { useProjectResourceStore } from '../stores/project.ts'

/** Compatibility accessor; the Pinia module is the only app-scoped owner. */
export function useProjectLiveState() {
  if (!getCurrentInstance()) throw new Error(t('Project live state requires a Vue application context.'))
  return useProjectResourceStore(requireResourcePinia()).owner
}
