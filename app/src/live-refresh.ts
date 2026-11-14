import { createResource } from './resources/engine.ts'

/** Callback adapter for view-specific protocols. Scheduling, abort generations,
 * timeout and coalesced follow-ups have one implementation in the resource engine. */
export function createLiveRefresh<T>(options: {
  load: (signal: AbortSignal) => Promise<T>
  apply: (value: T) => void
  onError: (error: unknown) => void
  delayMs?: number
  timeoutMs?: number
}) {
  const resource = createResource(signal => options.load(AbortSignal.any([
    signal, AbortSignal.timeout(options.timeoutMs ?? 15_000),
  ])), options.delayMs ?? 50, {
    timeoutMs: options.timeoutMs ?? 15_000,
    reconcile(value) { options.apply(value); return value },
    onError: options.onError,
  })
  return { refresh() { resource.invalidate('invalidation') }, dispose: resource.dispose }
}
