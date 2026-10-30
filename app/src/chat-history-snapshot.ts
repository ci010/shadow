interface Snapshot { revision: string; historyRevision?: string; body: Record<string, unknown>; bytes: number }
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
      target.searchParams.delete('historyCount')
      target.searchParams.delete('historyRevision')
      if (cached?.historyRevision) target.searchParams.set('historyRevision', cached.historyRevision)
      if (cached && Array.isArray(cached.body.history)) target.searchParams.set('historyCount', String(cached.body.history.length))
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
        if (!cached || cached.revision !== envelope.revision || 'delta' in envelope || 'data' in envelope) {
          remove(key)
          throw new Error('History snapshot unavailable')
        }
        return Response.json(cached.body)
      }
      const historyRevision = 'historyRevision' in envelope ? envelope.historyRevision : undefined
      if (historyRevision !== undefined && (typeof historyRevision !== 'string' || !/^[a-f0-9]{64}$/.test(historyRevision))) {
        remove(key)
        throw new Error('Invalid history revision')
      }
      let body: Record<string, unknown>
      if ('delta' in envelope) {
        const delta = envelope.delta
        const metadata = delta && typeof delta === 'object' && 'metadata' in delta ? delta.metadata : undefined
        const leading = delta && typeof delta === 'object' && 'leadingHistory' in delta ? delta.leadingHistory : []
        const historyOnly = metadata !== undefined || (delta && typeof delta === 'object' && 'baseHistoryRevision' in delta)
        if (!cached || !Array.isArray(cached.body.history) || !delta || typeof delta !== 'object'
          || !('baseRevision' in delta) || delta.baseRevision !== cached.revision
          || !('baseCount' in delta) || delta.baseCount !== cached.body.history.length
          || !('history' in delta) || !Array.isArray(delta.history) || (!historyOnly && delta.history.length === 0)
          || !delta.history.every(message => message && typeof message === 'object' && !Array.isArray(message)
            && typeof message.role === 'string')
          || !('count' in delta) || !Number.isSafeInteger(delta.count)
          || delta.count !== cached.body.history.length + delta.history.length + (Array.isArray(leading) ? leading.length : 0)
          || (!historyOnly && ('leadingHistory' in delta || 'historyOffset' in delta))
          || (historyOnly && (!historyRevision || !cached.historyRevision
            || !Array.isArray(leading) || leading.length > 16
            || !leading.every(message => message && typeof message === 'object' && !Array.isArray(message) && typeof message.role === 'string')
            || !('historyOffset' in delta) || delta.historyOffset !== leading.length
            || !('baseHistoryRevision' in delta) || delta.baseHistoryRevision !== cached.historyRevision
            || !metadata || typeof metadata !== 'object' || Array.isArray(metadata)
            || 'history' in metadata
            || !('systemPrompt' in metadata) || typeof metadata.systemPrompt !== 'string'
            || !('tools' in metadata) || !Array.isArray(metadata.tools)
            || !('commandResults' in metadata) || !Array.isArray(metadata.commandResults)
            || !('decisionRecords' in metadata) || !Array.isArray(metadata.decisionRecords)
            || !('previousPhysicalId' in metadata)
            || (metadata.previousPhysicalId !== null && typeof metadata.previousPhysicalId !== 'string')
            || !('chatId' in metadata) || metadata.chatId !== cached.body.chatId
            || !('currentPhysicalId' in metadata) || typeof metadata.currentPhysicalId !== 'string'
            || metadata.currentPhysicalId !== cached.body.currentPhysicalId
            || !('segmentIndex' in metadata) || metadata.segmentIndex !== cached.body.segmentIndex))
          || 'data' in envelope || 'unchanged' in envelope) {
          remove(key)
          throw new Error('Invalid history delta')
        }
        body = { ...(historyOnly ? metadata : cached.body), history: [...(leading as unknown[]), ...cached.body.history, ...delta.history] }
      } else {
        if (!('data' in envelope) || !envelope.data || typeof envelope.data !== 'object' || Array.isArray(envelope.data)) {
          remove(key)
          throw new Error('Invalid history snapshot')
        }
        body = envelope.data as Record<string, unknown>
      }
      const size = new TextEncoder().encode(JSON.stringify(body)).byteLength
      remove(key)
      if (size <= maxBytes && maxEntries > 0) {
        entries.set(key, { revision: envelope.revision, historyRevision, body, bytes: size })
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
