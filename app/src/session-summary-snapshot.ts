import { isRecord, parseSessionGraph } from './folders-sidebar.ts'
import { createConditionalProjectJson } from './projects.ts'

/** Navigation inventory has logical lineage and bounded inference settings, not
 * physical segment nodes or the arbitrary persisted session configuration. */
export function parseSessionSummary(value: unknown, projectId?: string) {
  if (!isRecord(value) || !Array.isArray(value.sessions)) throw new Error('Invalid session summary')
  const rows: Array<Record<string, unknown>> = value.sessions.map(row => {
    if (!isRecord(row) || (row.contextParentSessionId !== undefined
      && (typeof row.contextParentSessionId !== 'string' || !row.contextParentSessionId))) throw new Error('Invalid session summary')
    return { ...row, config: row.inferenceOverrides }
  })
  const sessions = parseSessionGraph({ sessions: rows, nodes: [] }, projectId)
  const parents = new Map(rows.map(row => [row.sessionId, row.contextParentSessionId]))
  return sessions.map(session => ({ ...session,
    contextParentSessionId: parents.get(session.sessionId) as string | undefined,
  }))
}

export function createSessionSummaryLoader(base: string, projectId: string, request: typeof fetch = fetch) {
  const reader = createConditionalProjectJson(base, '/api/sessions/summary', value => {
    parseSessionSummary(value, projectId)
    return value as { sessions: Array<Record<string, unknown>> }
  }, request, {
    headers: { 'Accept': 'application/vnd.shadow.session-summary-delta+json' },
    decode(value, previous, etag) {
      if (!isRecord(value) || value.delta === undefined) return value
      if (value.delta !== 1 || !previous || value.base !== etag || !Array.isArray(value.upsert)
        || !Array.isArray(value.removed) || !Array.isArray(value.order)
        || !value.removed.every(id => typeof id === 'string')
        || !value.order.every(id => typeof id === 'string')
        || new Set(value.order).size !== value.order.length) throw new Error('Invalid session summary delta')
      const rows = new Map(previous.sessions.map(row => [row.sessionId, row]))
      for (const id of value.removed) rows.delete(id)
      const seen = new Set<string>()
      for (const row of value.upsert) {
        if (!isRecord(row) || typeof row.sessionId !== 'string' || seen.has(row.sessionId)) throw new Error('Invalid session summary delta')
        seen.add(row.sessionId)
        rows.set(row.sessionId, row)
      }
      if (rows.size !== value.order.length || value.order.some(id => !rows.has(id))) throw new Error('Invalid session summary delta')
      return { sessions: value.order.map(id => rows.get(id)!) }
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
