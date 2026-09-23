import { getCurrentInstance, inject, type InjectionKey } from 'vue'
import { createProjectLiveState } from '../project-live-state.ts'
import { useLiveClientPool } from './useLiveClient.ts'

const key: InjectionKey<ReturnType<typeof createProjectLiveState>> = Symbol.for('shadow.project-live-state')
export function useProjectLiveState() {
  const instance = getCurrentInstance()
  if (!instance) throw new Error('Project live state requires a Vue application context.')
  const existing = inject(key, undefined)
  if (existing) return existing
  const state = createProjectLiveState(useLiveClientPool())
  instance.appContext.provides[key] = state
  instance.appContext.app.onUnmount(() => state.dispose())
  return state
}
