import { t } from './i18n.ts'
import type { ProjectWorkItem, ProjectWorkOverview } from '../../src/projects/work-overview.ts'
import type { WorkNotes } from '../../src/initiatives/work-notes.ts'

export function relationLabel(kind: 'supports' | 'requires' | 'assumption') {
  return { supports: t('Chosen approach'), requires: t('Required dependency'), assumption: t('Unverified assumption') }[kind]
}
export function workKind(kind: WorkNotes['kind']) {
  return { goal: t('Goal'), approach: t('Approach'), task: t('Task'), finding: t('Finding') }[kind]
}
export function workPath(items: readonly ProjectWorkItem[], key: string): ProjectWorkItem[] {
  const lookup = new Map(items.map(item => [item.key, item])), path: ProjectWorkItem[] = [], seen = new Set<string>()
  let current = lookup.get(key)
  while (current) {
    if (seen.has(current.key)) throw new Error(t('Work hierarchy contains a cycle.'))
    seen.add(current.key); path.unshift(current)
    current = current.parentKey ? lookup.get(current.parentKey) : undefined
  }
  return path
}
export function workCanvasRows(items: readonly ProjectWorkItem[], matches: ReadonlySet<string>, expanded: ReadonlySet<string>) {
  const lookup = new Map(items.map(item => [item.key, item]))
  const included = new Set<string>()
  for (const key of matches) {
    let current = lookup.get(key)
    const seen = new Set<string>()
    while (current) {
      if (seen.has(current.key)) throw new Error(t('Work hierarchy contains a cycle.'))
      seen.add(current.key); included.add(current.key)
      current = current.parentKey ? lookup.get(current.parentKey) : undefined
    }
  }
  const children = new Map<string, ProjectWorkItem[]>()
  for (const item of items) if (included.has(item.key)) {
    const parent = item.parentKey && lookup.has(item.parentKey) ? item.parentKey : ''
    children.set(parent, [...children.get(parent) ?? [], item])
  }
  const result: { item: ProjectWorkItem; depth: number; children: number; contextOnly: boolean }[] = []
  const stack = (children.get('') ?? []).map(item => ({ item, depth: 0 })).reverse()
  while (stack.length) {
    const row = stack.pop()!, descendants = children.get(row.item.key) ?? []
    result.push({ ...row, children: descendants.length, contextOnly: !matches.has(row.item.key) })
    if (expanded.has(row.item.key)) stack.push(...descendants.map(item => ({ item, depth: row.depth + 1 })).reverse())
  }
  return result
}

export const workColumns = [
  { status: 'pending', get label() { return t('Pending') } }, { status: 'in_progress', get label() { return t('In progress') } },
  { status: 'blocked', get label() { return t('Blocked') } }, { status: 'done', get label() { return t('Done') } },
  { status: 'cancelled', get label() { return t('Cancelled') } }, { status: null, get label() { return t('Historical') } },
] as const
export function workStatus(item: ProjectWorkItem): string {
  return workColumns.find(column => column.status === item.status)!.label
}
export function workRoots(items: ProjectWorkItem[]): Map<string, string> {
  const lookup = new Map(items.map(item => [item.key, item]))
  const roots = new Map<string, string>()
  for (const item of items) {
    let current = item
    const seen = new Set<string>()
    while (current.parentKey && lookup.has(current.parentKey)) {
      if (seen.has(current.key)) throw new Error(t('Work hierarchy contains a cycle. Reload the Project work view.'))
      seen.add(current.key)
      current = lookup.get(current.parentKey)!
    }
    roots.set(item.key, current.key)
  }
  return roots
}
export function filterWork(items: ProjectWorkItem[], filter: { query: string; root: string; assignee: string; terminal: boolean }) {
  const roots = workRoots(items)
  const query = filter.query.trim().toLowerCase()
  return items.filter(item => (filter.terminal || !['done', 'cancelled'].includes(item.status ?? ''))
    && (!filter.root || roots.get(item.key) === filter.root)
    && (!filter.assignee || (filter.assignee === 'unassigned' ? item.assignee === null : item.assignee === filter.assignee))
    && (!query || `${item.title} ${item.key} ${item.objective ?? ''} ${item.notes?.summary ?? ''}`.toLowerCase().includes(query)))
}
export function groupWork(items: ProjectWorkItem[], all: ProjectWorkItem[]) {
  const roots = workRoots(all)
  const initiatives = new Set(all.filter(item => item.parentKey).map(item => roots.get(item.key)!))
  const groups = new Map<string, ProjectWorkItem[]>()
  for (const item of items) {
    const root = roots.get(item.key)!
    const key = initiatives.has(root) ? root : 'standalone'
    const group = groups.get(key) ?? []
    group.push(item)
    groups.set(key, group)
  }
  return [...groups].map(([key, items]) => ({
    key, title: key === 'standalone' ? t('Independent work') : all.find(item => item.key === key)!.title, items,
    initiative: key !== 'standalone',
  }))
}
export function workAttention(data: ProjectWorkOverview) {
  return data.items.filter(item => item.contextChanged || item.notes?.attention && !item.notes.attention.reviewed)
}

export function workGraph(items: ProjectWorkItem[]) {
  const lookup = new Map(items.map(item => [item.key, item]))
  const depths = new Map<string, number>()
  function depth(item: ProjectWorkItem, seen = new Set<string>()): number {
    if (depths.has(item.key)) return depths.get(item.key)!
    if (seen.has(item.key)) throw new Error(t('Work hierarchy contains a cycle.'))
    seen.add(item.key)
    const parent = item.parentKey ? lookup.get(item.parentKey) : undefined
    const level = parent ? depth(parent, seen) + 1 : 0
    depths.set(item.key, level)
    return level
  }
  const rows = new Map<number, number>()
  const nodes = items.map(item => {
    const level = depth(item), row = rows.get(level) ?? 0
    rows.set(level, row + 1)
    return { item, x: 24 + level * 310, y: 24 + row * 180 }
  })
  const positions = new Map(nodes.map(node => [node.item.key, node]))
  const edges = items.flatMap(item => [
    ...(item.parentKey ? [{ from: item.parentKey, to: item.key, kind: 'child' as const }] : []),
    ...item.dependencies.map(from => ({ from, to: item.key, kind: 'dependency' as const })),
  ]).filter(edge => positions.has(edge.from) && positions.has(edge.to)).map(edge => {
    const from = positions.get(edge.from)!, to = positions.get(edge.to)!
    const x1 = from.x + 256, y1 = from.y + 68, x2 = to.x, y2 = to.y + 68
    if (from.x === to.x) return { ...edge, path: `M ${x1} ${y1} C ${x1 + 32} ${y1}, ${x1 + 32} ${y2}, ${x1} ${y2}` }
    return { ...edge, path: `M ${x1} ${y1} C ${x1 + 34} ${y1}, ${x2 - 34} ${y2}, ${x2} ${y2}` }
  })
  const outside = items.reduce((count, item) => count + item.dependencies.filter(key => !lookup.has(key)).length
    + (item.parentKey && !lookup.has(item.parentKey) ? 1 : 0), 0)
  return { nodes, edges, outside,
    width: Math.max(304, ...nodes.map(node => node.x + 280)),
    height: Math.max(200, ...nodes.map(node => node.y + 166)) }
}
