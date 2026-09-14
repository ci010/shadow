import { computed, onUnmounted, ref, watch } from 'vue'
import { parseYieldRequest, type YieldRequest } from '../../src/sessions/yield-contract.ts'

export function parseYieldResponse(value: unknown, sessionId: string): YieldRequest | null {
  if (!value || typeof value !== 'object' || !('request' in value)) {
    throw new Error('The server returned an invalid question. Retry to load it again.')
  }
  return value.request === null ? null : parseYieldRequest(value.request, sessionId)
}

export function yieldDeadlineText(request: YieldRequest, now: number): string {
  if (!request.deadline) return 'No time limit. Waiting for a response.'
  const deadline = Date.parse(request.deadline)
  if (deadline <= now) return 'Time limit reached. Waiting for the server to confirm the default choice.'
  return `At ${new Date(deadline).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}, the server will choose the default if no response arrives.`
}

async function readResponse(response: Response): Promise<unknown> {
  const value: unknown = await response.json().catch(() => null)
  if (response.ok) return value
  const detail = value && typeof value === 'object' && 'message' in value && typeof value.message === 'string'
    ? value.message : ''
  const recovery: Record<number, string> = {
    400: 'The request was not accepted. Reload the question before trying again.',
    403: 'You do not have permission to change this question. Ask an authorized user or the parent session.',
    404: 'This question is unavailable or this server does not support yield questions. Refresh or update the server.',
    409: 'This question changed or was already resolved. Reload it before trying again.',
    503: 'The question service is unavailable. Retry when the server is ready.',
  }
  throw new Error([detail, recovery[response.status] ?? 'Could not update the question. Check the connection and retry.'].filter(Boolean).join(' '))
}

export interface YieldSource {
  apiBase: string
  sessionId: string
  active: boolean
  stage?: string | null
  canAnswer: boolean
}

export function useYieldRequest(source: () => YieldSource) {
  const request = ref<YieldRequest | null>(null)
  const selected = ref('')
  const error = ref('')
  const submitting = ref(false)
  const cancelling = ref(false)
  const busy = computed(() => submitting.value || cancelling.value)
  const loading = ref(false)
  const now = ref(Date.now())
  const answerable = computed(() => source().active && source().stage === 'waiting'
    && source().canAnswer && request.value?.recipient.kind === 'user')
  let read: AbortController | undefined
  let write: AbortController | undefined
  let interval: ReturnType<typeof setInterval> | undefined
  let generation = 0
  let answeredId: string | undefined
  let answerError = false

  function endpoint(): string {
    const { apiBase, sessionId } = source()
    return `${apiBase.replace(/\/$/, '')}/api/sessions/${encodeURIComponent(sessionId)}/yield`
  }
  function stopRequests() {
    generation++
    read?.abort()
    write?.abort()
    read = write = undefined
    loading.value = submitting.value = cancelling.value = false
    if (interval) clearInterval(interval)
    interval = undefined
  }
  async function refresh(): Promise<void> {
    const { sessionId, active, stage } = source()
    if (!active || !sessionId || stage !== 'waiting' || read || write) return
    const current = generation
    const controller = new AbortController()
    read = controller
    loading.value = true
    try {
      const response = await fetch(endpoint(), { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) })
      const next = parseYieldResponse(await readResponse(response), sessionId)
      if (current !== generation || controller.signal.aborted) return
      if (next?.id === answeredId) return
      const changed = next?.id !== request.value?.id
      if (changed) {
        selected.value = next?.defaultOption ?? ''
        answerError = false
      }
      request.value = next
      if (!answerError) error.value = ''
    } catch (cause) {
      if (current === generation && !controller.signal.aborted) {
        error.value = cause instanceof Error ? cause.message : 'Could not load the question. Check the connection and retry.'
      }
    } finally {
      if (read === controller) { read = undefined; loading.value = false }
    }
  }
  async function mutate(isCancellation: boolean): Promise<boolean> {
    const question = request.value
    if (!answerable.value || !question || write || (!isCancellation && !question.options.includes(selected.value))) return false
    read?.abort()
    read = undefined
    loading.value = false
    const current = generation
    const option = selected.value
    const controller = new AbortController()
    write = controller
    submitting.value = !isCancellation
    cancelling.value = isCancellation
    try {
      const response = await fetch(endpoint(), {
        method: isCancellation ? 'DELETE' : 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(isCancellation ? { requestId: question.id } : { requestId: question.id, option }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
      })
      const value = await readResponse(response)
      if (current !== generation || controller.signal.aborted) return false
      if (isCancellation) {
        if (!value || typeof value !== 'object' || !('cancelled' in value) || value.cancelled !== true) {
          throw new Error('The server did not confirm cancellation. Reload the question before trying again.')
        }
      } else if (!value || typeof value !== 'object' || !('answer' in value) || !value.answer || typeof value.answer !== 'object'
        || !('requestId' in value.answer) || value.answer.requestId !== question.id
        || !('option' in value.answer) || value.answer.option !== option
        || !('answeredBy' in value.answer) || value.answer.answeredBy !== 'user'
        || !('answeredAt' in value.answer) || typeof value.answer.answeredAt !== 'string'
        || !Number.isFinite(Date.parse(value.answer.answeredAt))) {
        throw new Error('The server did not confirm your answer. Reload the question before trying again.')
      }
      answeredId = question.id
      request.value = null
      selected.value = ''
      error.value = ''
      answerError = false
      return true
    } catch (cause) {
      if (current === generation && !controller.signal.aborted) {
        answerError = true
        error.value = cause instanceof Error ? cause.message : isCancellation
          ? 'Could not cancel the task. Check the connection and retry.'
          : 'Could not submit your answer. Check the connection and retry.'
      }
      return false
    } finally {
      if (write === controller) { write = undefined; submitting.value = cancelling.value = false }
    }
  }

  watch([() => source().apiBase, () => source().sessionId, () => source().active, () => source().stage === 'waiting'], () => {
    stopRequests()
    request.value = null
    selected.value = error.value = ''
    answeredId = undefined
    answerError = false
    if (!source().active || !source().sessionId || source().stage !== 'waiting') return
    now.value = Date.now()
    void refresh()
    interval = setInterval(() => { now.value = Date.now(); void refresh() }, 1500)
  }, { immediate: true, flush: 'sync' })
  watch(() => source().canAnswer, () => {
    if (!source().canAnswer && write) {
      write.abort()
      write = undefined
      submitting.value = cancelling.value = false
    }
  }, { flush: 'sync' })
  onUnmounted(stopRequests)
  return { request, selected, error, submitting, cancelling, busy, loading, now, answerable, refresh,
    submit: () => mutate(false), cancelQuestion: () => mutate(true) }
}
