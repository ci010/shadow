import { createHash } from 'node:crypto'
import { HISTORY_DELTA_PREPEND_LIMIT, parseHistoryOffset } from '../shared/history-wire.ts'

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const validRevision = (value: string | null): value is string => !!value && /^[a-f0-9]{64}$/.test(value)

/** Stateless validators, bound to both the requested key and physical segment.
 * Rewrites/truncation/rollover fall back to a complete representation. */
export function readonlyHistorySnapshot(data: Record<string, unknown> & { key: string; messages: unknown[] }, query: URLSearchParams) {
  const { messages, ...metadata } = data
  const revision = hash(data)
  const historyHash = (prefix: unknown[], start = data.historyStart) => hash({ key: data.key,
    currentPhysicalId: data.currentPhysicalId, segmentIndex: data.segmentIndex, historyStart: start, messages: prefix })
  const historyRevision = historyHash(messages)
  const metadataRevision = hash(metadata)
  const baseRevision = query.get('snapshot')
  const countText = query.get('historyCount')
  const count = countText !== null && /^(0|[1-9]\d*)$/.test(countText) ? Number(countText) : NaN
  if (baseRevision === revision && count === messages.length) return { revision, unchanged: true }
  const baseHistoryRevision = query.get('historyRevision')
  const baseStart = typeof data.historyStart === 'number' ? parseHistoryOffset(query.get('baseHistoryStart')) : undefined
  const leading = typeof data.historyStart === 'number' && baseStart !== undefined ? baseStart - data.historyStart : 0
  if (validRevision(baseRevision) && validRevision(baseHistoryRevision)
    && leading >= 0 && leading <= HISTORY_DELTA_PREPEND_LIMIT
    && Number.isSafeInteger(count) && count >= 0 && count + leading <= messages.length
    && historyHash(messages.slice(leading, leading + count), baseStart ?? data.historyStart) === baseHistoryRevision) {
    return { revision, historyRevision, metadataRevision, delta: {
      baseRevision, baseHistoryRevision, baseCount: count, count: messages.length,
      ...(leading ? { leadingMessages: messages.slice(0, leading) } : {}),
      messages: messages.slice(leading + count),
      ...(query.get('metadataRevision') === metadataRevision ? { baseMetadataRevision: metadataRevision } : { metadata }),
    } }
  }
  return { revision, historyRevision, metadataRevision, data }
}
