import { t } from './i18n.ts'
import type { KnowledgeCatalog, KnowledgeDetail, KnowledgeEntry, KnowledgeKind, KnowledgeLink } from '../../src/knowledge/contracts.ts'
import { apiUrl } from './api-url.ts'
import { isRecord } from './folders-sidebar.ts'

export type { KnowledgeCatalog, KnowledgeDetail, KnowledgeEntry, KnowledgeKind, KnowledgeLink }

const invalid = () => new Error(t('Main returned invalid knowledge data. Refresh and retry.'))
function entry(value: unknown): KnowledgeEntry {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id
    || (value.kind !== 'memory' && value.kind !== 'wiki' && value.kind !== 'skill')
    || typeof value.title !== 'string' || typeof value.path !== 'string'
    || (value.source !== 'project' && value.source !== 'builtin')
    || typeof value.deletable !== 'boolean' || (value.source === 'builtin' && value.deletable)
    || typeof value.revision !== 'string' || !value.revision
    || (value.description !== undefined && typeof value.description !== 'string')) throw invalid()
  return {
    id: value.id, kind: value.kind, title: value.title, path: value.path,
    source: value.source, deletable: value.deletable, revision: value.revision,
    ...(typeof value.description === 'string' ? { description: value.description } : {}),
  }
}

export function parseKnowledgeCatalog(value: unknown): KnowledgeCatalog {
  if (!isRecord(value) || !Array.isArray(value.entries) || !Array.isArray(value.links)) throw invalid()
  const entries = value.entries.map(entry)
  const ids = new Set(entries.map(item => item.id))
  if (ids.size !== entries.length) throw invalid()
  const links = value.links.map((link): KnowledgeLink => {
    if (!isRecord(link) || typeof link.source !== 'string' || !ids.has(link.source)
      || typeof link.target !== 'string' || !link.target || typeof link.label !== 'string'
      || (link.href !== undefined && (typeof link.href !== 'string' || !link.href))) throw invalid()
    return {
      source: link.source, target: link.target, label: link.label,
      ...(typeof link.href === 'string' ? { href: link.href } : {}),
    }
  })
  return { entries, links }
}

export function createKnowledgeTransport(base: string, request: typeof fetch = fetch) {
  return async (path: string, init: RequestInit = {}, params?: Record<string, string>): Promise<unknown> => {
    let response: Response
    try {
      response = await request(apiUrl(base, `/api/knowledge${path}`, params), {
        ...init, headers: { 'Content-Type': 'application/json' },
        signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
      })
    } catch (error) {
      if (init.signal?.aborted) throw error
      throw new Error(t('Cannot reach Main. Refresh before retrying; a change may already have completed.'))
    }
    if (!response.ok) {
      throw new Error(response.status === 409
        ? t('Knowledge changed since it was loaded. Close this dialog, refresh or scan again, and review it before making changes.')
        : response.status === 401 || response.status === 403
          ? t('Knowledge management requires Main administrator access.')
          : response.status === 404
            ? t('This entry no longer exists. Refresh the knowledge list.')
            : response.status === 413
              ? t('The knowledge collection exceeds the browsing limits. Reduce its size before retrying.')
              : response.status === 422
                ? t('Knowledge contains invalid data. Check the project log and fix the reported file before scanning again.')
              : t('Main could not complete the knowledge request ({status}). Refresh and retry.', { status: response.status }))
    }
    try { return await response.json() } catch { throw invalid() }
  }
}

export function createKnowledgeClient(base: string, request: typeof fetch = fetch) {
  const json = createKnowledgeTransport(base, request)
  return {
    async list(signal?: AbortSignal): Promise<KnowledgeCatalog> {
      return parseKnowledgeCatalog(await json('', { signal }))
    },
    async read(id: string, signal?: AbortSignal): Promise<KnowledgeDetail> {
      const data = await json('/entry', { signal }, { id })
      if (!isRecord(data) || typeof data.content !== 'string') throw invalid()
      const item = entry(data.entry)
      if (item.id !== id) throw invalid()
      return { entry: item, content: data.content }
    },
    async remove(item: KnowledgeEntry, signal?: AbortSignal): Promise<void> {
      const data = await json('/entry', {
        method: 'DELETE', body: JSON.stringify({ id: item.id, revision: item.revision }), signal,
      })
      if (!isRecord(data) || data.deleted !== item.id) throw invalid()
    },
  }
}

export function filterKnowledge(catalog: KnowledgeCatalog, kind: KnowledgeKind | 'all', query: string): KnowledgeEntry[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  return catalog.entries.filter(item => (kind === 'all' || item.kind === kind)
    && terms.every(term => `${item.title} ${item.path} ${item.description ?? ''}`.toLocaleLowerCase().includes(term)))
}

export function knowledgeRelations(catalog: KnowledgeCatalog, id: string) {
  return {
    incoming: catalog.links.filter(link => link.target === id),
    outgoing: catalog.links.filter(link => link.source === id),
  }
}

export interface KnowledgeGraphNode {
  id: string
  title: string
  kind: KnowledgeKind | 'missing'
  x: number
  y: number
}

export function layoutKnowledgeGraph(catalog: KnowledgeCatalog, visibleIds: readonly string[]) {
  const visible = new Set(visibleIds)
  const links = catalog.links.filter(link => visible.has(link.source) || visible.has(link.target))
  const included = new Set([...visible, ...links.flatMap(link => [link.source, link.target])])
  const entries = new Map(catalog.entries.map(item => [item.id, item]))
  const columns = ['memory', 'wiki', 'skill', 'missing'] as const
  const counts = [0, 0, 0, 0]
  const nodes: KnowledgeGraphNode[] = [...included].sort().map(id => {
    const item = entries.get(id)
    const kind = item?.kind ?? 'missing'
    const column = columns.indexOf(kind)
    return { id, title: item?.title ?? id, kind, x: 20 + column * 280, y: 52 + counts[column]!++ * 76 }
  })
  return { nodes, links, width: 1120, height: Math.max(260, 70 + Math.max(...counts) * 76) }
}
