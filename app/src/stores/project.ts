import { defineStore } from 'pinia'
import { markRaw, onScopeDispose } from 'vue'
import { createProjectLiveState } from '../project-live-state.ts'
import { useLiveTransportStore } from './live.ts'

/** This facade owns the existing domain adapters, not a second copy of their data. */
export const useProjectResourceStore = defineStore('resource-project', () => {
  const { pool } = useLiveTransportStore()
  const owner = markRaw(createProjectLiveState(pool))
  let disposed = false
  const dispose = () => { if (!disposed) { disposed = true; owner.dispose() } }
  const remove = pool.onDispose?.(dispose) ?? (() => {})
  onScopeDispose(() => { remove(); dispose() })
  return { owner }
})
