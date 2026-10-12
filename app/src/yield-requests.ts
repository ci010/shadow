import { t, formatDateTime } from './i18n.ts'
import { computed, onUnmounted, ref, watch } from 'vue'
import { apiUrl } from './api-url.ts'
import { parseYieldRequest, parseYieldCustomText, MAX_YIELD_CUSTOM_TEXT_LENGTH, type YieldRequest } from '../../src/sessions/yield-contract.ts'
import { parseInputRequest, type InputRequest } from '../../src/sessions/input-request.ts'
import { answerMediaSchema, MAX_ANSWER_ATTACHMENTS } from '../../src/sessions/answer-media.ts'
export { MAX_YIELD_CUSTOM_TEXT_LENGTH }
export type AskRequest = YieldRequest | InputRequest
export function isInputRequest(request: AskRequest): request is InputRequest { return 'kind' in request && request.kind === 'input' }

export function parseYieldResponse(value: unknown, sessionId: string): AskRequest | null {
  if (!value || typeof value !== 'object' || !('request' in value)) {
    throw new Error(t('The server returned an invalid question. Retry to load it again.'))
  }
  if (value.request === null) return null
  return value.request && typeof value.request === 'object' && 'kind' in value.request && value.request.kind === 'input'
    ? parseInputRequest(value.request, sessionId) : parseYieldRequest(value.request, sessionId)
}

export function yieldDeadlineText(request: AskRequest, now: number): string {
  if (isInputRequest(request)) return request.deadline
    ? t('Input expires at {value1}; no answer is chosen automatically.', { value1: formatDateTime(new Date(request.deadline), { hour: 'numeric', minute: '2-digit', second: '2-digit' }) })
    : ''
  if (request.timeoutPaused) return t('Automatic default paused because you requested an explanation or revision. An explicit answer is required.')
  if (!request.deadline) return t('No time limit. Waiting for a response.')
  const deadline = Date.parse(request.deadline)
  if (deadline <= now) return t('Time limit reached. Waiting for the server to confirm the default choice.')
  return t('At {value1}, the server will choose the default if no response arrives.', { value1: formatDateTime(new Date(deadline), { hour: '2-digit', minute: '2-digit', second: '2-digit' }) })
}

async function readResponse(response: Response): Promise<unknown> {
  const value: unknown = await response.json().catch(() => null)
  if (response.ok) return value
  const detail = value && typeof value === 'object' && 'message' in value && typeof value.message === 'string'
    ? value.message : ''
  const recovery: Record<number, string> = {
    400: t('The request was not accepted. Reload the question before trying again.'),
    403: t('You do not have permission to change this question. Ask an authorized user or the parent session.'),
    404: t('This question is unavailable or this server does not support yield questions. Refresh or update the server.'),
    409: t('This question changed or was already resolved. Reload it before trying again.'),
    503: t('The question service is unavailable. Retry when the server is ready.'),
  }
  throw new Error([detail, recovery[response.status] ?? t('Could not update the question. Check the connection and retry.')].filter(Boolean).join(' '))
}

export interface YieldSource {
  expectedRequestId?: string
  apiBase: string
  sessionId: string
  active: boolean
  stage?: string | null
  canAnswer: boolean
}

export function useYieldRequest(source: () => YieldSource) {
  const request = ref<AskRequest | null>(null)
  const selected = ref('')
  const customMode = ref(false)
  const customText = ref('')
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
  let draftRequestId: string | undefined
  let answeredId: string | undefined
  let answerError = false

  function endpoint(): string {
    const { apiBase, sessionId } = source()
    return apiUrl(apiBase, `/api/sessions/${encodeURIComponent(sessionId)}/ask`).toString()
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
      const received = parseYieldResponse(await readResponse(response), sessionId)
      const next = source().expectedRequestId && received?.id !== source().expectedRequestId ? null : received
      if (current !== generation || controller.signal.aborted) return
      if (next && next.id === answeredId) return
      const changed = next?.id !== draftRequestId
      if (changed) {
        selected.value = next && !isInputRequest(next) ? next.defaultOption : ''
        customMode.value = !!next && isInputRequest(next)
        customText.value = ''
        answerError = false
      }
      draftRequestId = next?.id
      request.value = next
      if (!answerError) error.value = ''
    } catch (cause) {
      if (current === generation && !controller.signal.aborted) {
        error.value = cause instanceof Error ? cause.message : t('Could not load the question. Check the connection and retry.')
      }
    } finally {
      if (read === controller) { read = undefined; loading.value = false }
    }
  }
  async function mutate(isCancellation: boolean, media?: string[]): Promise<boolean> {
    const question = request.value
    if (!answerable.value || !question || write) return false
    const input = isInputRequest(question)
    const custom = !isCancellation && (input || customMode.value)
    let option = selected.value
    if (!isCancellation) {
      if (custom) {
        try { option = parseYieldCustomText(customText.value) }
        catch (cause) {
          if (!(cause instanceof TypeError)) throw cause
          error.value = cause.message
          return false
        }
      } else if (input || !question.options.includes(option)) {
        error.value = t('Choose an offered option or write your own response.')
        return false
      }
    }
    read?.abort()
    read = undefined
    loading.value = false
    const current = generation
    const controller = new AbortController()
    write = controller
    submitting.value = !isCancellation
    cancelling.value = isCancellation
    try {
      const response = await fetch(endpoint(), {
        method: isCancellation ? 'DELETE' : 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(isCancellation ? { requestId: question.id }
          : { requestId: question.id, ...(input ? { text: option } : custom ? { customText: option } : { option }),
            ...(media?.length ? { media } : {}) }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
      })
      const value = await readResponse(response)
      if (current !== generation || controller.signal.aborted) return false
      if (isCancellation) {
        if (!value || typeof value !== 'object' || !('cancelled' in value) || value.cancelled !== true) {
          throw new Error(t('The server did not confirm cancellation. Reload the question before trying again.'))
        }
      } else if (!value || typeof value !== 'object' || !('answer' in value) || !value.answer || typeof value.answer !== 'object'
        || !('requestId' in value.answer) || value.answer.requestId !== question.id
        || (input ? !('text' in value.answer) || value.answer.text !== option : !('option' in value.answer) || value.answer.option !== option)
        || (!input && custom && (!('custom' in value.answer) || value.answer.custom !== true))
        || (media?.length && (!('media' in value.answer) || JSON.stringify(value.answer.media) !== JSON.stringify(media)))
        || !('answeredBy' in value.answer) || value.answer.answeredBy !== 'user'
        || !('answeredAt' in value.answer) || typeof value.answer.answeredAt !== 'string'
        || !Number.isFinite(Date.parse(value.answer.answeredAt))) {
        throw new Error(t('The server did not confirm your answer. Reload the question before trying again.'))
      }
      answeredId = question.id
      draftRequestId = undefined
      request.value = null
      selected.value = ''
      customMode.value = false
      customText.value = ''
      error.value = ''
      answerError = false
      return true
    } catch (cause) {
      if (current === generation && !controller.signal.aborted) {
        answerError = true
        error.value = cause instanceof Error ? cause.message : isCancellation
          ? t('Could not cancel the task. Check the connection and retry.')
          : t('Could not submit your answer. Check the connection and retry.')
      }
      return false
    } finally {
      if (write === controller) { write = undefined; submitting.value = cancelling.value = false }
    }
  }

  watch([() => source().apiBase, () => source().sessionId, () => source().active, () => source().stage === 'waiting', () => source().expectedRequestId], ([apiBase, sessionId, active, waiting, expectedId], previous) => {
    const preserveDraft = waiting && previous?.[3] && apiBase === previous?.[0]
      && sessionId === previous?.[1] && expectedId === previous?.[4]
    stopRequests()
    request.value = null
    if (!preserveDraft) {
      selected.value = error.value = ''
      customMode.value = false
      customText.value = ''
      draftRequestId = answeredId = undefined
      answerError = false
    }
    if (!active || !sessionId || !waiting) return
    now.value = Date.now()
    void refresh()
    interval = setInterval(() => { now.value = Date.now(); void refresh() }, 1500)
  }, { immediate: true, flush: 'sync' })
  watch(() => source().canAnswer, () => {
    if (!source().canAnswer) {
      customMode.value = false
      customText.value = ''
    }
    if (!source().canAnswer && write) {
      write.abort()
      write = undefined
      submitting.value = cancelling.value = false
    }
  }, { flush: 'sync' })
  onUnmounted(stopRequests)
  return { request, selected, customMode, customText, error, submitting, cancelling, busy, loading, now, answerable, refresh,
    submit: () => mutate(false), cancelQuestion: () => mutate(true),
    submitCustom: (requestId: string, text: string, media: string[] = []) => {
      if (!answerable.value || busy.value || request.value?.id !== requestId) {
        error.value = t('This question changed or is unavailable. Reload it before sending your answer.')
        return Promise.resolve(false)
      }
      if (media.length && !answerMediaSchema.safeParse(media).success) {
        error.value = t('Attach up to {MAX_ANSWER_ATTACHMENTS} files, then retry your answer.', { MAX_ANSWER_ATTACHMENTS: MAX_ANSWER_ATTACHMENTS })
        return Promise.resolve(false)
      }
      customMode.value = true
      customText.value = text
      return mutate(false, media)
    },
    choose: (option: string) => {
      if (!answerable.value || busy.value || !request.value || isInputRequest(request.value) || !request.value.options.includes(option)) return Promise.resolve(false)
      customMode.value = false
      selected.value = option
      return mutate(false)
    } }
}
