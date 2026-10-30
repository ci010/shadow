interface Snapshot { revision: string; body: Record<string, unknown>; bytes: number }
interface Pool { onDispose(callback: () => void): () => void }
const pools = new WeakMap<Pool, ReturnType<typeof createChatHistorySnapshots>>()

/** Memory only, bounded per authenticated app lifetime. Every read validates
 * against Main; cached history is never served on a network or access error. */
export function createChatHistorySnapshots(request: typeof fetch = fetch, maxBytes = 16 * 1024 * 1024, maxEntries = 8) {
  const entries = new Map<string, Snapshot>()
  let bytes = 0
  let disposed = false
  function remove(key: string) {
    const old = entries.get(key)
    if (old) { bytes -= old.bytes; entries.delete(key) }
  }
  return {
    async read(url: string | URL, signal: AbortSignal): Promise<Response> {
      if (disposed) throw new Error('History snapshots disposed')
      const target = new URL(url)
      const key = target.toString()
      const cached = entries.get(key)
      target.searchParams.set('snapshot', cached?.revision ?? '')
      const response = await request(target.toString(), { signal, cache: 'no-store' })
      if (signal.aborted || disposed) throw new Error('History read cancelled')
      if (!response.ok) { remove(key); return response }
      const envelope: unknown = await response.json()
      if (signal.aborted || disposed) throw new Error('History read cancelled')
      if (!envelope || typeof envelope !== 'object' || !('revision' in envelope)
        || typeof envelope.revision !== 'string' || !/^[a-f0-9]{64}$/.test(envelope.revision)) {
        remove(key)
        throw new Error('Invalid history snapshot')
      }
      if ('unchanged' in envelope && envelope.unchanged === true) {
        if (!cached || cached.revision !== envelope.revision) throw new Error('History snapshot unavailable')
        return Response.json(cached.body)
      }
      if (!('data' in envelope) || !envelope.data || typeof envelope.data !== 'object' || Array.isArray(envelope.data)) {
        remove(key)
        throw new Error('Invalid history snapshot')
      }
      const body = envelope.data as Record<string, unknown>
      const size = new TextEncoder().encode(JSON.stringify(body)).byteLength
      remove(key)
      if (size <= maxBytes && maxEntries > 0) {
        entries.set(key, { revision: envelope.revision, body, bytes: size })
        bytes += size
        while (entries.size > maxEntries || bytes > maxBytes) remove(entries.keys().next().value!)
      }
      return Response.json(body)
    },
    dispose() { disposed = true; entries.clear(); bytes = 0 },
  }
}

export function chatHistorySnapshots(pool: Pool) {
  let cache = pools.get(pool)
  if (!cache) {
    cache = createChatHistorySnapshots()
    pools.set(pool, cache)
    pool.onDispose(() => cache!.dispose())
  }
  return cache
}
