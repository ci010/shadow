import { ProviderHttpError, TokenLimitExceededError } from './provider.ts'

// Arbitrary upstream strings can contain credentials, even when alphanumeric.
const safeCodes = new Set([
  'quota_exceeded', 'billing_hard_limit_reached', 'billing_not_active', 'credit_balance_too_low', 'usage_limit_reached',
  'unsupported_api_for_model', 'unsupported_reasoning_effort',
  'invalid_api_key', 'authentication_error', 'unauthorized', 'permission_denied',
  'permission_error', 'forbidden', 'access_denied', 'insufficient_scope',
  'model_not_found', 'model_not_supported', 'unsupported_model', 'invalid_request_error',
  'insufficient_quota', 'rate_limit_exceeded', 'rate_limit_error', 'overloaded_error',
  'max_output_tokens', 'content_filter',
  'server_error', 'api_error', 'billing_error', 'content_policy_violation',
  'model_max_prompt_tokens_exceeded', 'context_length_exceeded', 'context_window_exceeded',
  'max_prompt_tokens_exceeded', 'input_token_limit_exceeded',
])
const contextCodes = new Set(['model_max_prompt_tokens_exceeded', 'context_length_exceeded',
  'context_window_exceeded', 'max_prompt_tokens_exceeded', 'input_token_limit_exceeded'])

export function safeProviderCode(value: unknown): string | undefined {
  return typeof value === 'string' && safeCodes.has(value) ? value : undefined
}

function safeIdentifier(value: string): string {
  return value.length <= 120 && /^[a-zA-Z0-9][a-zA-Z0-9_.\-/]*$/.test(value)
    && !/(?:sk-|gh[pousr]_|github_pat_)/i.test(value) ? value : '[omitted]'
}

export function providerRequestId(headers: Headers): string | undefined {
  for (const header of ['x-request-id', 'request-id', 'x-github-request-id', 'x-amzn-requestid']) {
    const value = headers.get(header)
    // UUIDs and vendor hex request IDs only, never arbitrary header text.
    if (value && value.length <= 100 && /^(?:req[_-])?[a-fA-F0-9][a-fA-F0-9:-]{7,99}$/.test(value)) return value
  }
  return undefined
}

/** Read at most 16 KiB for structured code extraction; never retain/log a body.
 * Logs use the existing backend console sink, not the public session/UI error.
 */
export async function httpFailure(response: Response, provider: string, model: string,
  signal?: AbortSignal): Promise<ProviderHttpError | TokenLimitExceededError> {
  let code: string | undefined
  const reader = response.body?.getReader()
  if (reader) {
    try {
      const buffers: Uint8Array[] = []
      let size = 0
      while (size <= 16_384) {
        const part = await reader.read()
        if (part.done) break
        size += part.value.byteLength
        if (size > 16_384) break
        buffers.push(part.value)
      }
      if (size <= 16_384) {
        const bytes = new Uint8Array(size)
        let offset = 0
        for (const buffer of buffers) { bytes.set(buffer, offset); offset += buffer.length }
        const payload = JSON.parse(new TextDecoder().decode(bytes))
        code = safeProviderCode(payload?.error?.code) ?? safeProviderCode(payload?.error?.type)
          ?? safeProviderCode(payload?.code) ?? safeProviderCode(payload?.type)
      }
    } catch { signal?.throwIfAborted() } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }
  signal?.throwIfAborted()
  const requestId = providerRequestId(response.headers)
  console.warn('[provider.http.failure]', JSON.stringify({
    provider: safeIdentifier(provider), model: safeIdentifier(model), status: response.status,
    code: code ?? 'unrecognized', ...(requestId ? { requestId } : {}),
  }))
  const message = `Provider rejected request (HTTP ${response.status})`
  if (code && contextCodes.has(code)) return new TokenLimitExceededError(message)
  return new ProviderHttpError(response.status, message, code, {
    retryAfter: response.headers.get('retry-after'), rejectedRequest: true,
  })
}
