import type { ProjectWorkOverview } from '../../src/projects/work-overview.ts'
import { projectTopics, projectFocusGroups } from './project-topic-history.ts'
import type { YieldDecisionRecord } from '../../src/sessions/yield-contract.ts'
export type OverviewNode = { id: string; title: string; kind: string; at: string; authority: string; evidence: string; workKey?: string; sessionId?: string; detail?: string; status?: string; parentId?: string }
export type OverviewEdge = { from: string; to: string; kind: 'hierarchy' | 'dependency' | 'precedence' | 'context' | 'reference' | 'reconsiders' | 'relation' | 'causal'; evidence: string }
/** References provide context, not proof of causal impact. Dates only order events. */
export function overviewGraph(data: ProjectWorkOverview, history: YieldDecisionRecord[] = []) {
  if (data.focus?.presentationVersion === 1 || data.focus?.result.groups.some(group => group.cards !== undefined)) {
    const nodes: OverviewNode[] = [], edges: OverviewEdge[] = []
    for (const [index, group] of data.focus.result.groups.entries()) {
      const rootId = `presentation:${group.id ?? index}`
      const activity = [...data.items.filter(item => group.topicKeys.includes(item.key)).map(item => item.changedAt), ...data.sessions.filter(session => group.cards?.some(card => card.sources.some(source => source.sessionId === session.sessionId))).map(session => session.lastActivityAt ?? '')].filter(at => Number.isFinite(Date.parse(at))).sort().at(-1) ?? data.focus.inferredAt
      nodes.push({ id: rootId, title: group.category, kind: 'topic', at: activity,
        authority: 'agent_interpretation', evidence: group.topicKeys.join(', '), detail: group.purpose })
      for (const card of group.cards ?? []) {
        const id = `presentation-card:${card.id}`
        nodes.push({ id, parentId: rootId, title: card.title, kind: 'outcome', at: activity,
          authority: 'agent_interpretation', status: card.state, detail: card.markdown,
          sessionId: card.sources.find(source => data.focus?.evidence?.some(evidence => evidence.kind === 'human' && evidence.sessionId === source.sessionId && evidence.physicalId === source.physicalId && evidence.id === source.id))?.sessionId,
          evidence: card.sources.map(source => {
            const kind = data.focus?.evidence?.find(evidence => evidence.sessionId === source.sessionId && evidence.physicalId === source.physicalId && evidence.id === source.id)?.kind
            const label = kind === 'human' ? 'Human conversation' : kind === 'assistant' ? 'Model statement (not human approval)' : kind === 'report' ? 'Supporting report (not human approval)' : 'Unknown source'
            return `${label}: ${source.sessionId}/${source.physicalId}/${source.id}${card.stateSources.some(state => state.sessionId === source.sessionId && state.physicalId === source.physicalId && state.id === source.id) ? ' (state)' : ''}`
          }).join(', ') })
        edges.push({ from: rootId, to: id, kind: 'hierarchy', evidence: 'Semantic presentation grouping only; not execution delegation or causation.' })
      }
    }
    // The bounded observer window must not erase older concrete records. Keep them
    // behind one explicit unorganized entry, never as extra leaked source roots.
    const legacy = overviewGraph({ ...data, focus: undefined })
    const cited = new Set(data.focus.result.groups.flatMap(group => group.topicKeys))
    const legacyTree = overviewTree(legacy)
    const leftovers = legacy.nodes.filter(node => {
      if (node.id.startsWith('display-group:') || node.id.startsWith('session:') && data.focus!.result.groups.some(group => group.cards?.some(card => card.sources.some(source => source.sessionId === node.sessionId)))) return false
      let cursor: OverviewNode | undefined = node
      while (cursor) {
        if (cited.has(cursor.id) || cited.has(cursor.workKey ?? '')) return false
        const parent = legacyTree.parents.get(cursor.id)
        cursor = parent ? legacy.nodes.find(candidate => candidate.id === parent) : undefined
      }
      return true
    })
    const retained = new Set(leftovers.map(node => node.id))
    for (const node of leftovers) if (!node.parentId || !retained.has(node.parentId)) node.parentId = undefined
    nodes.push(...leftovers)
    edges.push(...legacy.edges.filter(edge => retained.has(edge.from) && retained.has(edge.to)))
    return organizeGraph({ nodes, edges }, data)
  }
  const childSessions = new Set(data.sessions.filter(session => session.parentSessionId).map(session => session.sessionId))
  const hidden = new Set(data.items.filter(item => childSessions.has(item.observation?.sessionId ?? item.assignee ?? '') || !!item.observation && !!item.parentKey && item.origin !== 'human').map(item => item.key))
  const items = data.items.filter(item => !hidden.has(item.key))
  const nodes: OverviewNode[] = items.map(item => ({ id: item.key, parentId: item.parentKey ?? undefined, title: item.title,
    kind: item.notes?.kind ?? (item.parentKey ? 'task' : 'goal'), at: item.changedAt,
    authority: item.origin === 'human' ? 'human' : 'agent_interpretation', workKey: item.key, status: item.status ?? undefined,
    sessionId: item.observation?.sessionId ?? item.assignee ?? undefined,
    evidence: item.observation ? item.observation.sources.map(source => `${source.physicalId}/${source.id}`).join(', ') : `${item.key} v${item.sequence}`,
    detail: item.notes?.summary ?? item.objective }))
  for (const session of data.sessions) if (!session.parentSessionId && !data.items.some(item => item.key === session.workKey || item.assignee === session.sessionId || item.observation?.sessionId === session.sessionId)) {
    nodes.push({ id: `session:${session.sessionId}`, title: session.title, kind: 'topic', at: session.lastActivityAt ?? '', authority: 'session_derived', sessionId: session.sessionId, evidence: 'Session metadata only; not a verified topic boundary.', detail: session.activity })
  }
  const edges: OverviewEdge[] = []
  for (const item of items) {
    for (const influence of item.decisionInfluences ?? []) {
      const source = influence.request
      if (childSessions.has(source.sessionId)) continue
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
    if (childSessions.has(request.sessionId)) continue
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
  return organizeGraph({ nodes, edges }, data)
}

/** Display ownership, never work delegation or inferred causal influence. */
function organizeGraph(graph: { nodes: OverviewNode[]; edges: OverviewEdge[] }, data: ProjectWorkOverview) {
  const hierarchy = data.focus?.result.hierarchy
  const attach = (node: OverviewNode, parentId: string) => {
    node.parentId = parentId
    graph.edges.push({ from: parentId, to: node.id, kind: 'hierarchy', evidence: 'Inferred display grouping only; not user instructions, work ownership or causation.' })
  }
  if (hierarchy) {
    const owner = new Map(hierarchy.flatMap(node => node.groupIndexes.map(index => [index, `organized-hierarchy:${node.id}`] as const)))
    const existing = [...graph.nodes]
    for (const node of hierarchy) graph.nodes.push({ id: `organized-hierarchy:${node.id}`, parentId: node.parentId ? `organized-hierarchy:${node.parentId}` : undefined,
      title: node.title, detail: node.purpose, kind: 'group', at: '', authority: 'agent_interpretation', evidence: 'Saved model interpretation; not confirmed user intent.' })
    for (const node of hierarchy) if (node.parentId) graph.edges.push({ from: `organized-hierarchy:${node.parentId}`, to: `organized-hierarchy:${node.id}`, kind: 'hierarchy', evidence: 'Inferred display hierarchy only; not causation.' })
    const presentation = data.focus?.presentationVersion === 1 || data.focus?.result.groups.some(group => group.cards !== undefined)
    for (const [index, group] of data.focus!.result.groups.entries()) {
      const parent = owner.get(index)
      if (!parent) continue
      for (const node of existing) if (presentation ? node.id === `presentation:${group.id ?? index}` : !node.parentId && group.topicKeys.includes(node.workKey ?? node.id)) attach(node, parent)
    }
    // Legacy unsupplied records remain explicit rather than leaking as new abstract roots.
    const unassigned = existing.filter(node => !node.parentId && !['unavailable', 'decision', 'question', 'result'].includes(node.kind))
    if (unassigned.length) {
      graph.nodes.push({ id: 'organized:unclassified', title: 'Unorganized topics', kind: 'group', at: '', authority: 'unknown', evidence: 'No saved grouping for these records.' })
      for (const node of unassigned) attach(node, 'organized:unclassified')
    }
  } else if (!(data.focus?.presentationVersion === 1 || data.focus?.result.groups.some(group => group.cards !== undefined))) {
    const topics = projectTopics(data), groups = projectFocusGroups(topics, data.focus)
    for (const group of groups) {
      const members = graph.nodes.filter(node => !node.parentId && group.topics.some(topic => topic.key === node.id))
      if (!members.length) continue
      const id = `display-group:${group.key}`
      graph.nodes.push({ id, title: group.title || 'Unorganized topics', detail: group.purpose, kind: 'group', at: '', authority: group.inferred ? 'agent_interpretation' : 'unknown', evidence: group.inferred ? 'Existing saved interpretation only; not confirmed user intent.' : 'No saved grouping; no semantic inference added.' })
      for (const node of members) attach(node, id)
    }
  }
  if (!hierarchy && (data.focus?.presentationVersion === 1 || data.focus?.result.groups.some(group => group.cards !== undefined))) {
    const leftovers = graph.nodes.filter(node => !node.parentId && !node.id.startsWith('presentation:') && !['unavailable', 'decision', 'question', 'result'].includes(node.kind))
    if (leftovers.length) {
      graph.nodes.push({ id: 'organized:unclassified', title: 'Unorganized topics', kind: 'group', at: '', authority: 'unknown', evidence: 'Outside the saved organization window; no semantic inference added.' })
      for (const node of leftovers) attach(node, 'organized:unclassified')
    }
  }
  // Aggregate descendant activity and dispositions honestly; mixed is not complete.
  const aggregate = (node: OverviewNode, seen = new Set<string>()): OverviewNode[] => {
    if (seen.has(node.id)) return []
    seen.add(node.id)
    const children = graph.nodes.filter(child => child.parentId === node.id)
    return children.flatMap(child => [child, ...aggregate(child, seen)])
  }
  for (const node of graph.nodes.filter(node => node.kind === 'group' || node.id.startsWith('presentation:'))) {
    const descendants = aggregate(node)
    const dates = descendants.map(child => child.at).filter(at => Number.isFinite(Date.parse(at))).sort()
    node.at = dates.at(-1) ?? node.at
    const states = descendants.filter(child => child.kind !== 'group' && !child.id.startsWith('presentation:')).map(child => child.status ?? 'unknown')
    node.status = states.length ? states.every(state => state === states[0]) ? states[0] : 'mixed' : 'unknown'
  }
  return graph
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
/** Regions are presentation bounds, never persisted ownership or causal records. */
export function overviewLayout(graph: ReturnType<typeof overviewGraph>, expanded: ReadonlySet<string>, matches: (node: OverviewNode) => boolean = () => true) {
  const tree = overviewTree(graph), eligible = new Set<string>()
  for (const node of graph.nodes.filter(matches)) {
    let id: string | undefined = node.id
    while (id && !eligible.has(id)) { eligible.add(id); id = tree.parents.get(id) }
  }
  const nodes: OverviewNode[] = [], positions = new Map<string, { x: number; y: number }>()
  const regions: { id: string; owner: string; x: number; y: number; width: number; height: number }[] = []
  const membership = new Map<string, string>()
  const children = (node: OverviewNode) => expanded.has(node.id) ? (tree.children.get(node.id) ?? []).filter(child => eligible.has(child.id)) : []
  const sizes = new Map<string, { width: number; height: number; columns: number; cellWidth: number; cellHeight: number }>()
  function measure(node: OverviewNode) {
    const list = children(node), measured = list.map(measure)
    const columns = Math.min(3, Math.max(1, Math.ceil(Math.sqrt(list.length))))
    const cellWidth = Math.max(280, ...measured.map(size => size.width)), cellHeight = Math.max(112, ...measured.map(size => size.height))
    const size = { width: list.length ? columns * (cellWidth + 40) + 24 : 280,
      height: list.length ? 160 + Math.ceil(list.length / columns) * (cellHeight + 40) + 24 : 112, columns, cellWidth, cellHeight }
    sizes.set(node.id, size); return size
  }
  const activity = (node: OverviewNode): number => Math.max(Number.isFinite(Date.parse(node.at)) ? Date.parse(node.at) : -Infinity, ...(tree.children.get(node.id) ?? []).map(activity))
  const roots = tree.roots.filter(node => eligible.has(node.id)).sort((a,b) => activity(b) - activity(a) || 0)
  roots.forEach(measure)
  function place(node: OverviewNode, x: number, y: number, region?: string) {
    const size = sizes.get(node.id)!
    nodes.push(node); positions.set(node.id, { x: x + (size.width - 280) / 2, y })
    if (region) membership.set(node.id, region)
    const list = children(node)
    if (!list.length) return
    const id = `region:${node.id}`
    regions.push({ id, owner: node.id, x, y: y + 144, width: size.width, height: size.height - 144 })
    list.forEach((child, index) => place(child, x + 32 + (index % size.columns) * (size.cellWidth + 40) + (size.cellWidth - sizes.get(child.id)!.width) / 2,
      y + 176 + Math.floor(index / size.columns) * (size.cellHeight + 40), id))
  }
  let left = 16
  roots.forEach(root => { place(root, left, 16); left += sizes.get(root.id)!.width + 56 })
  const visible = new Set(nodes.map(node => node.id))
  // Hidden records project to their nearest disclosed owner. No link forces disclosure.
  function endpoint(id: string) {
    let cursor: string | undefined = id
    while (cursor && !visible.has(cursor)) cursor = tree.parents.get(cursor)
    if (!cursor) return undefined
    return membership.get(cursor) ?? cursor
  }
  const edges = graph.edges.flatMap(edge => {
    const fromVisible = visible.has(edge.from), toVisible = visible.has(edge.to)
    const fromRegion = membership.get(edge.from), toRegion = membership.get(edge.to)
    // Ownership is expressed once by the parent → region connector.
    if (edge.kind === 'hierarchy' && tree.parents.get(edge.to) === edge.from && expanded.has(edge.from)) return []
    if (fromVisible && toVisible && fromRegion === toRegion) return [{ ...edge, source: edge.from, target: edge.to }]
    const source = endpoint(edge.from), target = endpoint(edge.to)
    return source && target && source !== target ? [{ ...edge, source, target }] : []
  })
  return { nodes, edges, positions, regions, membership, children: tree.children, width: left, height: Math.max(144, ...roots.map(root => sizes.get(root.id)!.height + 32)) }
}
