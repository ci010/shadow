import { createSnapshot } from './project-live-state.ts'
import { projectJson } from './projects.ts'
import { parseWorkView } from './work-alignment.ts'
import { isRecord } from './folders-sidebar.ts'
import { t } from './i18n.ts'

/** A draft may not be persisted yet: explicit retry can probe again, but
 * unrelated revisions must not repeatedly request a known missing session. */
export function createSessionWorkStatus(base: string, id: string, request: typeof fetch = fetch, delayMs = 50) {
  let missing: Error | undefined
  let completedTurn = ''
  const snapshot = createSnapshot(async signal => {
    if (missing) throw missing
    const turnAtRead = completedTurn
    return parseWorkView(await projectJson(base, `/api/sessions/${encodeURIComponent(id)}/work?history=0`, { signal }, async (input, init) => {
      const response = await request(input, init)
      if (!signal.aborted && response.status === 404 && response.headers.get('content-type')?.includes('application/json')) {
        const detail: unknown = await response.clone().json().catch(() => undefined)
        if (!signal.aborted && isRecord(detail) && detail.error === 'session_not_found') {
          const failure = new Error(t('This conversation is no longer available.'))
          if (turnAtRead === completedTurn) missing = failure
          throw failure
        }
      }
      return response
    }))
  }, delayMs)
  return {
    state: snapshot.state,
    refresh() { missing = undefined; return snapshot.refresh() },
    autoRefresh() { if (id && !missing) return snapshot.refresh(); return Promise.resolve() },
    reconcile(value: unknown) {
      if (!isRecord(value) || value.sessionId !== id || value.event !== 'invalidate'
        || typeof value.completedTurnId !== 'string' || !value.completedTurnId || value.completedTurnId === completedTurn) return
      completedTurn = value.completedTurnId
      missing = undefined
      return snapshot.refresh()
    },
    pause: snapshot.pause,
    dispose: snapshot.dispose,
  }
}
