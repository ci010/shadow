import { t } from './i18n.ts'
import { computed, onUnmounted, ref, watch } from 'vue'
import { apiUrl } from './api-url.ts'
import { isRecord } from './folders-sidebar.ts'
import { parsePublicationRequest, parsePublicationResult, type PublicationRequest } from '../../src/agent-authoring/publication-contract.ts'

export interface PublicationSource {
  apiBase: string
  projectId: string
  sessionId: string
  active: boolean
  canSubmit: boolean
  stage?: string | null
}

export function parsePublicationResponse(value: unknown, projectId: string): PublicationRequest | null {
  return parsePublicationRequests(value, projectId)[0] ?? null
}

export function parsePublicationRequests(value: unknown, projectId: string): PublicationRequest[] {
  if (!isRecord(value) || Object.keys(value).some(key => !['request', 'requests'].includes(key)) || !('request' in value)) {
    throw new Error(t('Invalid publication request'))
  }
  const legacy = value.request === null ? null : parsePublicationRequest(value.request, projectId)
  if (!('requests' in value)) return legacy ? [legacy] : []
  if (!Array.isArray(value.requests) || value.requests.length > 1000) throw new Error(t('Invalid publication requests'))
  const requests = value.requests.map(item => parsePublicationRequest(item, projectId))
  if (new Set(requests.map(item => item.id)).size !== requests.length
    || JSON.stringify(legacy) !== JSON.stringify(requests[0] ?? null)) throw new Error(t('Publication review mismatch'))
  return requests
}

export function visiblePublicationRequests(requests: PublicationRequest[], sessionId: string): PublicationRequest[] {
  return requests.filter(request => sessionId === 'web:orchestrator' || request.change?.sourceSessionId === sessionId)
}

export function usePublicationRequest(source: () => PublicationSource) {
  const requests = ref<PublicationRequest[]>([])
  const selectedId = ref('')
  const request = computed(() => requests.value.find(item => item.id === selectedId.value) ?? requests.value[0] ?? null)
  const error = ref('')
  const notice = ref('')
  const loading = ref(false)
  const operation = ref<'publishing' | 'cancelling' | null>(null)
  const needsReload = ref(false)
  const enabled = computed(() => source().active && source().canSubmit
    && !!source().sessionId && !!source().projectId)
  const busy = computed(() => operation.value !== null)
  let read: AbortController | undefined
  let write: AbortController | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let generation = 0
  const resolvedIds = new Set<string>()
  const waitingIds = new Set<string>()

  function endpoint(id?: string) {
    return apiUrl(source().apiBase, `/api/agent-resources/publication-requests${id ? `/${encodeURIComponent(id)}` : ''}`).toString()
  }
  function stop() {
    generation++
    read?.abort()
    write?.abort()
    read = write = undefined
    if (timer) clearInterval(timer)
    timer = undefined
    requests.value = []
    selectedId.value = ''
    error.value = notice.value = ''
    operation.value = null
    loading.value = needsReload.value = false
    resolvedIds.clear()
    waitingIds.clear()
  }
  async function refresh(manual = false) {
    if (!enabled.value || write || read) return
    const current = generation
    const controller = new AbortController()
    read = controller
    loading.value = true
    try {
      const response = await fetch(endpoint(), {
        cache: 'no-store', redirect: 'error',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
      })
      if (!response.ok) throw new Error(t('Publication review unavailable'))
      const next = visiblePublicationRequests(parsePublicationRequests(await response.json(), source().projectId), source().sessionId)
        .filter(item => !resolvedIds.has(item.id))
        .map(item => waitingIds.has(item.id) && !item.status ? { ...item, status: 'waiting' as const } : item)
      if (current !== generation || controller.signal.aborted) return
      requests.value = next
      if (!next.some(item => item.id === selectedId.value)) selectedId.value = next[0]?.id ?? ''
      if (manual) {
        needsReload.value = false
        if (!next.length) notice.value = t('No publication is pending. If the previous result was uncertain, inspect the published revision before requesting another review.')
      }
      if (!needsReload.value) error.value = ''
    } catch {
      if (current === generation && !controller.signal.aborted) {
        needsReload.value = true
        error.value = t('Could not load the publication review. Check your owner access and connection, then reload.')
      }
    } finally {
      if (read === controller) { read = undefined; loading.value = false }
    }
  }
  async function decide(cancel: boolean): Promise<boolean> {
    const pending = request.value
    if (!enabled.value || !pending || write || needsReload.value || (!cancel && !!pending.status)) return false
    read?.abort()
    read = undefined
    loading.value = false
    const current = generation
    const controller = new AbortController()
    write = controller
    operation.value = cancel ? 'cancelling' : 'publishing'
    error.value = notice.value = ''
    let status = 0
    try {
      const response = await fetch(endpoint(pending.id), {
        method: cancel ? 'DELETE' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision: pending.revision, baseRevision: pending.baseRevision }),
        cache: 'no-store', redirect: 'error',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]),
      })
      status = response.status
      if (!response.ok) throw new Error(t('Publication decision was not confirmed'))
      const body: unknown = await response.json()
      if (!isRecord(body) || Object.keys(body).length !== 1 || !('result' in body)) throw new Error(t('Invalid publication receipt'))
      const result = parsePublicationResult(body.result)
      if (result.requestId !== pending.id || result.revision !== pending.revision
        || (cancel ? result.status !== 'cancelled' : !['published', 'waiting'].includes(result.status))) throw new Error(t('Publication receipt mismatch'))
      if (current !== generation || controller.signal.aborted) return false
      if (result.status === 'waiting') {
        waitingIds.add(pending.id)
        requests.value = requests.value.map(item => item.id === pending.id ? { ...item, status: 'waiting' } : item)
        notice.value = t('Approval recorded. Publication is waiting for active conversations to finish; do not approve again.')
        return true
      }
      resolvedIds.add(pending.id)
      requests.value = requests.value.filter(item => item.id !== pending.id)
      notice.value = cancel ? t('Publication cancelled. Your draft is unchanged.')
        : t('Agent configuration published. Configured conversations use it on their next turn.')
      return true
    } catch {
      if (current === generation && !controller.signal.aborted) {
        needsReload.value = true
        error.value = status === 409
          ? t('This review changed or was already resolved. Reload and review the current proposal before deciding.')
          : status === 401 || status === 403
            ? t('Only an authorized Project owner can decide this publication.')
            : t('Could not confirm the result. Reload before trying again; if no request remains, inspect the published revision.')
      }
      return false
    } finally {
      if (write === controller) { write = undefined; operation.value = null }
    }
  }
  watch([() => source().apiBase, () => source().projectId, () => source().sessionId, enabled], () => {
    stop()
    if (!enabled.value) return
    void refresh()
    timer = setInterval(() => { void refresh() }, 3000)
  }, { immediate: true, flush: 'sync' })
  watch(() => source().stage, () => { void refresh() })
  onUnmounted(stop)
  return { request, requests, selectedId, error, notice, loading, operation, busy, enabled, needsReload,
    reload: () => refresh(true), refresh: () => refresh(), confirm: () => decide(false), cancel: () => decide(true) }
}
