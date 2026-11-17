import { isKnowledgeDocument, type KnowledgeEntry } from './knowledge.ts'

export interface KnowledgeTreeNode {
  id: string
  label: string
  entry?: KnowledgeEntry
  children: KnowledgeTreeNode[]
}
/** Only catalog entries are roots/leaves; reference targets never become files. */
export function knowledgeTree(entries: readonly KnowledgeEntry[]): KnowledgeTreeNode[] {
  const roots: KnowledgeTreeNode[] = []
  for (const kind of ['wiki', 'memory', 'skill'] as const) {
    const root: KnowledgeTreeNode = { id: kind, label: kind === 'wiki' ? 'Wiki' : kind === 'memory' ? 'Memory' : 'Skills', children: [] }
    roots.push(root)
    for (const entry of entries.filter(item => isKnowledgeDocument(item) && item.kind === kind)) {
      let parent = root
      const path = entry.path.replace(/^(?:v:)?(memory|skills)\//, '').split('/').filter(Boolean)
      const folders = [...(kind === 'skill' ? [entry.source === 'builtin' ? 'Built-in' : 'Project'] : []), ...path.slice(0, -1)]
      for (const label of folders) {
        const id = `${parent.id}/${label}`
        let child = parent.children.find(item => !item.entry && item.id === id)
        if (!child) { child = { id, label, children: [] }; parent.children.push(child) }
        parent = child
      }
      parent.children.push({ id: entry.id, label: entry.title, entry, children: [] })
    }
  }
  function sort(nodes: KnowledgeTreeNode[]) {
    nodes.sort((a, b) => Number(!!a.entry) - Number(!!b.entry) || a.label.localeCompare(b.label))
    for (const node of nodes) sort(node.children)
  }
  for (const root of roots) sort(root.children)
  return roots
}
