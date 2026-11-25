import { ref, watch } from 'vue'
import { apiUrl } from '../api-url.ts'
import { isRecord } from '../folders-sidebar.ts'
import { createInitialLiveSnapshot } from '../initial-live-snapshot.ts'
import { createLiveRefresh } from '../live-refresh.ts'
import { affectsSessionResource } from '../session-invalidation.ts'
import { liveProjectId, useLiveClientPool } from './useLiveClient.ts'

interface FollowUp { next: string; after: number; nextRun: string | null }

export function useSessionFollowUp(props: { apiBase: string; sessionId: string; active?: boolean }, httpEnabled = () => true) {
  const pool = useLiveClientPool()
  const followUp = ref<FollowUp | null>(null)
  watch(() => [props.apiBase, props.sessionId, props.active, httpEnabled()] as const, ([base, sessionId, active, readHttp], _old, onCleanup) => {
    followUp.value = null
    if (active === false || !sessionId || !readHttp) return
    const snapshot = createLiveRefresh({
      load: async signal => {
        const response = await fetch(apiUrl(base, `/api/sessions/${encodeURIComponent(sessionId)}/follow-up`), { signal, cache: 'no-store' })
        if (!response.ok) throw new Error('Follow-up unavailable')
        const value: unknown = await response.json()
        if (!isRecord(value) || value.sessionId !== sessionId) throw new Error('Invalid follow-up response')
        const plan = value.followUp
        if (plan === null) return null
        if (!isRecord(plan) || typeof plan.next !== 'string' || typeof plan.after !== 'number' || !Number.isFinite(plan.after)
          || !(plan.nextRun === null || typeof plan.nextRun === 'string' && Number.isFinite(Date.parse(plan.nextRun)))) throw new Error('Invalid follow-up plan')
        return { next: plan.next, after: plan.after, nextRun: plan.nextRun }
      },
      apply: value => { followUp.value = value },
      onError: () => { followUp.value = null },
    })
    const refresh = () => { if (!document.hidden) snapshot.refresh() }
    const initial = createInitialLiveSnapshot({ refresh })
    const subscription = pool.client(base).subscribe({ kind: 'sessions', projectId: liveProjectId(base) }, {
      event: envelope => {
        if (affectsSessionResource(envelope.payload, sessionId, 'follow-up')) initial.invalidate()
      },
      reset: initial.reset,
      reconnected: initial.reconnected,
    })
    initial.attach(subscription)
    let phase = 'connecting'
    const stopHost = pool.observeHost(base, status => { phase = status.phase })
    const timer = setInterval(() => {
      if (phase === 'connecting' || phase === 'reconnecting' || phase === 'error') refresh()
    }, 30_000)
    const visibilityChanged = () => { if (!document.hidden) initial.invalidate() }
    document.addEventListener('visibilitychange', visibilityChanged)
    onCleanup(() => {
      initial.dispose()
      snapshot.dispose()
      subscription.close()
      stopHost()
      clearInterval(timer)
      document.removeEventListener('visibilitychange', visibilityChanged)
    })
  }, { immediate: true })
  return followUp
}
