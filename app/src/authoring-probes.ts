import { computed, onUnmounted, ref, watch } from 'vue'
import { apiUrl } from './api-url.ts'
import { isRecord } from './folders-sidebar.ts'
import { parseProbeRequest, parseProbeDecisionResult, type ProbeRequest } from '../../src/agent-authoring/probe-request-contract.ts'
import type { PublicationSource } from './publication-requests.ts'

export function parseProbeResponse(value: unknown, projectId: string): ProbeRequest[] {
  if (!isRecord(value) || Object.keys(value).length !== 1 || !Array.isArray(value.requests)
    || value.requests.length > 1000) throw new Error('Invalid probe requests')
  const requests = value.requests.map(item => parseProbeRequest(item, projectId))
  if (new Set(requests.map(item => item.id)).size !== requests.length) throw new Error('Duplicate probe requests')
  return requests
}

export function visibleProbeRequests(requests: ProbeRequest[], sessionId: string): ProbeRequest[] {
  return requests.filter(request => sessionId === 'web:orchestrator' || request.sourceSessionId === sessionId)
    .sort((a, b) => {
      const priority = (request: ProbeRequest) => ['pending', 'running'].includes(request.status) ? 0 : 1
      return priority(a) - priority(b) || b.createdAt.localeCompare(a.createdAt)
    })
}

export function useAuthoringProbes(source: () => PublicationSource) {
  const requests = ref<ProbeRequest[]>([])
  const selectedId = ref('')
  const request = computed(() => requests.value.find(item => item.id === selectedId.value) ?? requests.value[0] ?? null)
  const error = ref('')
  const notice = ref('')
  const loading = ref(false)
  const operation = ref<'running' | 'cancelling' | null>(null)
  const needsReload = ref(false)
  const enabled = computed(() => source().active && source().canSubmit && !!source().sessionId && !!source().projectId)
  const busy = computed(() => operation.value !== null)
  let generation = 0
  let read: AbortController | undefined
  let write: AbortController | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  const receipts = new Map<string, ProbeRequest>()

  function endpoint(id?: string) {
    return apiUrl(source().apiBase, `/api/agent-resources/probe-requests${id ? `/${encodeURIComponent(id)}` : ''}`).toString()
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
    loading.value = needsReload.value = false
    operation.value = null
    receipts.clear()
  }
  async function refresh(manual = false) {
    if (!enabled.value || read || write) return
    const current = generation
    const controller = new AbortController()
    read = controller
    loading.value = true
    try {
      const response = await fetch(endpoint(), {
        cache: 'no-store', redirect: 'error',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
      })
      if (!response.ok) throw new Error('Probe requests unavailable')
      const next = visibleProbeRequests(parseProbeResponse(await response.json(), source().projectId), source().sessionId)
      if (current !== generation || controller.signal.aborted) return
      requests.value = next.map(item => receipts.get(item.id) ?? item)
      if (!requests.value.some(item => item.id === selectedId.value)) selectedId.value = requests.value[0]?.id ?? ''
      if (manual) {
        needsReload.value = false
        if (!next.length) notice.value = 'No connection test is available. Check the change’s recorded runs before requesting another test.'
      }
      if (!needsReload.value) error.value = ''
    } catch {
      if (current === generation && !controller.signal.aborted) {
        needsReload.value = true
        error.value = 'Could not load connection tests. Check your owner access and connection, then reload.'
      }
    } finally {
      if (read === controller) { read = undefined; loading.value = false }
    }
  }
  async function decide(cancel: boolean): Promise<boolean> {
    const pending = request.value
    if (!enabled.value || !pending || write || needsReload.value || pending.status !== 'pending') return false
    if (!cancel && Date.parse(pending.expiresAt) <= Date.now()) {
      needsReload.value = true
      error.value = 'This approval expired. Reload to check for a new request.'
      return false
    }
    read?.abort()
    read = undefined
    loading.value = false
    const current = generation
    const controller = new AbortController()
    write = controller
    operation.value = cancel ? 'cancelling' : 'running'
    error.value = notice.value = ''
    let status = 0
    try {
      const response = await fetch(endpoint(pending.id), {
        method: cancel ? 'DELETE' : 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision: pending.revision }), cache: 'no-store', redirect: 'error',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60000)]),
      })
      status = response.status
      if (!response.ok) throw new Error('Probe decision not confirmed')
      const body: unknown = await response.json()
      if (!isRecord(body) || Object.keys(body).length !== 1 || !('result' in body)) throw new Error('Invalid probe receipt')
      const result = parseProbeDecisionResult(body.result)
      if (result.requestId !== pending.id || result.revision !== pending.revision
        || (cancel && result.status !== 'cancelled')) throw new Error('Probe receipt mismatch')
      if (current !== generation || controller.signal.aborted) return false
      const completed = { ...pending, status: result.status, runId: result.runId, error: result.error }
      receipts.set(pending.id, completed)
      requests.value = requests.value.map(item => item.id === pending.id ? completed : item)
      notice.value = result.status === 'completed'
        ? 'Controlled connection test completed. This is not full business acceptance and does not publish the change.'
        : result.status === 'cancelled' ? 'Connection test cancelled. Nothing was published.'
          : 'Connection test failed. Inspect the recorded run; a new test needs a new approval.'
      return true
    } catch {
      if (current === generation && !controller.signal.aborted) {
        needsReload.value = true
        error.value = status === 409
          ? 'This request changed, expired or was already used. Reload before deciding.'
          : status === 401 || status === 403 ? 'Only an authorized Project owner can approve this connection test.'
            : 'Could not confirm the test result. Reload to inspect its status and recorded run; do not repeat approval blindly.'
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
  return { requests, request, selectedId, error, notice, loading, operation, busy, enabled, needsReload,
    refresh: () => refresh(), reload: () => refresh(true), approve: () => decide(false), cancel: () => decide(true) }
}
