type Body = Record<string, unknown> & { messages: unknown[] }
type Snapshot = { revision: string; historyRevision: string; metadataRevision: string; body: Body; bytes: number }
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const revision = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
const snapshots = new WeakMap<object, ReturnType<typeof createReadonlyHistorySnapshots>>()

/** Authenticated-lifetime, bounded memory; never return stale data on access/network errors. */
export function createReadonlyHistorySnapshots(request: typeof fetch = fetch, maxBytes = 16 * 1024 * 1024, maxEntries = 8) {
  const entries = new Map<string, Snapshot>()
  let bytes = 0
  let disposed = false
  const remove = (key: string) => { const old = entries.get(key); if (old) bytes -= old.bytes; entries.delete(key) }
  return {
    async read(url: string | URL, signal: AbortSignal): Promise<Response> {
      const key = new URL(url).toString()
      const cached = entries.get(key)
      const target = new URL(url)
      target.searchParams.set('snapshot', cached?.revision ?? '')
      if (cached) {
        target.searchParams.set('historyCount', String(cached.body.messages.length))
        target.searchParams.set('historyRevision', cached.historyRevision)
        target.searchParams.set('metadataRevision', cached.metadataRevision)
      }
      try {
        if (disposed || signal.aborted) throw new Error('History read cancelled')
        const response = await request(target, { signal, cache: 'no-store' })
        if (!response.ok) { remove(key); return response }
        const envelope: unknown = await response.json()
        if (disposed || signal.aborted) throw new Error('History read cancelled')
        // Physical/legacy routes remain complete responses and are not cached.
        if (record(envelope) && Array.isArray(envelope.messages) && !('revision' in envelope)) {
          remove(key); return Response.json(envelope)
        }
        if (!record(envelope) || !revision(envelope.revision)) throw new Error('Invalid history snapshot')
        if (envelope.unchanged === true) {
          if (!cached || envelope.revision !== cached.revision || 'data' in envelope || 'delta' in envelope) throw new Error('History snapshot unavailable')
          return Response.json(cached.body)
        }
        if (!revision(envelope.historyRevision) || !revision(envelope.metadataRevision) || 'unchanged' in envelope) throw new Error('Invalid history validators')
        let body: Body
        if ('delta' in envelope) {
          const delta = envelope.delta
          if (!cached || !record(delta) || 'data' in envelope
            || delta.baseRevision !== cached.revision || delta.baseHistoryRevision !== cached.historyRevision
            || delta.baseCount !== cached.body.messages.length || !Array.isArray(delta.messages)
            || delta.count !== cached.body.messages.length + delta.messages.length) throw new Error('Invalid history delta')
          const { messages: _messages, ...oldMetadata } = cached.body
          const metadata = 'baseMetadataRevision' in delta ? oldMetadata : delta.metadata
          if ('baseMetadataRevision' in delta && ('metadata' in delta || delta.baseMetadataRevision !== cached.metadataRevision
            || delta.baseMetadataRevision !== envelope.metadataRevision)) throw new Error('Invalid metadata reference')
          if (!record(metadata) || 'messages' in metadata || metadata.key !== cached.body.key
            || metadata.currentPhysicalId !== cached.body.currentPhysicalId || metadata.segmentIndex !== cached.body.segmentIndex) throw new Error('Invalid history identity')
          body = { ...metadata, messages: [...cached.body.messages, ...delta.messages] }
        } else {
          if (!record(envelope.data) || !Array.isArray(envelope.data.messages)) throw new Error('Invalid history body')
          body = envelope.data as Body
        }
        const expectedKey = decodeURIComponent(target.pathname.split('/').at(-1)!)
        if (body.key !== expectedKey || typeof body.currentPhysicalId !== 'string' || !body.currentPhysicalId
          || !Number.isSafeInteger(body.segmentIndex) || (body.segmentIndex as number) < 0
          || !Array.isArray(body.commandResults) || !Array.isArray(body.decisionRecords)
          || !body.messages.every(message => record(message) && typeof message.role === 'string')) throw new Error('Invalid history identity')
        const size = new TextEncoder().encode(JSON.stringify(body)).byteLength
        remove(key)
        if (size <= maxBytes && maxEntries > 0) {
          entries.set(key, { revision: envelope.revision, historyRevision: envelope.historyRevision, metadataRevision: envelope.metadataRevision, body, bytes: size })
          bytes += size
          while (bytes > maxBytes || entries.size > maxEntries) remove(entries.keys().next().value!)
        }
        return Response.json(body)
      } catch (error) { remove(key); throw error }
    },
    dispose() { disposed = true; entries.clear(); bytes = 0 },
  }
}

export function readonlyHistorySnapshots(pool: { onDispose(callback: () => void): () => void }) {
  let cache = snapshots.get(pool)
  if (!cache) { cache = createReadonlyHistorySnapshots(); snapshots.set(pool, cache); pool.onDispose(() => cache!.dispose()) }
  return cache
}
