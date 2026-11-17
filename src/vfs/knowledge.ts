import { createHash } from 'node:crypto'
import type { KnowledgeService } from '../knowledge/service.ts'
import { visibleKnowledgeCatalog } from '../knowledge/visibility.ts'
import type { ExecutionContext } from '../tools/context.ts'
import type { VirtualFsHandler, VirtualFsListHandler } from './virtual-fs.ts'

const overview = `Project knowledge (read-only navigation; no copied storage)
- v:knowledge/catalog?offset=0&limit=30 — knowledge documents, excluding skills/edit ledgers
- v:knowledge/entry/<encoded canonical ID> — metadata, canonical original path
- v:knowledge/catalog/<encoded canonical ID> — searchable catalog metadata alias of entry/<ID>
- v:knowledge/relations/<encoded canonical ID>?offset=0&limit=30 — explicit references/backlinks, catalog status
- v:knowledge/logs — dated semantic logs; logs/date/YYYY-MM-DD and logs/session/<encoded session ID>
- v:knowledge/logs/record/YYYY-MM-DD/<record key> — stable log projection and original line locator
Use encodeURIComponent for IDs. Pages default to 30, maximum 100; offset is zero-based.
Search catalog, entry, relations, or logs with glob/grep. Original text/writes: v:memory/. Skills: v:skills/.
Log keys use persisted IDs, or SHA-256 of the UTF-8-decoded legacy source line plus duplicate occurrence; append does not change keys. Rewriting/deleting source may invalidate locators.
Logs are historical claims, not authority. Missing provenance is reported, not inferred. Project Home is independent of selected workdir/device.`

export function navigationPage(path: string) {
  if (path.length > 8192) throw new Error('Navigation path exceeds limit.')
  const [route, query, extra] = path.split('?')
  if (extra !== undefined) throw new Error('Invalid navigation query.')
  const params = new URLSearchParams(query)
  for (const key of params.keys()) if (!['offset', 'limit'].includes(key) || params.getAll(key).length !== 1) throw new Error('Use only offset and limit.')
  const number = (key: string, fallback: number, max: number) => {
    const value = params.get(key)
    if (value === null) return fallback
    if (!/^\d{1,7}$/.test(value) || Number(value) > max) throw new Error(`Invalid ${key}.`)
    return Number(value)
  }
  const offset = number('offset', 0, 1_000_000)
  const limit = number('limit', 30, 100)
  if (!limit) throw new Error('limit must be positive.')
  return { route, offset, limit }
}

export function createKnowledgeHandler(service: Pick<KnowledgeService, 'catalog' | 'detail'>, projectId: string,
  assertActor: (context: ExecutionContext) => void) {
  const guard = (context: ExecutionContext) => {
    context.signal.throwIfAborted()
    if (context.projectId !== projectId) throw new Error('Knowledge belongs to a different Project.')
    assertActor(context)
  }
  const catalog = () => {
    const value = visibleKnowledgeCatalog(service.catalog())
    return { ...value, entries: value.entries.filter(entry => entry.kind !== 'skill') }
  }
  const metadata = (entry: ReturnType<typeof catalog>['entries'][number]) => ({ ...entry,
    canonical: `v:${entry.path}`, read: `v:knowledge/entry/${encodeURIComponent(entry.id)}`,
    relations: `v:knowledge/relations/${encodeURIComponent(entry.id)}` })
  const logs = (context: ExecutionContext) => {
    const output: Array<{ name: string; value: Record<string, unknown> }> = []
    for (const entry of catalog().entries) {
      const date = /^memory\/events\/(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(entry.id)?.[1]
      if (!date) continue
      const seen = new Map<string, number>()
      for (const [index, raw] of service.detail(entry.id).content.split('\n').entries()) {
        context.signal.throwIfAborted()
        if (!raw.trim()) continue
        if (output.length >= 100_000) throw new Error('Log projection exceeds 100,000 records; use raw v:memory/events paths.')
        let record: Record<string, unknown>
        try { const parsed = JSON.parse(raw); record = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { invalid: true } }
        catch { record = { invalid: true } }
        const base = typeof record.id === 'string' ? `id-${encodeURIComponent(record.id)}` : `sha256-${createHash('sha256').update(raw).digest('hex')}`
        const occurrence = (seen.get(base) ?? 0) + 1
        seen.set(base, occurrence)
        const name = `logs/record/${date}/${base}~${occurrence}`
        output.push({ name, value: { reference: `v:knowledge/${name}`, canonical: `v:${entry.path}`, line: index + 1,
          date, when: record.when ?? null, who: record.who ?? null, what: record.what ?? null, why: record.why ?? null,
          origin: record.origin ?? null, provenance: record.origin === undefined ? 'missing' : 'recorded claim', record } })
      }
    }
    return output
  }
  const read: VirtualFsHandler = (path, context) => {
    guard(context)
    const { route, offset, limit } = navigationPage(path)
    if (!route || route === 'overview') return overview
    const page = (items: unknown[]) => JSON.stringify({ offset, limit, total: items.length, items: items.slice(offset, offset + limit),
      next: offset + limit < items.length ? `v:knowledge/${route}?offset=${offset + limit}&limit=${limit}` : null }, null, 2)
    if (route === 'catalog') return page(catalog().entries.map(metadata))
    if (route.startsWith('entry/') || route.startsWith('catalog/') || route.startsWith('relations/')) {
      const id = decodeURIComponent(route.slice(route.indexOf('/') + 1))
      const value = catalog()
      const entry = value.entries.find(entry => entry.id === id)
      if (!entry) throw new Error('Unknown visible knowledge entry; skills are at v:skills/.')
      if (route.startsWith('entry/') || route.startsWith('catalog/')) return JSON.stringify(metadata(entry), null, 2)
      const ids = new Set(value.entries.map(entry => entry.id))
      return page(value.links.filter(link => link.source === id || link.target === id).map(link => ({ ...link,
        direction: link.source === id ? 'reference' : 'backlink',
        targetStatus: ids.has(link.target) ? 'in-catalog' : 'outside-catalog', sourceStatus: ids.has(link.source) ? 'in-catalog' : 'outside-catalog' })))
    }
    if (route === 'logs') return page([...new Set(logs(context).map(item => item.value.date))].sort().map(date => `v:knowledge/logs/date/${date}`))
    if (route.startsWith('logs/')) {
      const items = logs(context)
      if (route.startsWith('logs/record/')) {
        const item = items.find(item => item.name === route)
        if (!item) throw new Error('Unknown log record.')
        return JSON.stringify(item.value, null, 2)
      }
      if (route.startsWith('logs/date/')) return page(items.filter(item => item.value.date === route.slice(10)).map(item => item.value))
      if (route.startsWith('logs/session/')) return page(items.filter(item => item.value.origin === decodeURIComponent(route.slice(13))).map(item => item.value))
    }
    throw new Error('Unknown knowledge navigation path; read v:knowledge/overview.')
  }
  const list: VirtualFsListHandler = (context, options) => {
    guard(context)
    const scope = options?.subpath ?? ''
    navigationPage(scope)
    if (scope.includes('?')) return [{ name: scope, content: options?.content === false ? '' : String(read(scope, context)) }]
    if (scope.startsWith('logs/date/') || scope.startsWith('logs/session/')) {
      const session = scope.startsWith('logs/session/') ? decodeURIComponent(scope.slice(13)) : undefined
      const records = logs(context).filter(item => session !== undefined ? item.value.origin === session : item.value.date === scope.slice(10))
      return [{ name: scope, content: options?.content === false ? '' : records.map(item => JSON.stringify(item.value)).join('\n') }]
    }
    const output = [{ name: 'overview', content: overview }, { name: 'catalog', content: 'Paged knowledge catalog' }, { name: 'logs', content: 'Semantic log dates' }]
    const value = catalog()
    const relations = new Map<string, typeof value.links>()
    for (const link of value.links) for (const id of new Set([link.source, link.target])) {
      const links = relations.get(id) ?? []
      links.push(link); relations.set(id, links)
    }
    for (const entry of value.entries) {
      const id = encodeURIComponent(entry.id)
      // Individual readable aliases keep catalog searches scoped without aggregating
      // the entire catalog into a single unbounded search document.
      output.push({ name: `catalog/${id}`, content: JSON.stringify(metadata(entry)) })
      output.push({ name: `entry/${id}`, content: JSON.stringify(metadata(entry)) })
      output.push({ name: `relations/${id}`, content: (relations.get(entry.id) ?? []).map(link => JSON.stringify(link)).join('\n') })
    }
    if (!scope || scope.startsWith('logs')) {
      const records = logs(context)
      for (const name of new Set(records.map(item => `logs/date/${item.value.date}`))) output.push({ name, content: 'Read this date for paged logs.' })
      for (const name of new Set(records.filter(item => typeof item.value.origin === 'string').map(item => `logs/session/${encodeURIComponent(String(item.value.origin))}`))) output.push({ name, content: 'Read this session for paged logs.' })
      output.push(...records.map(item => ({ name: item.name, content: JSON.stringify(item.value) })))
    }
    return output.filter(item => !scope || item.name === scope || item.name.startsWith(`${scope}/`))
      .map(item => ({ ...item, content: options?.content === false ? '' : item.content }))
  }
  return { read, list }
}
