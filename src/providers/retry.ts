import { setTimeout as delay } from 'node:timers/promises'
import { ProviderTransportError } from './provider.ts'

/** Replay only classified failures known to precede a connection, never HTTP or uncertain POSTs. */
export async function withProviderRetry<T>(request: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const maxRetries = 5
  let lastError: unknown
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const wait = 1000 * attempt
      console.warn(`LLM fetch attempt ${attempt + 1} after ${wait}ms (${lastError instanceof Error ? lastError.message : lastError})`)
      await delay(wait, undefined, { signal })
    }
    signal?.throwIfAborted()
    try {
      return await request()
    } catch (error) {
      signal?.throwIfAborted()
      if (!(error instanceof ProviderTransportError) || error.mayHaveBeenProcessed) throw error
      lastError = error
    }
  }
  throw lastError
}
