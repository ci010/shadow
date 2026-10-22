import { t } from './i18n.ts'
import { reactive } from 'vue'
import { apiUrl } from './api-url.ts'

export type ChatRequestPhase = 'preparing' | 'submitting' | 'active' | 'finished'

/** Keep cancellation independent of the selected conversation and its SSE reader. */
export function createChatRequestControl(
  apiBase: string,
  abortPreparation: () => void,
  request: typeof fetch = fetch,
  sessionId = '',
  activeRequestId?: string,
) {
  const state = reactive({
    phase: (sessionId ? 'active' : 'preparing') as ChatRequestPhase,
    sessionId,
    requestId: activeRequestId,
    stopping: false,
    error: '',
  })
  let cancellation: Promise<void> | undefined

  function finish(): void {
    state.phase = 'finished'
    state.stopping = false
    state.error = ''
  }

  async function cancelActive(): Promise<void> {
    if (cancellation || state.phase === 'finished') return cancellation
    const requestId = state.requestId
    if (!requestId) {
      state.stopping = false
      state.error = t('Current request identity is unavailable. Refresh activity and retry Stop request. No cancellation was sent.')
      return
    }
    state.stopping = true
    state.error = ''
    const target = state.sessionId
    cancellation = (async () => {
      try {
        const response = await request(apiUrl(apiBase, `/api/sessions/${encodeURIComponent(target)}/cancel`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestId }),
          signal: AbortSignal.timeout(15000),
        })
        const result: unknown = await response.json().catch(() => null)
        if (!response.ok || !result || typeof result !== 'object'
          || !('sessionId' in result) || result.sessionId !== target
          || !('status' in result) || (result.status !== 'requested' && result.status !== 'idle')) {
          throw new Error(t('Could not stop the request ({status}). It may still be running. Retry Stop request.', { status: response.status }))
        }
        // An abort acknowledgement is not completion: tools may still be unwinding.
        if (result.status === 'idle') finish()
      } catch (cause) {
        if (state.phase !== 'finished') {
          state.stopping = false
          state.error = cause instanceof Error
            ? cause.message : t('Could not stop the request. It may still be running. Retry Stop request.')
        }
      } finally {
        cancellation = undefined
      }
    })()
    return cancellation
  }

  return {
    state,
    finish,
    submitting(id: string): void {
      state.sessionId = id
      state.phase = 'submitting'
    },
    admitted(id?: string): void {
      if (state.phase === 'finished') return
      state.requestId = id
      state.phase = 'active'
      if (state.stopping) void cancelActive()
    },
    stop(): Promise<void> {
      if (state.phase === 'finished' || state.stopping) return Promise.resolve()
      state.error = ''
      if (state.phase === 'preparing') {
        abortPreparation()
        finish()
        return Promise.resolve()
      }
      if (state.phase === 'submitting') {
        // The POST may already be admitted. Wait for its response before asking
        // Main to abort; cancelling the HTTP reader would only hide the work.
        state.stopping = true
        return Promise.resolve()
      }
      return cancelActive()
    },
  }
}

export type ChatRequestControl = ReturnType<typeof createChatRequestControl>

/** Explicit continuation has no prompt/media fallback and cannot replay a draft. */
export async function resumeChatRequest(
  apiBase: string, sessionId: string, recoveryId: string, control: ChatRequestControl, request: typeof fetch = fetch,
  acknowledgeToolReplay = false,
): Promise<void> {
  control.submitting(sessionId)
  let rejected = false
  try {
    const response = await request(apiUrl(apiBase, `/api/sessions/${encodeURIComponent(sessionId)}/resume`), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recoveryId, ...(acknowledgeToolReplay ? { acknowledgeToolReplay: true } : {}) }),
      signal: AbortSignal.timeout(15000),
    })
    rejected = !response.ok
    const result: unknown = await response.json()
    if (!response.ok || !result || typeof result !== 'object'
      || !('sessionId' in result) || result.sessionId !== sessionId
      || !('recoveryId' in result) || result.recoveryId !== recoveryId
      || !('requestId' in result) || typeof result.requestId !== 'string' || !result.requestId
      || !('status' in result) || result.status !== 'accepted') {
      throw new Error(t('Could not continue this conversation ({status}). Refresh its status before trying again.', { status: response.status }))
    }
    control.admitted(result.requestId)
  } catch (error) {
    if (rejected) control.finish()
    else control.admitted()
    throw error
  }
}
