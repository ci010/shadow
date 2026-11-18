import { agentDefinitionId, botDocumentId } from './knowledge-definitions.ts'
import type { AgentTypeMeta } from './agent-types.ts'
import { isKnowledgeDocument, type KnowledgeEntry } from './knowledge.ts'

export interface KnowledgeTreeNode {
  id: string
  label: string
  entry?: Pick<KnowledgeEntry, 'path'>
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

/** These folders are views of their own resource owners, not Wiki entries. */
export function definitionTree(agents: readonly AgentTypeMeta[], bots: readonly { id: string; paths: string[] }[], query: string): KnowledgeTreeNode[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  const matches = (text: string) => terms.every(term => text.toLocaleLowerCase().includes(term))
  const agentRoot: KnowledgeTreeNode = { id: 'agents', label: 'Agents', children: [] }
  const botRoot: KnowledgeTreeNode = { id: 'bots', label: 'Bots', children: [] }
  function folder(parent: KnowledgeTreeNode, label: string) {
    const id = `${parent.id}/${label}`
    let node = parent.children.find(child => !child.entry && child.id === id)
    if (!node) parent.children.push(node = { id, label, children: [] })
    return node
  }
  for (const agent of agents) {
    const path = `${agent.name}/AGENT.md`
    const source = agent.source === 'builtin' ? 'Built-in' : 'Workspace'
    if (!matches(`${path} ${agent.description} ${source}`)) continue
    folder(agentRoot, source).children.push({ id: agentDefinitionId(agent.name), label: agent.name, entry: { path }, children: [] })
  }
  for (const bot of bots) for (const path of bot.paths) {
    if (!matches(`${bot.id}/${path}`)) continue
    const parts = path.split('/')
    const label = parts.pop()!
    const parent = parts.reduce(folder, folder(botRoot, bot.id))
    parent.children.push({ id: botDocumentId(bot.id, path), label, entry: { path: `${bot.id}/${path}` }, children: [] })
  }
  return [agentRoot, botRoot]
}
