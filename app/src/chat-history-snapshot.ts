import { chatMetadataFields, isChatMetadataVersions, isRecord, isRevision, validChatMetadata, type ChatMetadataVersions } from '../../src/shared/chat-snapshot.ts'

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

interface Snapshot { revision: string; historyRevision: string; metadataVersions: ChatMetadataVersions; body: Record<string, unknown>; bytes: number }
const messages = (value: unknown): value is Record<string, unknown>[] => Array.isArray(value)
  && value.every(message => isRecord(message) && typeof message.role === 'string')
const identityFields = ['chatId', 'currentPhysicalId', 'previousPhysicalId', 'segmentIndex'] as const

/** Bounded memory only. Each request captures its own base; a late response may
 * return its own result but cannot replace a newer cache entry. */
export function createChatHistorySnapshots(request: typeof fetch = fetch, maxBytes = 16 * 1024 * 1024, maxEntries = 8) {
  const entries = new Map<string, Snapshot>()
  // In-flight tokens are removed on settlement (no unbounded URL generation map).
  const latest = new Map<string, object>()
  let bytes = 0
  let disposed = false
  function remove(key: string) {
    const old = entries.get(key)
    if (old) { bytes -= old.bytes; entries.delete(key) }
  }
  return {
    async read(url: string | URL, signal: AbortSignal): Promise<ChatHistorySnapshotResult> {
      if (disposed || signal.aborted) throw new Error('History read cancelled or disposed')
      const target = new URL(url)
      const key = target.toString()
      const cached = entries.get(key)
      const token = {}
      latest.set(key, token)
      const current = () => latest.get(key) === token
      target.searchParams.set('snapshot', cached?.revision ?? '')
      for (const name of ['historyCount', 'historyRevision', ...chatMetadataFields.map(field => `${field}Revision`)]) target.searchParams.delete(name)
      if (cached) {
        target.searchParams.set('historyCount', String((cached.body.history as unknown[]).length))
        target.searchParams.set('historyRevision', cached.historyRevision)
        for (const field of chatMetadataFields) target.searchParams.set(`${field}Revision`, cached.metadataVersions[field])
      }
      try {
        const response = await request(target.toString(), { signal, cache: 'no-store' })
        if (signal.aborted || disposed) throw new Error('History read cancelled')
        if (!response.ok) { if (current()) remove(key); return { ok: false, status: response.status, response } }
        const envelope: unknown = await response.json()
        if (signal.aborted || disposed) throw new Error('History read cancelled')
        if (!isRecord(envelope) || !isRevision(envelope.revision)) throw new Error('Invalid history snapshot')
        if (envelope.unchanged === true) {
          if (!cached || cached.revision !== envelope.revision || 'delta' in envelope || 'data' in envelope) throw new Error('History snapshot unavailable')
          if (current() && entries.get(key) === cached) { entries.delete(key); entries.set(key, cached) }
          return { ok: true, status: response.status, data: structuredClone(cached.body) }
        }
        if (!isRevision(envelope.historyRevision) || !isChatMetadataVersions(envelope.metadataVersions)
          || 'unchanged' in envelope) throw new Error('Invalid history validators')
        const versions = envelope.metadataVersions
        let body: Record<string, unknown>
        if ('delta' in envelope) {
          const delta = envelope.delta
          const identity = isRecord(delta) ? delta.identity : undefined
          if (!cached || !isRecord(delta) || 'data' in envelope
            || delta.baseRevision !== cached.revision || delta.baseHistoryRevision !== cached.historyRevision
            || !Array.isArray(cached.body.history) || delta.baseCount !== cached.body.history.length
            || !messages(delta.history) || !messages(delta.leadingHistory) || delta.leadingHistory.length > 16
            || delta.historyOffset !== delta.leadingHistory.length
            || delta.count !== cached.body.history.length + delta.leadingHistory.length + delta.history.length
            || !isRecord(identity) || Object.keys(identity).length !== identityFields.length
            || !identityFields.every(field => identity[field] === cached.body[field])
            || !isRecord(delta.metadataPatch)
            || Object.keys(delta.metadataPatch).some(field => !(chatMetadataFields as readonly string[]).includes(field))) throw new Error('Invalid history delta')
          // Omission is a reference to the captured base, never deletion. Every
          // omitted field must have the exact matching response/base validator.
          body = { ...identity }
          for (const field of chatMetadataFields) {
            if (Object.hasOwn(delta.metadataPatch, field)) body[field] = delta.metadataPatch[field]
            else {
              if (versions[field] !== cached.metadataVersions[field]) throw new Error('Invalid metadata reference')
              body[field] = cached.body[field]
            }
          }
          body.history = [...delta.leadingHistory, ...cached.body.history, ...delta.history]
        } else {
          if (!isRecord(envelope.data)) throw new Error('Invalid history snapshot')
          body = envelope.data
        }
        if (!messages(body.history) || !validChatMetadata(body) || typeof body.chatId !== 'string'
          || (target.searchParams.has('chatId') && body.chatId !== target.searchParams.get('chatId'))
          || typeof body.currentPhysicalId !== 'string' || !body.currentPhysicalId
          || (body.previousPhysicalId !== null && typeof body.previousPhysicalId !== 'string')
          || !Number.isSafeInteger(body.segmentIndex) || (body.segmentIndex as number) < 0) throw new Error('Invalid history identity or metadata')
        const size = maxEntries > 0 ? jsonBytes(body, maxBytes) : Infinity
        if (current()) {
          remove(key)
          if (size <= maxBytes && maxEntries > 0) {
            entries.set(key, { revision: envelope.revision, historyRevision: envelope.historyRevision, metadataVersions: versions,
              body: 'delta' in envelope ? body : structuredClone(body), bytes: size })
            bytes += size
            while (entries.size > maxEntries || bytes > maxBytes) remove(entries.keys().next().value!)
          }
        }
        return { ok: true, status: response.status, data: 'delta' in envelope ? structuredClone(body) : body }
      } catch (error) {
        if (current() && !signal.aborted && !disposed) remove(key)
        throw error
      } finally { if (current()) latest.delete(key) }
    },
    dispose() { disposed = true; entries.clear(); latest.clear(); bytes = 0 },
  }
}
