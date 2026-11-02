import { parseSessionGraph, isRecord, type SidebarSession } from './folders-sidebar.ts'
import { createConditionalProjectJson, projectJson } from './projects.ts'

interface Graph { sessions: Array<Record<string, unknown>>; nodes: Array<Record<string, unknown>> }
const narrowChanges = new Set(['history', 'metadata', 'activity', 'work', 'background-tasks', 'scheduled-tasks'])
function graphWire(value: unknown): Graph {
  if (!isRecord(value) || !Array.isArray(value.sessions) || !Array.isArray(value.nodes)
    || !value.sessions.every(isRecord) || !value.nodes.every(isRecord)) throw new Error('Invalid session graph')
  return value as unknown as Graph
}

/** Retain the complete wire graph for cross-session physical parent resolution.
 * Only known session invalidations can patch it. Structural/legacy events and
 * recovery always replace the authoritative full graph. */
export function createSessionGraphLoader(base: string, projectId: string, request: typeof fetch = fetch) {
  const parsedFull = new WeakMap<Graph, SidebarSession[]>()
  const fullReader = createConditionalProjectJson(base, '/api/sessions/graph', value => {
    // Do not retain a validator for a malformed/domain-invalid response.
    const parsed = parseSessionGraph(value, projectId)
    const wire = graphWire(value)
    parsedFull.set(wire, parsed)
    return wire
  }, request)
  let cached: Graph | undefined
  let full = true
  const pending = new Set<string>()
  function reset() { full = true; pending.clear() }
  async function fetchGraph(signal: AbortSignal, ids?: string[]) {
    if (!ids) return fullReader.load(signal)
    // Partial results must never replace the full endpoint's validator/base.
    return projectJson(base, `/api/sessions/graph?sessionIds=${encodeURIComponent(JSON.stringify(ids))}`, { signal }, request)
  }
  function apply(value: unknown, signal: AbortSignal): SidebarSession[] {
    const wire = graphWire(value)
    const parsed = parsedFull.get(wire) ?? parseSessionGraph(value, projectId)
    signal.throwIfAborted()
    cached = wire
    return parsed
  }
  return {
    reset,
    invalidate(payload: unknown) {
      if (!isRecord(payload) || typeof payload.sessionId !== 'string'
        || !Array.isArray(payload.changes) || !payload.changes.length
        || payload.changes.some(change => typeof change !== 'string' || !narrowChanges.has(change))
        || !cached?.sessions.some(row => row.sessionId === payload.sessionId)) { reset(); return }
      pending.add(payload.sessionId)
      if (pending.size > 32) reset()
    },
    async load(signal: AbortSignal): Promise<SidebarSession[]> {
      const ids = !full && cached && pending.size ? [...pending] : undefined
      const previous = cached
      pending.clear(); full = false
      try {
        const value = await fetchGraph(signal, ids)
        signal.throwIfAborted()
        if (!ids || !isRecord(value) || value.partial !== true) return apply(value, signal)
        let patch: Graph
        try { patch = graphWire(value) }
        catch { return apply(await fetchGraph(signal), signal) }
        const selected = new Set(ids)
        // Missing/deleted rows, malformed scope or duplicate IDs require full
        // recovery rather than guessing topology or silently removing a row.
        if (!previous || !Array.isArray(value.sessionIds) || value.sessionIds.length !== ids.length
          || value.sessionIds.some(id => typeof id !== 'string' || !selected.has(id))
          || new Set(value.sessionIds).size !== ids.length
          || patch.sessions.length !== ids.length
          || new Set(patch.sessions.map(row => row.sessionId)).size !== ids.length
          || patch.sessions.some(row => typeof row.sessionId !== 'string' || !selected.has(row.sessionId))
          || patch.nodes.some(node => typeof node.logicalId !== 'string' || !selected.has(node.logicalId))
          || ids.some(id => !patch.nodes.some(node => node.logicalId === id))) {
          return apply(await fetchGraph(signal), signal)
        }
        const replacements = new Map(patch.sessions.map(row => [row.sessionId, row]))
        try {
          return apply({ sessions: previous.sessions.map(row => replacements.get(row.sessionId) ?? row),
            nodes: [...previous.nodes.filter(node => !selected.has(String(node.logicalId))), ...patch.nodes] }, signal)
        } catch {
          signal.throwIfAborted()
          return apply(await fetchGraph(signal), signal)
        }
      } catch (error) { reset(); throw error }
    },
  }
}
