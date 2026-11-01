import { createHash } from 'node:crypto'

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const validRevision = (value: string | null): value is string => !!value && /^[a-f0-9]{64}$/.test(value)

/** Stateless validators, bound to both the requested key and physical segment.
 * Rewrites/truncation/rollover fall back to a complete representation. */
export function readonlyHistorySnapshot(data: Record<string, unknown> & { key: string; messages: unknown[] }, query: URLSearchParams) {
  const { messages, ...metadata } = data
  const revision = hash(data)
  const historyHash = (prefix: unknown[]) => hash({ key: data.key,
    currentPhysicalId: data.currentPhysicalId, segmentIndex: data.segmentIndex, messages: prefix })
  const historyRevision = historyHash(messages)
  const metadataRevision = hash(metadata)
  const baseRevision = query.get('snapshot')
  const countText = query.get('historyCount')
  const count = countText !== null && /^(0|[1-9]\d*)$/.test(countText) ? Number(countText) : NaN
  if (baseRevision === revision && count === messages.length) return { revision, unchanged: true }
  const baseHistoryRevision = query.get('historyRevision')
  if (validRevision(baseRevision) && validRevision(baseHistoryRevision)
    && Number.isSafeInteger(count) && count >= 0 && count <= messages.length
    && historyHash(messages.slice(0, count)) === baseHistoryRevision) {
    return { revision, historyRevision, metadataRevision, delta: {
      baseRevision, baseHistoryRevision, baseCount: count, count: messages.length,
      messages: messages.slice(count),
      ...(query.get('metadataRevision') === metadataRevision ? { baseMetadataRevision: metadataRevision } : { metadata }),
    } }
  }
  return { revision, historyRevision, metadataRevision, data }
}
