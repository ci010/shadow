import { isRecord, parseSessionGraph } from './folders-sidebar.ts'
import { createConditionalProjectJson } from './projects.ts'

/** Navigation inventory has logical lineage and bounded inference settings, not
 * physical segment nodes or the arbitrary persisted session configuration. */
export function parseSessionSummary(value: unknown, projectId?: string) {
  if (!isRecord(value) || !Array.isArray(value.sessions)) throw new Error('Invalid session summary')
  const rows: Array<Record<string, unknown>> = value.sessions.map(row => {
    if (!isRecord(row) || (row.contextParentSessionId !== undefined
      && (typeof row.contextParentSessionId !== 'string' || !row.contextParentSessionId))) throw new Error('Invalid session summary')
    return { ...row, projectId: row.projectId === undefined ? projectId : row.projectId, config: row.inferenceOverrides }
  })
  // Sort before tree projection: roots, siblings and malformed-cycle fallback
  // all have the same client-owned ordering, independent of full/delta wire order.
  const activity = (row: Record<string, unknown>) => {
    const time = typeof row.lastActivityAt === 'string' ? Date.parse(row.lastActivityAt) : NaN
    return Number.isFinite(time) ? time : 0
  }
  rows.sort((a, b) => activity(b) - activity(a)
    || (String(a.sessionId) < String(b.sessionId) ? -1 : String(a.sessionId) > String(b.sessionId) ? 1 : 0))
  const sessions = parseSessionGraph({ sessions: rows, nodes: [] }, projectId)
  const parents = new Map(rows.map(row => [row.sessionId, row.contextParentSessionId]))
  return sessions.map(session => ({ ...session,
    contextParentSessionId: parents.get(session.sessionId) as string | undefined,
  }))
}

export function createSessionSummaryLoader(base: string, projectId: string, request: typeof fetch = fetch, scope: 'full' | 'navigation' = 'full') {
  const reader = createConditionalProjectJson(base, scope === 'navigation' ? '/api/sessions/summary?scope=navigation' : '/api/sessions/summary', value => {
    parseSessionSummary(value, projectId)
    return value as { sessions: Array<Record<string, unknown>> }
  }, request, {
    headers: { 'Accept': 'application/vnd.shadow.session-summary-delta+json' },
    decode(value, previous, etag) {
      if (!isRecord(value) || value.delta === undefined) return value
      const validIds = (ids: unknown): ids is string[] => Array.isArray(ids)
        && ids.every(id => typeof id === 'string' && id.trim().length > 0)
        && new Set(ids).size === ids.length
      if (value.delta !== 1 || !previous || value.base !== etag || !Array.isArray(value.upsert)
        || !validIds(value.removed) || Object.hasOwn(value, 'order')) throw new Error('Invalid session summary delta')
      const rows = new Map(previous.sessions.map(row => [row.sessionId, row]))
      const removed = new Set(value.removed)
      for (const id of removed) {
        if (!rows.delete(id)) throw new Error('Invalid session summary delta')
      }
      const seen = new Set<string>()
      for (const row of value.upsert) {
        if (!isRecord(row) || typeof row.sessionId !== 'string' || !row.sessionId.trim()
          || seen.has(row.sessionId) || removed.has(row.sessionId)) throw new Error('Invalid session summary delta')
        seen.add(row.sessionId)
        rows.set(row.sessionId, row)
      }
      return { sessions: [...rows.values()] }
    },
  })
  const parsed = new WeakMap<object, ReturnType<typeof parseSessionSummary>>()
  return { clear: reader.clear, async load(signal: AbortSignal) {
    const value = await reader.load(signal)
    let result = parsed.get(value)
    if (!result) { result = parseSessionSummary(value, projectId); parsed.set(value, result) }
    return result
  } }
}
