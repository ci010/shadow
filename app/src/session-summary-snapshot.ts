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
  const reader = createConditionalProjectJson(base, '/api/sessions/summary', value => parseSessionSummary(value, projectId), request)
  return reader
}
