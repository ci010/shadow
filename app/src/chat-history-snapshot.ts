/** Successful reads transfer an independently owned parsed body to the caller.
 * Non-2xx responses are not parsed and never fall back to a cached body. */
export type ChatHistorySnapshotResult =
  | { ok: true; status: number; data: Record<string, unknown> }
  | { ok: false; status: number; response: Response }

/** Screen the entire tree using only string lengths before inspecting any string
 * contents. UTF-16 length is a lower bound for JSON UTF-8 (including surrogates).
 * Oversized multi-image bodies therefore never pay a per-character scan. */
function jsonBytes(value: unknown, limit: number): number {
  if (jsonSize(value, limit, true) > limit) return Infinity
  return jsonSize(value, limit, false)
}

// A single native character-class search: no nested quantifiers/backtracking,
// no intermediate JSON or UTF-8 buffer. Most image/base64 strings take this path.
const needsJsonCounting = /["\\\x00-\x1f\x80-\uffff]/

/** Deep values are conservatively uncacheable, not rejected as history. */
function jsonSize(value: unknown, limit: number, lowerBound: boolean, depth = 0): number {
  if (limit < 0 || depth > 100) return Infinity
  if (typeof value === 'string') {
    if (value.length + 2 > limit) return Infinity
    if (lowerBound || !needsJsonCounting.test(value)) return value.length + 2
    let size = 2
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i)
      if (code === 34 || code === 92) size += 2
      else if (code < 32) size += code === 8 || code === 9 || code === 10 || code === 12 || code === 13 ? 2 : 6
      else if (code < 128) size++
      else if (code < 2048) size += 2
      else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length
        && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) { size += 4; i++ }
      else if (code >= 0xd800 && code <= 0xdfff) size += 6 // JSON escapes lone surrogates
      else size += 3
      if (size > limit) return Infinity
    }
    return size
  }
  if (value === null) return 4
  if (typeof value === 'boolean') return value ? 4 : 5
  if (typeof value === 'number') return String(value).length
  if (!value || typeof value !== 'object') return Infinity // only parsed JSON is supported
  let size = 2
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      size += (i ? 1 : 0) + jsonSize(value[i], limit - size - (i ? 1 : 0), lowerBound, depth + 1)
      if (size > limit) return Infinity
    }
  } else {
    let first = true
    for (const key of Object.keys(value)) {
      size += (first ? 0 : 1) + jsonSize(key, limit - size - (first ? 0 : 1), lowerBound, depth + 1) + 1
      size += jsonSize((value as Record<string, unknown>)[key], limit - size, lowerBound, depth + 1)
      if (size > limit) return Infinity
      first = false
    }
  }
  return size
}

interface Snapshot { revision: string; historyRevision?: string; metadataRevision?: string; body: Record<string, unknown>; bytes: number }
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
    async read(url: string | URL, signal: AbortSignal): Promise<ChatHistorySnapshotResult> {
      if (disposed) throw new Error('History snapshots disposed')
      const target = new URL(url)
      const key = target.toString()
      const cached = entries.get(key)
      target.searchParams.set('snapshot', cached?.revision ?? '')
      target.searchParams.delete('historyCount')
      target.searchParams.delete('historyRevision')
      target.searchParams.delete('metadataRevision')
      if (cached?.metadataRevision) target.searchParams.set('metadataRevision', cached.metadataRevision)
      if (cached?.historyRevision) target.searchParams.set('historyRevision', cached.historyRevision)
      if (cached && Array.isArray(cached.body.history)) target.searchParams.set('historyCount', String(cached.body.history.length))
      const response = await request(target.toString(), { signal, cache: 'no-store' }).catch(error => { remove(key); throw error })
      if (signal.aborted || disposed) throw new Error('History read cancelled')
      if (!response.ok) { remove(key); return { ok: false, status: response.status, response } }
      const envelope: unknown = await response.json().catch(error => { remove(key); throw error })
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
        // Refresh LRU only after successful validation. Never expose the private base.
        entries.delete(key)
        entries.set(key, cached)
        return { ok: true, status: response.status, data: structuredClone(cached.body) }
      }
      const historyRevision = 'historyRevision' in envelope ? envelope.historyRevision : undefined
      if (historyRevision !== undefined && (typeof historyRevision !== 'string' || !/^[a-f0-9]{64}$/.test(historyRevision))) {
        remove(key)
        throw new Error('Invalid history revision')
      }
      const metadataRevision = 'metadataRevision' in envelope ? envelope.metadataRevision : undefined
      if (metadataRevision !== undefined && (typeof metadataRevision !== 'string' || !/^[a-f0-9]{64}$/.test(metadataRevision))) {
        remove(key)
        throw new Error('Invalid metadata revision')
      }
      let body: Record<string, unknown>
      if ('delta' in envelope) {
        const delta = envelope.delta
        const reference = delta && typeof delta === 'object' && 'baseMetadataRevision' in delta ? delta.baseMetadataRevision : undefined
        const hasReference = !!delta && typeof delta === 'object' && 'baseMetadataRevision' in delta
        const hasMetadata = !!delta && typeof delta === 'object' && 'metadata' in delta
        const { history: _history, ...cachedMetadata } = cached?.body ?? {}
        const metadata = hasReference ? cachedMetadata
          : delta && typeof delta === 'object' && 'metadata' in delta ? delta.metadata : undefined
        const leading = delta && typeof delta === 'object' && 'leadingHistory' in delta ? delta.leadingHistory : []
        const historyOnly = hasMetadata || hasReference || (delta && typeof delta === 'object' && 'baseHistoryRevision' in delta)
        if ((hasReference && (hasMetadata || !metadataRevision || reference !== metadataRevision
            || reference !== cached?.metadataRevision))
          || (metadataRevision !== undefined && !hasReference && !hasMetadata)
          || !cached || !Array.isArray(cached.body.history) || !delta || typeof delta !== 'object' || Array.isArray(delta)
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
        body = { ...(historyOnly ? metadata as Record<string, unknown> : cached.body), history: [...(leading as unknown[]), ...cached.body.history, ...delta.history] }
      } else {
        if ('unchanged' in envelope || !('data' in envelope) || !envelope.data || typeof envelope.data !== 'object' || Array.isArray(envelope.data)) {
          remove(key)
          throw new Error('Invalid history snapshot')
        }
        body = envelope.data as Record<string, unknown>
      }
      if (metadataRevision !== undefined && (!historyRevision || !Array.isArray(body.history)
        || typeof body.chatId !== 'string'
        || (target.searchParams.has('chatId') && body.chatId !== target.searchParams.get('chatId'))
        || typeof body.currentPhysicalId !== 'string' || !body.currentPhysicalId
        || !Number.isSafeInteger(body.segmentIndex) || (body.segmentIndex as number) < 0)) {
        remove(key)
        throw new Error('Invalid history identity')
      }
      const size = maxEntries > 0 ? jsonBytes(body, maxBytes) : Infinity
      remove(key)
      if (size <= maxBytes && maxEntries > 0) {
        // Full responses belong to the caller; deltas may share the private base.
        entries.set(key, { revision: envelope.revision, historyRevision, metadataRevision,
          body: 'delta' in envelope ? body : structuredClone(body), bytes: size })
        bytes += size
        while (entries.size > maxEntries || bytes > maxBytes) remove(entries.keys().next().value!)
      }
      return { ok: true, status: response.status, data: 'delta' in envelope ? structuredClone(body) : body }
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
