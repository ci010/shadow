import { setTimeout as delay } from 'node:timers/promises'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHmac, randomBytes } from 'node:crypto'
import { trace } from '@opentelemetry/api'
import { spanAttributes } from '../otel/tracing.ts'
import { isImageRequestTimeout, ProviderHttpError, ProviderTransportError } from './provider.ts'

export interface RateLimitWait {
  status: 429
  delayMs: number
  attempt: number
  retryAt: number
  provider?: string
  model?: string
}
const waiting = new AsyncLocalStorage<(state: RateLimitWait | undefined) => void>()
/** Keeps waiting notifications associated with the originating turn, including routed providers. */
export function withRateLimitWaiting<T>(notify: (state: RateLimitWait | undefined) => void, request: () => Promise<T>): Promise<T> {
  return waiting.run(notify, request)
}
const salt = randomBytes(32)
const cooldowns = new Map<string, number>()
/** Opaque, process-local credential/endpoint identity; never logged or persisted. */
export function providerRetryScope(endpoint: string, credential: string): string {
  const base = endpoint.replace(/\/(?:chat\/completions|responses|messages)\/?$/, '').replace(/\/+$/, '')
  return createHmac('sha256', salt).update(base).update('\0').update(credential).digest('hex')
}
export function retryAfterMs(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value?.trim()) return undefined
  const text = value.trim()
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const ms = Number(text) * 1000
    return Number.isFinite(ms) ? ms : undefined
  }
  // Require an HTTP-date, not Date.parse's permissive numeric/local-date inputs.
  const weekday = '(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)'
  const month = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)'
  const time = '\\d{2}:\\d{2}:\\d{2}'
  const httpDate = new RegExp(`^(?:${weekday}, \\d{2} ${month} \\d{4} ${time} GMT|(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \\d{2}-${month}-\\d{2} ${time} GMT|${weekday} ${month} (?: \\d|\\d{2}) ${time} \\d{4})$`)
  if (!httpDate.test(text)) return undefined
  const date = Date.parse(text.endsWith('GMT') ? text : `${text} GMT`)
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined
}
const quotaCodes = new Set(['insufficient_quota', 'quota_exceeded', 'billing_hard_limit_reached', 'billing_not_active', 'credit_balance_too_low', 'usage_limit_reached'])
export interface ProviderRetryOptions {
  scope?: string
  provider?: string
  model?: string
  /** Deterministic clock/wait hooks for local tests, not a configurable production retry policy. */
  clock?: () => number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  random?: () => number
}
const MAX_RETRIES = 5
const MAX_WAIT_MS = 120_000
const TRANSPORT_BASE_MS = 500
const TRANSPORT_MAX_MS = 8_000
/** Exponential pre-connection backoff (0.5s, 1s, 2s, 4s, 8s) with bounded jitter.
 * Capped well below the 429 curve: this wait is not shown to the user, so the
 * whole schedule must stay near one short visible stall. */
export function transportBackoffMs(attempt: number, random: () => number = Math.random): number {
  return Math.round(Math.min(TRANSPORT_MAX_MS, TRANSPORT_BASE_MS * 2 ** attempt) * (0.75 + random() * 0.5))
}
/** Bounded replay of preconnection failures, rejected 429s and large Copilot image 408s. */
export async function withProviderRetry<T>(request: () => Promise<T>, signal?: AbortSignal, options: ProviderRetryOptions = {}): Promise<T> {
  const now = options.clock ?? Date.now
  const sleep = options.sleep ?? ((ms, signal) => delay(ms, undefined, { signal }))
  const started = now()
  let httpAttempts = 0
  let timeoutAttempts = 0
  let timeoutRetries = 0
  const timeoutStats = (exhausted = false, success = false) => spanAttributes({
    'llm.request.http_attempts': httpAttempts,
    'llm.request.timeout_attempts': timeoutAttempts,
    'llm.request.timeout_retries': timeoutRetries,
    'llm.request.timeout_retry_exhausted': Number(exhausted),
    'llm.request.timeout_success': Number(timeoutAttempts > 0 && success),
  })
  let totalWait = 0
  let lastError: unknown
  const wait = async (ms: number, attempt: number, rateLimit: boolean) => {
    if (ms > MAX_WAIT_MS - totalWait || now() - started + ms > MAX_WAIT_MS) throw lastError ?? new ProviderHttpError(429, 'Provider cooldown exceeds automatic waiting limit')
    if (ms <= 0) return
    totalWait += ms
    const state: RateLimitWait = { status: 429, delayMs: ms, attempt, retryAt: now() + ms,
      ...(options.provider ? { provider: options.provider } : {}), ...(options.model ? { model: options.model } : {}) }
    if (rateLimit) {
      // Deliberately excludes errors, response bodies, URLs and credentials.
      console.info('[provider.rate-limit.wait]', state)
      waiting.getStore()?.(state)
    }
    try { await sleep(ms, signal); signal?.throwIfAborted() }
    catch (error) { signal?.throwIfAborted(); throw error }
    finally { if (rateLimit) waiting.getStore()?.(undefined) }
  }
  let attempt = 0
  for (let httpAttempt = 0; httpAttempt < MAX_RETRIES + 3; httpAttempt++) {
    signal?.throwIfAborted()
    // Expired entries are removed on every request, bounding inactive credential retention.
    for (const [key, until] of cooldowns) if (until <= now()) cooldowns.delete(key)
    while (options.scope && (cooldowns.get(options.scope) ?? 0) > now()) {
      await wait(cooldowns.get(options.scope)! - now(), attempt + 1, true)
    }
    const requestStarted = now()
    try {
      httpAttempts++
      spanAttributes({ 'llm.request.http_attempts': httpAttempts })
      const result = await request()
      timeoutStats(false, true)
      if (timeoutAttempts > 0) trace.getActiveSpan()?.addEvent('llm.request.image_timeout_recovered', {
        http_attempts: httpAttempts, attempts: timeoutAttempts, retries: timeoutRetries,
        duration_ms: Math.max(0, now() - requestStarted),
      })
      return result
    }
    catch (error) {
      signal?.throwIfAborted()
      lastError = error
      if (isImageRequestTimeout(error)) {
        timeoutAttempts++
        error.timeoutAttempts = timeoutAttempts
        const exhausted = timeoutAttempts >= 3 || httpAttempt === MAX_RETRIES + 2
        error.timeoutRetryExhausted = exhausted
        timeoutStats(exhausted)
        const stats = error.requestStats!
        const attributes = {
          http_attempts: httpAttempts, attempts: timeoutAttempts, retries: timeoutRetries,
          duration_ms: Math.max(0, now() - requestStarted),
          body_bytes: stats.bodyBytes, wire_body_bytes: stats.wireBodyBytes,
          image_count: stats.imageCount, image_base64_bytes: stats.imageBase64Bytes,
        }
        trace.getActiveSpan()?.addEvent('llm.request.image_timeout', attributes)
        if (exhausted) throw error
        const backoff = Math.round(1000 * timeoutAttempts * (0.75 + (options.random ?? Math.random)() * 0.5))
        timeoutRetries++
        timeoutStats()
        trace.getActiveSpan()?.addEvent('llm.request.image_timeout_retry', { ...attributes, retries: timeoutRetries, delay_ms: backoff })
        // Independent, two-wait budget: real 408s may each take over a minute.
        // Do not relax the existing 429/preconnection elapsed-time limit.
        await sleep(backoff, signal)
        signal?.throwIfAborted()
        continue
      }
      const rateLimit = error instanceof ProviderHttpError && error.status === 429
        && error.rejectedRequest === true && !quotaCodes.has(error.code?.toLowerCase() ?? '')
      const transport = error instanceof ProviderTransportError && !error.mayHaveBeenProcessed
      if (!rateLimit && (!transport || attempt === MAX_RETRIES)) throw error
      if (!rateLimit) {
        const backoff = transportBackoffMs(attempt, options.random ?? Math.random)
        console.warn(`LLM fetch attempt ${attempt + 2} after ${backoff}ms (preconnection failure)`)
        await wait(backoff, attempt + 2, false)
        attempt++
        continue
      }
      const ms = retryAfterMs(error.retryAfter, now())
        ?? Math.round(Math.min(30_000, 2000 * 2 ** attempt) * (0.75 + (options.random ?? Math.random)() * 0.5))
      if (options.scope) {
        // Bound the registry as well as each cooldown. No secrets or request content stored.
        if (cooldowns.size >= 1024 && !cooldowns.has(options.scope)) cooldowns.delete(cooldowns.keys().next().value!)
        cooldowns.set(options.scope, Math.max(cooldowns.get(options.scope) ?? 0, now() + ms))
      }
      if (attempt === MAX_RETRIES || ms > MAX_WAIT_MS - totalWait || now() - started + ms > MAX_WAIT_MS) throw error
      if (!options.scope) await wait(ms, attempt + 2, true)
      attempt++
    }
  }
  throw lastError
}
