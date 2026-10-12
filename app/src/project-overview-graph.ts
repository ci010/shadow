import type { ProjectWorkOverview } from '../../src/projects/work-overview.ts'
import type { YieldDecisionRecord } from '../../src/sessions/yield-contract.ts'
export type OverviewNode = { id: string; title: string; kind: string; at: string; authority: string; evidence: string; workKey?: string; sessionId?: string; detail?: string; status?: string; parentId?: string }
export type OverviewEdge = { from: string; to: string; kind: 'hierarchy' | 'dependency' | 'precedence' | 'context' | 'reference' | 'reconsiders' | 'relation' | 'causal'; evidence: string }
/** References provide context, not proof of causal impact. Dates only order events. */
export function overviewGraph(data: ProjectWorkOverview, history: YieldDecisionRecord[] = []) {
  const nodes: OverviewNode[] = data.items.map(item => ({ id: item.key, parentId: item.parentKey ?? undefined, title: item.title,
    kind: item.notes?.kind ?? (item.parentKey ? 'task' : 'goal'), at: item.changedAt,
    authority: item.origin === 'human' ? 'human' : 'agent_interpretation', workKey: item.key, status: item.status ?? undefined,
    sessionId: item.observation?.sessionId ?? item.assignee ?? undefined,
    evidence: item.observation ? item.observation.sources.map(source => `${source.physicalId}/${source.id}`).join(', ') : `${item.key} v${item.sequence}`,
    detail: item.notes?.summary ?? item.objective }))
  for (const session of data.sessions) if (!data.items.some(item => item.key === session.workKey || item.assignee === session.sessionId || item.observation?.sessionId === session.sessionId)) {
    nodes.push({ id: `session:${session.sessionId}`, title: session.title, kind: 'topic', at: session.lastActivityAt ?? '', authority: 'session_derived', sessionId: session.sessionId, evidence: 'Session metadata only; not a verified topic boundary.', detail: session.activity })
  }
  const edges: OverviewEdge[] = []
  for (const item of data.items) {
    for (const influence of item.decisionInfluences ?? []) {
      const source = influence.request
      edges.push({ from: `decision:${source.sessionId}/${source.physicalId}/${source.requestId}`, to: item.key, kind: 'causal', evidence: `Applied proposal changed revision ${influence.baseRevision} → ${influence.appliedRevision}: ${influence.reason}. Persisted application, not inferred from time.` })
    }
    if (item.parentKey) edges.push({ from: item.parentKey, to: item.key, kind: 'hierarchy', evidence: `${item.key} parentKey` })
    for (const dependency of item.dependencies) edges.push({ from: dependency, to: item.key, kind: 'dependency', evidence: `${item.key} dependencies` })
    if (item.parentKey && item.notes?.relation) edges.push({ from: item.key, to: item.parentKey, kind: 'relation', evidence: `${item.notes.relation.kind}: ${item.notes.relation.reason}` })
    if (item.notes?.summary) {
      const id = `report:${item.key}`
      nodes.push({ id, parentId: item.key, title: item.notes.summary, kind: 'result', at: item.changedAt, authority: 'reported', evidence: `${item.key} notes.summary v${item.sequence}`, workKey: item.key })
      edges.push({ from: item.key, to: id, kind: 'context', evidence: 'Saved report; not user acceptance or proof of impact.' })
    }
  }
  const decisionId = (session: string, physical: string, request: string) => `decision:${session}/${physical}/${request}`
  for (const record of history) {
    const request = record.request, id = decisionId(request.sessionId, request.origin?.physicalId ?? '', request.id)
    if (nodes.some(node => node.id === id)) continue
    const owner = [...(request.workContext?.path ?? [])].reverse().find(context => data.items.some(item => item.key === context.key))?.key
      ?? data.items.find(item => item.key === data.sessions.find(session => session.sessionId === request.sessionId)?.workKey || item.observation?.sessionId === request.sessionId || item.assignee === request.sessionId)?.key
      ?? nodes.find(node => node.sessionId === request.sessionId && node.kind === 'topic')?.id
    nodes.push({ id, parentId: owner, title: request.question, kind: record.answer ? 'decision' : 'question', at: record.answer?.answeredAt ?? request.createdAt,
      authority: record.invalidated ? 'invalidated' : record.answer?.answeredBy ?? 'pending', evidence: `${request.sessionId}/${request.origin?.physicalId ?? '?'}/${request.id}`,
      sessionId: request.sessionId, detail: record.answer?.option ?? record.closed?.message,
      workKey: owner?.startsWith('session:') ? undefined : owner })
    for (const context of request.workContext?.path ?? []) edges.push({ from: context.key, to: id, kind: 'context', evidence: 'Original recorded decision context, not inferred impact.' })
    for (const source of request.sources ?? []) edges.push({ from: decisionId(source.sessionId, source.physicalId, source.requestId), to: id, kind: 'reference', evidence: 'Explicit cited decision reference; context only, not causation.' })
    if (request.reconsiders) { const source = request.reconsiders; edges.push({ from: decisionId(source.sessionId, source.physicalId, source.requestId), to: id, kind: 'reconsiders', evidence: 'Recorded reconsideration of a prior decision; does not prove downstream plan change.' }) }
  }
  // Missing references remain inspectable without promoting them into top-level topics.
  for (const edge of [...edges]) for (const id of [edge.from, edge.to]) if (!nodes.some(node => node.id === id)) nodes.push({ id, parentId: edge.kind === 'hierarchy' ? undefined : nodes.find(node => node.id === (id === edge.from ? edge.to : edge.from))?.id, title: id, kind: 'unavailable', at: '', authority: 'unknown', evidence: 'Referenced record unavailable in loaded history.' })
  const chronological = nodes.filter(node => Number.isFinite(Date.parse(node.at))).sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
  for (let index = 1; index < chronological.length; index++) {
    const before = chronological[index - 1]!, after = chronological[index]!
    if (before.at !== after.at) edges.push({ from: before.id, to: after.id, kind: 'precedence', evidence: `${before.at} → ${after.at}; temporal precedence only, not causal influence.` })
  }
  return { nodes, edges }
}


/** Ownership alone drives disclosure; semantic edges never open another branch. */
export function overviewTree(graph: ReturnType<typeof overviewGraph>) {
  const byId = new Map(graph.nodes.map(node => [node.id, node]))
  const parents = new Map<string, string>()
  for (const node of graph.nodes) {
    if (!node.parentId || !byId.has(node.parentId) || byId.get(node.parentId)?.kind === 'unavailable') continue
    const seen = new Set([node.id])
    let cursor: OverviewNode | undefined = node
    let cyclic = false
    while (cursor?.parentId && byId.has(cursor.parentId) && byId.get(cursor.parentId)?.kind !== 'unavailable') {
      if (seen.has(cursor.parentId)) { cyclic = true; break }
      seen.add(cursor.parentId); cursor = byId.get(cursor.parentId)
    }
    if (!cyclic) parents.set(node.id, node.parentId)
  }
  const children = new Map<string, OverviewNode[]>()
  for (const node of graph.nodes) {
    const parent = parents.get(node.id)
    if (parent) children.set(parent, [...(children.get(parent) ?? []), node])
  }
  return { roots: graph.nodes.filter(node => !parents.has(node.id) && !['unavailable', 'decision', 'question', 'result'].includes(node.kind)), children, parents }
}

export const overviewNodeWidth = 280
export const overviewRowHeight = 136
/** Visible subtrees reserve horizontal lanes; ownership depth alone sets rows. */
export function overviewLayout(graph: ReturnType<typeof overviewGraph>, expanded: ReadonlySet<string>, matches: (node: OverviewNode) => boolean = () => true) {
  const tree = overviewTree(graph)
  // Filters keep ownership ancestors but never implicitly expand them.
  const eligible = new Set<string>()
  for (const node of graph.nodes.filter(matches)) {
    let id: string | undefined = node.id
    while (id && !eligible.has(id)) { eligible.add(id); id = tree.parents.get(id) }
  }
  const nodes: OverviewNode[] = [], positions = new Map<string, { x: number; y: number }>()
  const gap = 40, padding = 16
  let maxRows = 1
  const roots = tree.roots.filter(node => eligible.has(node.id))
  const widths = new Map<string, number>()
  const visibleChildren = (node: OverviewNode) => expanded.has(node.id)
    ? (tree.children.get(node.id) ?? []).filter(child => eligible.has(child.id)) : []
  function measure(node: OverviewNode): number {
    const children = visibleChildren(node)
    const width = Math.max(overviewNodeWidth, children.reduce((sum, child) => sum + measure(child), 0) + Math.max(0, children.length - 1) * gap)
    widths.set(node.id, width)
    return width
  }
  for (const root of roots) measure(root)
  function place(node: OverviewNode, left: number, depth: number) {
    nodes.push(node)
    positions.set(node.id, { x: left + (widths.get(node.id)! - overviewNodeWidth) / 2, y: padding + depth * overviewRowHeight })
    maxRows = Math.max(maxRows, depth + 1)
    let childLeft = left
    for (const child of visibleChildren(node)) {
      place(child, childLeft, depth + 1)
      childLeft += widths.get(child.id)! + gap
    }
  }
  let left = padding
  for (const root of roots) {
    place(root, left, 0)
    left += widths.get(root.id)! + gap
  }
  const visible = new Set(nodes.map(node => node.id))
  return { nodes, edges: graph.edges.filter(edge => visible.has(edge.from) && visible.has(edge.to)), positions, children: tree.children,
    width: roots.length ? left - gap + padding : overviewNodeWidth + 2 * padding, height: maxRows * overviewRowHeight + padding }
}
