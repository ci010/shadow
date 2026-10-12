import type { ProjectWorkItem, ProjectWorkOverview } from '../../src/projects/work-overview.ts'
import { workRoots, workCanvasRows } from './project-work.ts'

/** Only persisted work links group conversations. Session lineage is not topic segmentation. */
export function projectTopics(data: ProjectWorkOverview) {
  const roots = workRoots(data.items)
  const represented = new Set<string>()
  const topics = data.items.filter(item => roots.get(item.key) === item.key).map(root => {
    const members = data.items.filter(item => roots.get(item.key) === root.key)
    const allKeys = new Set(members.map(item => item.key))
    const items = workCanvasRows(members, allKeys, allKeys).map(row => row.item)
    const keys = new Set(items.map(item => item.key))
    const sessions = data.sessions.filter(session => keys.has(session.workKey ?? '') || items.some(item =>
      item.assignee === session.sessionId || item.observation?.sessionId === session.sessionId))
    sessions.forEach(session => represented.add(session.sessionId))
    return { key: root.key, title: root.title, root: root as ProjectWorkItem | undefined, items, sessions,
      changedAt: [root.changedAt, ...items.map(item => item.changedAt), ...sessions.map(session => session.lastActivityAt ?? '')].sort().at(-1) ?? '',
      fallback: false }
  })
  for (const session of data.sessions) if (!represented.has(session.sessionId)) topics.push({
    key: `session:${session.sessionId}`, title: session.title, root: undefined, items: [], sessions: [session],
    changedAt: session.lastActivityAt ?? '', fallback: true,
  })
  return topics.sort((a, b) => b.changedAt.localeCompare(a.changedAt) || a.key.localeCompare(b.key))
}

/** Tentative display grouping only: never writes work links or merges conversations. */
export function projectFocusGroups(topics: ReturnType<typeof projectTopics>, snapshot?: ProjectWorkOverview['focus']) {
  if (snapshot) {
    const assigned = new Set<string>()
    const groups = snapshot.result.groups.map((group, index) => {
      const members = topics.filter(topic => group.topicKeys.includes(topic.key))
      members.forEach(topic => assigned.add(topic.key))
      return { key: `organized:${index}`, title: group.category, purpose: group.purpose,
        motivation: group.motivation, inferred: true, changedAt: snapshot.inferredAt, topics: members,
        stale: members.some(topic => snapshot.sources.find(source => source.key === topic.key)?.sequence !== topic.root?.sequence) }
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
