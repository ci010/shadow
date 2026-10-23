import { t } from './i18n.ts'
import { computed, onUnmounted, ref, watch } from 'vue'
import { apiUrl } from './api-url.ts'
import { isRecord } from './folders-sidebar.ts'
import { parseCredentialRequest, parseCredentialRequestResult, type CredentialRequest } from '../../src/agent-authoring/credential-request-contract.ts'

export interface CredentialRequestSource {
  apiBase: string
  projectId: string
  sessionId: string
  active: boolean
  stage?: string | null
  canSubmit: boolean
}

export function privateCredentialTransport(base: string): boolean {
  if (!URL.canParse(base)) return false
  const url = new URL(base)
  return !url.username && !url.password && (url.protocol === 'https:'
    || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
}

export function parseCredentialResponse(value: unknown, projectId: string): CredentialRequest | null {
  if (!isRecord(value) || Object.keys(value).length !== 1 || !('request' in value)) {
    throw new Error(t('Invalid private credential request'))
  }
  return value.request === null ? null : parseCredentialRequest(value.request, projectId)
}

function submissionError(status: number, cancelling: boolean): string {
  if (status === 401 || status === 403) return t('Only an authorized Project owner can update this credential request.')
  if (status === 409) return t('This credential request changed or has closed. Reload it before continuing.')
  if (status === 400 || status === 413) return t('The credential was not accepted. Enter a nonempty value of at most 16,384 characters without line breaks.')
  return cancelling
    ? t('Could not confirm cancellation. Check the connection and reload this request.')
    : t('Could not confirm the credential save. Check Main and reload this request before trying again.')
}

export function useCredentialRequest(source: () => CredentialRequestSource) {
  const request = ref<CredentialRequest | null>(null)
  const secret = ref('')
  const error = ref('')
  const loading = ref(false)
  const operation = ref<'saving' | 'cancelling' | null>(null)
  const busy = computed(() => operation.value !== null)
  const enabled = computed(() => source().active && source().canSubmit
    && source().sessionId === 'web:orchestrator' && !!source().projectId && source().stage === 'tool')
  const secure = computed(() => privateCredentialTransport(source().apiBase))
  const valid = computed(() => secret.value.length > 0 && secret.value.length <= 16_384
    && !/[\u0000-\u001f\u007f]/.test(secret.value))
  let read: AbortController | undefined
  let write: AbortController | undefined
  let interval: ReturnType<typeof setInterval> | undefined
  let generation = 0
  let writeError = false

  function endpoint(id?: string): string {
    return apiUrl(source().apiBase, `/api/agent-resources/credential-requests${id ? `/${encodeURIComponent(id)}` : ''}`).toString()
  }
  function stop() {
    generation++
    read?.abort()
    write?.abort()
    read = write = undefined
    if (interval) clearInterval(interval)
    interval = undefined
    request.value = null
    secret.value = error.value = ''
    operation.value = null
    loading.value = false
    writeError = false
  }
  async function refresh(): Promise<void> {
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
      if (!response.ok) throw new Error(t('Credential request unavailable'))
      const next = parseCredentialResponse(await response.json(), source().projectId)
      if (current !== generation || controller.signal.aborted) return
      if (next?.id !== request.value?.id) {
        secret.value = ''
        writeError = false
      }
      request.value = next
      if (!writeError) error.value = ''
    } catch {
      if (current === generation && !controller.signal.aborted) {
        error.value = t('Could not load private credential entry. Check your owner access and connection, then retry.')
      }
    } finally {
      if (read === controller) { read = undefined; loading.value = false }
    }
  }
  async function mutate(cancelling: boolean): Promise<boolean> {
    const pending = request.value
    if (!enabled.value || !pending || write) return false
    if (!secure.value) {
      secret.value = ''
      error.value = t('Private credential entry requires HTTPS or a local loopback connection to Main.')
      return false
    }
    if (!cancelling && !valid.value) {
      error.value = submissionError(400, false)
      return false
    }
    read?.abort()
    read = undefined
    loading.value = false
    const current = generation
    const controller = new AbortController()
    write = controller
    operation.value = cancelling ? 'cancelling' : 'saving'
    error.value = ''
    writeError = false
    let status = 0
    try {
      const response = await fetch(endpoint(pending.id), {
        method: cancelling ? 'DELETE' : 'POST',
        ...(cancelling ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: secret.value }) }),
        cache: 'no-store', redirect: 'error',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
      })
      status = response.status
      if (!response.ok) throw new Error(t('Credential operation was not confirmed'))
      const body: unknown = await response.json()
      if (!isRecord(body) || Object.keys(body).length !== 1 || !('result' in body)) throw new Error(t('Invalid credential receipt'))
      const result = parseCredentialRequestResult(body.result)
      if (result.requestId !== pending.id || result.secretRef !== pending.secretRef
        || result.status !== (cancelling ? 'cancelled' : 'saved')) throw new Error(t('Credential receipt mismatch'))
      if (current !== generation || controller.signal.aborted) return false
      request.value = null
      return true
    } catch {
      if (current === generation && !controller.signal.aborted) {
        writeError = true
        // Never render an exception or response body from a request containing a secret.
        error.value = submissionError(status, cancelling)
      }
      return false
    } finally {
      if (current === generation) secret.value = ''
      if (write === controller) { write = undefined; operation.value = null }
    }
  }
  watch([() => source().apiBase, () => source().projectId, () => source().sessionId, enabled], () => {
    stop()
    if (!enabled.value) return
    void refresh()
    interval = setInterval(() => { void refresh() }, 1500)
  }, { immediate: true, flush: 'sync' })
  onUnmounted(stop)
  return { request, secret, error, loading, busy, operation, enabled, secure, valid, refresh,
    submit: () => mutate(false), cancel: () => mutate(true) }
}
