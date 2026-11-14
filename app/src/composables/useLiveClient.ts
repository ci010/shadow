import { t } from '../i18n.ts'
import { getCurrentInstance, inject } from 'vue'
import { liveTransportKey, useLiveTransportStore } from '../stores/live.ts'
import { requireResourcePinia } from '../stores/app.ts'

export { createLiveClientPool } from '../stores/live.ts'

/** Compatibility accessor; ownership and disposal belong to the app's Pinia. */
export function useLiveClientPool() {
  const instance = getCurrentInstance()
  if (!instance) throw new Error(t('Live updates require a Vue application context.'))
  const supplied = inject(liveTransportKey, undefined)
  return supplied ?? useLiveTransportStore(requireResourcePinia()).pool
}

export function liveProjectId(base: string): string {
  const match = new URL(base).pathname.match(/\/projects\/([^/]+)\/?$/)
  return match ? decodeURIComponent(match[1]) : 'default'
}
