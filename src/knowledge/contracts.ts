export type KnowledgeKind = 'memory' | 'wiki' | 'skill'

export interface KnowledgeEntry {
  id: string
  kind: KnowledgeKind
  title: string
  path: string
  source: 'project' | 'builtin'
  deletable: boolean
  description?: string
  revision: string
}

export interface KnowledgeLink {
  source: string
  target: string
  label: string
}

export interface KnowledgeCatalog {
  entries: KnowledgeEntry[]
  links: KnowledgeLink[]
}

export interface KnowledgeDetail {
  entry: KnowledgeEntry
  content: string
}
