import { setTimeout as delay } from 'node:timers/promises'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHmac, randomBytes } from 'node:crypto'
import { ProviderHttpError, ProviderTransportError } from './provider.ts'

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
/** Only preconnection transport failures or definitively rejected HTTP 429s are replayable. */
export async function withProviderRetry<T>(request: () => Promise<T>, signal?: AbortSignal, options: ProviderRetryOptions = {}): Promise<T> {
  const now = options.clock ?? Date.now
  const sleep = options.sleep ?? ((ms, signal) => delay(ms, undefined, { signal }))
  const started = now()
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
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    signal?.throwIfAborted()
    // Expired entries are removed on every request, bounding inactive credential retention.
    for (const [key, until] of cooldowns) if (until <= now()) cooldowns.delete(key)
    while (options.scope && (cooldowns.get(options.scope) ?? 0) > now()) {
      await wait(cooldowns.get(options.scope)! - now(), attempt + 1, true)
    }
    try { return await request() }
    catch (error) {
      signal?.throwIfAborted()
      lastError = error
      const rateLimit = error instanceof ProviderHttpError && error.status === 429
        && error.rejectedRequest === true && !quotaCodes.has(error.code?.toLowerCase() ?? '')
      const transport = error instanceof ProviderTransportError && !error.mayHaveBeenProcessed
      if (!rateLimit && (!transport || attempt === MAX_RETRIES)) throw error
      if (!rateLimit) {
        console.warn(`LLM fetch attempt ${attempt + 2} after ${1000 * (attempt + 1)}ms (preconnection failure)`)
        await wait(1000 * (attempt + 1), attempt + 2, false)
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
    }
  }
  throw lastError
}
