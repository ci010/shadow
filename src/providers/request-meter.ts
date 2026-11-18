import { AsyncLocalStorage } from 'node:async_hooks'

export interface ProviderAttempt {
  outcome: 'success' | 'failure' | 'cancelled'
  durationMs: number
  firstTextMs?: number
  mode?: 'stream' | 'nonstream'
}
interface Meter { attempts: ProviderAttempt[]; firstDispatchMs?: number; queueMs?: number; started: number }
const logical = new AsyncLocalStorage<Meter>()
const streaming = new AsyncLocalStorage<{ text: () => void; mode?: ProviderAttempt['mode'] }>()
export const requestMeter = () => ({ attempts: [] as ProviderAttempt[], started: performance.now(), firstDispatchMs: undefined as number | undefined, queueMs: undefined as number | undefined })
export const measureLogicalRequest = <T>(meter: Meter, request: () => T) => logical.run(meter, request)

/** Called exclusively for nonblank answer text in a validated streaming event. */
export function observeStreamText(text: string) { if (text.trim()) streaming.getStore()?.text() }

export function observeResponseMode(mode: NonNullable<ProviderAttempt['mode']>) {
  const attempt = streaming.getStore()
  if (attempt) attempt.mode = mode
}

/** Counts actual elapsed wait under the provider retry scheduler, not body prep or network time. */
export function observeRetryWait(durationMs: number) {
  const meter = logical.getStore()
  if (meter) meter.queueMs = (meter.queueMs ?? 0) + durationMs
}

export async function measureProviderAttempt<T>(request: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const meter = logical.getStore()
  if (!meter || streaming.getStore()) return request()
  const started = performance.now()
  meter.firstDispatchMs ??= started - meter.started
  let firstTextMs: number | undefined
  let outcome: ProviderAttempt['outcome'] = 'success'
  const observation: { text: () => void; mode?: ProviderAttempt['mode'] } = { text: () => { firstTextMs ??= performance.now() - started } }
  try { return await streaming.run(observation, request) }
  catch (error) { outcome = signal?.aborted ? 'cancelled' : 'failure'; throw error }
  finally { meter.attempts.push({ outcome, durationMs: performance.now() - started, firstTextMs, mode: observation.mode }) }
}
