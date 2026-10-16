import type { ProjectWorkItem, ProjectWorkOverview } from '../../src/projects/work-overview.ts'
import { workRoots, workCanvasRows } from './project-work.ts'

/** Only persisted work links group conversations. Session lineage is not topic segmentation. */
export type ProjectTopic = { key: string; title: string; root: ProjectWorkItem | undefined; items: ProjectWorkItem[]; sessions: ProjectWorkOverview['sessions']; changedAt: string; fallback: boolean }
export function projectTopics(data: ProjectWorkOverview): ProjectTopic[] {
  if (data.focus?.presentationVersion === 1 || data.focus?.result.groups.some(group => group.cards !== undefined)) {
    const presented = data.focus.result.groups.flatMap((group, index) => {
    const items = data.items.filter(item => group.topicKeys.includes(item.key))
    const ids = new Set((group.cards ?? []).flatMap(card => card.sources.map(source => source.sessionId)))
    return [{ key: `presentation:${index}`, title: group.category, root: undefined as ProjectWorkItem | undefined,
      items, sessions: data.sessions.filter(session => session.assignable && ids.has(session.sessionId)),
      changedAt: [...items.map(item => item.changedAt), ...data.sessions.filter(session => ids.has(session.sessionId)).map(session => session.lastActivityAt ?? '')].filter(at => Number.isFinite(Date.parse(at))).sort().at(-1) ?? data.focus!.inferredAt, fallback: false }]
    })
    const cited = new Set(data.focus.result.groups.flatMap(group => group.topicKeys))
    const sessions = new Set(data.focus.result.groups.flatMap(group => group.cards?.flatMap(card => card.sources.map(source => source.sessionId)) ?? []))
    return [...presented, ...projectTopics({ ...data, focus: undefined }).filter(topic => !cited.has(topic.key) && !(topic.fallback && topic.sessions.some(session => sessions.has(session.sessionId))))]
  }
  const roots = workRoots(data.items)
  const represented = new Set<string>()
  const topics = data.items.filter(item => roots.get(item.key) === item.key).map(root => {
    const members = data.items.filter(item => roots.get(item.key) === root.key)
    const allKeys = new Set(members.map(item => item.key))
    const items = workCanvasRows(members, allKeys, allKeys).map(row => row.item)
    const keys = new Set(items.map(item => item.key))
    const sessions = data.sessions.filter(session => keys.has(session.workKey ?? '') || session.workKeys?.some(key => keys.has(key)) || items.some(item =>
      item.assignee === session.sessionId || item.observation?.sessionId === session.sessionId))
    sessions.forEach(session => represented.add(session.sessionId))
    return { key: root.key, title: root.title, root: root as ProjectWorkItem | undefined, items, sessions,
      changedAt: [root.changedAt, ...items.map(item => item.changedAt), ...sessions.map(session => session.lastActivityAt ?? '')].sort().at(-1) ?? '',
      fallback: false }
  })
  for (const session of data.sessions) if (session.assignable && !represented.has(session.sessionId)) topics.push({
    key: `session:${session.sessionId}`, title: session.title, root: undefined, items: [], sessions: [session],
    changedAt: session.lastActivityAt ?? '', fallback: true,
  })
  return topics.sort((a, b) => b.changedAt.localeCompare(a.changedAt) || a.key.localeCompare(b.key))
}

/** Tentative display grouping only: never writes work links or merges conversations. */
export function projectFocusGroups(topics: ReturnType<typeof projectTopics>, snapshot?: ProjectWorkOverview['focus']) {
  if (snapshot?.result.hierarchy) {
    const hierarchy = snapshot.result.hierarchy
    const descendants = (id: string): typeof hierarchy => hierarchy.filter(node => node.parentId === id).flatMap(node => [node, ...descendants(node.id)])
    const assigned = new Set<string>()
    const groups = hierarchy.filter(node => !node.parentId).map(node => {
      const indexes = [node, ...descendants(node.id)].flatMap(child => child.groupIndexes)
      const members = topics.filter(topic => indexes.some(index => topic.key === `presentation:${index}` || snapshot.result.groups[index]?.topicKeys.includes(topic.key)))
      members.forEach(topic => assigned.add(topic.key))
      return { key: `organized-hierarchy:${node.id}`, title: node.title, purpose: node.purpose, motivation: '', inferred: true,
        changedAt: members.map(topic => topic.changedAt).sort().at(-1) ?? '', topics: members,
        stale: members.some(topic => topic.items.some(item => snapshot.sources.find(source => source.key === item.key)?.sequence !== item.sequence)) }
    })
    const unclassified = topics.filter(topic => !assigned.has(topic.key))
    if (unclassified.length) groups.push({ key: 'organized:unclassified', title: '', purpose: '', motivation: '', inferred: false, changedAt: '', topics: unclassified, stale: false })
    return groups.sort((a, b) => b.changedAt.localeCompare(a.changedAt))
  }
  if (snapshot) {
    const assigned = new Set<string>()
    const groups = snapshot.result.groups.map((group, index) => {
      const members = topics.filter(topic => group.topicKeys.includes(topic.key) || group.cards !== undefined && topic.key === `presentation:${index}`)
      members.forEach(topic => assigned.add(topic.key))
      return { key: `organized:${index}`, title: group.category, purpose: group.purpose,
        motivation: group.motivation, inferred: true, changedAt: snapshot.inferredAt, topics: members,
        stale: members.some(topic => group.cards !== undefined
          ? topic.items.some(item => snapshot.sources.find(source => source.key === item.key)?.sequence !== item.sequence)
          : snapshot.sources.find(source => source.key === topic.key)?.sequence !== topic.root?.sequence) }
    }).filter(group => group.topics.length)
    const unclassified = topics.filter(topic => !assigned.has(topic.key))
    if (unclassified.length) groups.push({ key: 'unclassified', title: '', purpose: '', motivation: '', inferred: false,
      changedAt: '', topics: unclassified, stale: false })
    return groups
  }
  type Topic = typeof topics[number]
  const groups = new Map<string, { key: string; title: string; purpose: string; inferred: boolean; changedAt: string; topics: Topic[]; motivation: string; stale: boolean }>()
  for (const topic of topics) {
    const focus = topic.root?.observation?.focus
    const key = focus ? `inferred:${focus.category.normalize('NFKC').trim().toLocaleLowerCase()}` : 'unclassified'
    let group = groups.get(key)
    if (!group) {
      group = { key, title: focus?.category ?? '', purpose: focus?.purpose ?? '', inferred: !!focus, changedAt: topic.changedAt, topics: [], motivation: focus?.motivation ?? '', stale: false }
      groups.set(key, group)
    }
    // The newest topic supplies a labelled interpretation, not a synthesized consensus.
    if (topic.changedAt > group.changedAt) {
      group.changedAt = topic.changedAt
      group.title = focus?.category ?? ''
      group.purpose = focus?.purpose ?? ''
      group.motivation = focus?.motivation ?? ''
    }
    group.topics.push(topic)
  }
  return [...groups.values()].map(group => ({ ...group, topics: group.topics.sort((a, b) => b.changedAt.localeCompare(a.changedAt)) }))
    .sort((a, b) => Number(b.inferred) - Number(a.inferred) || b.changedAt.localeCompare(a.changedAt) || a.key.localeCompare(b.key))
}
