import { t } from './i18n.ts'
import type { KnowledgeCatalog, KnowledgeDetail, KnowledgeEntry, KnowledgeKind, KnowledgeLink } from '../../src/knowledge/contracts.ts'
import { apiUrl } from './api-url.ts'
import { isRecord } from './folders-sidebar.ts'

import { isFileHistory, isKnowledgeDocument, visibleKnowledgeCatalog } from '../../src/knowledge/visibility.ts'
export { isFileHistory, isKnowledgeDocument, visibleKnowledgeCatalog }
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
  return visibleKnowledgeCatalog({ entries, links })
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
      throw Object.assign(new Error(response.status === 409
        ? t('Knowledge changed since it was loaded. Close this dialog, refresh or scan again, and review it before making changes.')
        : response.status === 401 || response.status === 403
          ? t('Knowledge management requires Main administrator access.')
          : response.status === 404
            ? t('This entry no longer exists. Refresh the knowledge list.')
            : response.status === 413
              ? t('The knowledge collection exceeds the browsing limits. Reduce its size before retrying.')
              : response.status === 422
                ? t('Knowledge contains invalid data. Check the project log and fix the reported file before scanning again.')
              : t('Main could not complete the knowledge request ({status}). Refresh and retry.', { status: response.status })), { status: response.status })
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
  return catalog.entries.filter(item => isKnowledgeDocument(item) && (kind === 'all' || item.kind === kind)
    && terms.every(term => `${item.title} ${item.path} ${item.description ?? ''}`.toLocaleLowerCase().includes(term)))
}

export function knowledgeRelations(catalog: KnowledgeCatalog, id: string) {
  catalog = visibleKnowledgeCatalog(catalog)
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
  const hidden = new Set(catalog.entries.filter(entry => !isKnowledgeDocument(entry)).map(entry => entry.id))
  catalog = visibleKnowledgeCatalog(catalog)
  const visible = new Set(visibleIds.filter(id => !isFileHistory(id) && !hidden.has(id)))
  const links = catalog.links.filter(link => visible.has(link.source) || visible.has(link.target))
  const included = new Set([...visible, ...links.flatMap(link => [link.source, link.target])])
  const entries = new Map(catalog.entries.map(item => [item.id, item]))
  // Stable golden-angle seeds and a bounded relaxation: no random state, timers,
  // or category forces. Only explicit references attract nodes (O(160*n²)).
  const nodes: KnowledgeGraphNode[] = [...included].sort().map((id, index) => {
    const item = entries.get(id), angle = index * 2.399963229728653
    const radius = 30 * Math.sqrt(index + 1)
    return { id, title: item?.title ?? id, kind: item?.kind ?? 'missing', x: Math.cos(angle) * radius, y: Math.sin(angle) * radius }
  })
  const indices = new Map(nodes.map((node, index) => [node.id, index]))
  const pairs = links.map(link => [indices.get(link.source)!, indices.get(link.target)!] as const)
  for (let iteration = 0; iteration < 160; iteration++) {
    const forces = nodes.map(node => ({ x: -node.x * .008, y: -node.y * .008 }))
    for (let a = 0; a < nodes.length; a++) for (let b = a + 1; b < nodes.length; b++) {
      const dx = nodes[a]!.x - nodes[b]!.x, dy = nodes[a]!.y - nodes[b]!.y
      const distance = Math.max(1, Math.hypot(dx, dy)), force = 1000 / (distance * distance)
      forces[a]!.x += dx * force; forces[a]!.y += dy * force
      forces[b]!.x -= dx * force; forces[b]!.y -= dy * force
    }
    for (const [a, b] of pairs) {
      if (a === b) continue
      const dx = nodes[b]!.x - nodes[a]!.x, dy = nodes[b]!.y - nodes[a]!.y
      const distance = Math.max(1, Math.hypot(dx, dy)), force = (distance - 85) / distance * .035
      forces[a]!.x += dx * force; forces[a]!.y += dy * force
      forces[b]!.x -= dx * force; forces[b]!.y -= dy * force
    }
    const step = 10 * (1 - iteration / 160) + .2
    nodes.forEach((node, index) => {
      const force = forces[index]!, length = Math.max(1, Math.hypot(force.x, force.y))
      node.x += force.x / length * Math.min(step, length)
      node.y += force.y / length * Math.min(step, length)
    })
  }
  const minX = Math.min(0, ...nodes.map(node => node.x)) - 60, minY = Math.min(0, ...nodes.map(node => node.y)) - 60
  const width = Math.max(240, Math.max(0, ...nodes.map(node => node.x)) - minX + 60)
  const height = Math.max(240, Math.max(0, ...nodes.map(node => node.y)) - minY + 60)
  nodes.forEach(node => { node.x -= minX; node.y -= minY })
  return { nodes, links, width, height }
}
