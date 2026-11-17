import type { KnowledgeCatalog, KnowledgeEntry } from './contracts.ts'

/** Edit ledgers are retained history, never Knowledge documents. */
export function isFileHistory(id: string): boolean {
  return /^memory\/sessions\/[^/]+\.files\.jsonl$/.test(id.replace(/\\/g, '/').replace(/^v:/, ''))
}

export function isKnowledgeDocument(entry: Pick<KnowledgeEntry, 'id' | 'path'>): boolean {
  return !isFileHistory(entry.id) && !isFileHistory(entry.path)
}

/** Also project old client catalogs; do not turn hidden targets into graph ghosts. */
export function visibleKnowledgeCatalog(catalog: KnowledgeCatalog): KnowledgeCatalog {
  const hidden = new Set(catalog.entries.filter(entry => !isKnowledgeDocument(entry)).map(entry => entry.id))
  const visible = (id: string) => !hidden.has(id) && !isFileHistory(id)
  return {
    entries: catalog.entries.filter(isKnowledgeDocument),
    links: catalog.links.filter(link => visible(link.source) && visible(link.target)),
  }
}
