import { fileChangesPageSchema, type RecordedFileChange } from '../../src/sessions/file-change-contract.ts'
import { apiUrl } from './api-url.ts'
import { createLiveRefresh } from './live-refresh.ts'

export function emptySessionFileChanges() {
  return { changes: [] as RecordedFileChange[], total: 0, nextOffset: 0, loaded: false, loading: false, error: '' }
}
export function createSessionFileChanges(apiBase: string, sessionId: string, state: ReturnType<typeof emptySessionFileChanges>,
  options: { request?: typeof fetch; delayMs?: number } = {}) {
  let append = false
  let refresh = false
  let failedAppend = false
  const queue = createLiveRefresh({
    delayMs: options.delayMs,
    async load(signal) {
      const appending = append && !refresh && state.loaded
      append = false
      refresh = false
      failedAppend = appending
      state.loading = true
      state.error = ''
      const changes: RecordedFileChange[] = appending ? [...state.changes] : []
      const target = appending ? state.nextOffset + 30 : Math.max(30, state.nextOffset)
      let offset = appending ? state.nextOffset : 0
      let total = state.total
      do {
        const url = apiUrl(apiBase, `/api/sessions/${encodeURIComponent(sessionId)}/file-changes`)
        url.searchParams.set('offset', String(offset))
        url.searchParams.set('limit', '30')
        const response = await (options.request ?? fetch)(url, { signal, cache: 'no-store' })
        if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'Access to these file changes was denied.'
          : response.status === 404 ? 'This session is no longer available.' : `Could not load recorded writes (${response.status}). Retry.`)
        const parsed = fileChangesPageSchema.safeParse(await response.json())
        if (!parsed.success) throw new Error('Invalid recorded writes response. Retry.')
        const page = parsed.data
        if (page.offset !== offset || page.changes.length !== Math.min(30, Math.max(0, page.total - offset))
          || page.changes.some(change => change.sessionId !== sessionId) || new Set(page.changes.map(change => change.id)).size !== page.changes.length) {
          throw new Error('Invalid recorded writes response. Retry.')
        }
        changes.push(...page.changes)
        offset += page.changes.length
        total = page.total
      } while (offset < total && offset < target)
      return { changes: [...new Map(changes.map(change => [change.id, change])).values()], total, nextOffset: offset }
    },
    apply(value) { Object.assign(state, value, { loaded: true, loading: false, error: '' }) },
    onError(error) { state.loading = false; state.error = error instanceof Error ? error.message : 'Could not load recorded writes. Retry.' },
  })
  return {
    refresh() { refresh = true; state.loading = true; queue.refresh() },
    loadMore() { if (state.loading || state.nextOffset >= state.total) return; append = true; state.loading = true; queue.refresh() },
    retry() { if (state.loading) return; if (failedAppend) append = true; else refresh = true; state.loading = true; queue.refresh() },
    dispose() { queue.dispose(); state.loading = false },
  }
}
