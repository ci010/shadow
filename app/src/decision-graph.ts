import { apiUrl } from './api-url.ts'
import { parseDecisionRecords } from './yield-history.ts'
import { parseYieldReference, type YieldDecisionRecord, type YieldReference } from '../../src/sessions/yield-contract.ts'

export const DECISION_GRAPH_LIMIT = 16
export const DECISION_GRAPH_DEPTH = 5
export const decisionKey = (reference: YieldReference) => JSON.stringify([reference.sessionId, reference.physicalId, reference.requestId])
export interface DecisionGraphNode {
  id: string
  reference: YieldReference
  depth: number
  record?: YieldDecisionRecord
  error?: string
}
export interface DecisionGraph {
  root: string
  nodes: DecisionGraphNode[]
  edges: { from: string; to: string; kind: 'cites' | 'supersedes' | 'replacement' | 'reconsiders' }[]
  limited: boolean
}

/** Cache only within one read, including failures; never reuse stale records across refreshes. */
export function decisionReader(apiBase: string, signal: AbortSignal, fetcher: typeof fetch = fetch) {
  const segments = new Map<string, Promise<YieldDecisionRecord[]>>()
  return async (input: YieldReference) => {
    const reference = parseYieldReference(input)
    const key = JSON.stringify([reference.sessionId, reference.physicalId])
    let loading = segments.get(key)
    if (!loading) {
      loading = (async () => {
        const url = apiUrl(apiBase, `/api/sessions/${encodeURIComponent(reference.sessionId)}/decisions`,
          { physicalId: reference.physicalId })
        const response = await fetcher(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) })
        if (!response.ok) throw new Error(response.status === 404 ? 'Source record is unavailable.' : 'Could not load decision history.')
        const records = parseDecisionRecords((await response.json()).records)
        if (records.some(record => record.request.sessionId !== reference.sessionId || record.request.origin?.physicalId !== reference.physicalId)) {
          throw new Error('Decision history does not match the requested session segment.')
        }
        return records
      })()
      segments.set(key, loading)
    }
    const record = (await loading).find(record => record.request.id === reference.requestId)
    if (!record) throw new Error('The source record does not match this reference.')
    return record
  }
}

export async function loadDecisionGraph(reference: YieldReference, read: ReturnType<typeof decisionReader>, signal: AbortSignal): Promise<DecisionGraph> {
  reference = parseYieldReference(reference)
  const root = decisionKey(reference)
  const graph: DecisionGraph = { root, nodes: [{ id: root, reference, depth: 0 }], edges: [], limited: false }
  const known = new Set([root])
  // Breadth-first traversal bounds work and retains shared/cyclic references as edges, not duplicate nodes.
  for (let index = 0; index < graph.nodes.length;) {
    signal.throwIfAborted()
    const batch = graph.nodes.slice(index)
    index += batch.length
    await Promise.all(batch.map(async node => {
      try { node.record = await read(node.reference); signal.throwIfAborted() }
      catch (error) {
        signal.throwIfAborted()
        node.error = error instanceof Error ? error.message : 'Decision history could not be read.'
      }
    }))
    for (const node of batch) {
      if (!node.record) continue
      const links = (node.record.request.sources ?? []).map(reference => ({ reference, kind: 'cites' as const }))
      const related: { reference: YieldReference; kind: DecisionGraph['edges'][number]['kind'] }[] = [...links]
      if (node.record.request.supersedes) related.push({ reference: node.record.request.supersedes, kind: 'supersedes' })
      if (node.record.request.reconsiders) related.push({ reference: node.record.request.reconsiders, kind: 'reconsiders' })
      if (node.record.closed?.replacement) related.push({ reference: node.record.closed.replacement, kind: 'replacement' })
      for (const { reference, kind } of related) {
        const id = decisionKey(reference)
        if (!known.has(id)) {
          if (graph.nodes.length >= DECISION_GRAPH_LIMIT || node.depth >= DECISION_GRAPH_DEPTH) { graph.limited = true; continue }
          known.add(id)
          graph.nodes.push({ id, reference, depth: node.depth + 1 })
        }
        graph.edges.push({ from: node.id, to: id, kind })
      }
    }
  }
  return graph
}

export function layoutDecisionGraph(graph: DecisionGraph) {
  const rows = new Map<number, number>()
  const nodes = graph.nodes.map((node, index) => {
    const row = rows.get(node.depth) ?? 0
    rows.set(node.depth, row + 1)
    return { ...node, number: index + 1, x: 16 + node.depth * 292, y: 16 + row * 128 }
  })
  return { nodes, width: Math.max(280, ...nodes.map(node => node.x + 272)), height: Math.max(144, ...nodes.map(node => node.y + 128)) }
}
