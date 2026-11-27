import { open } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { MAX_OTIO_BYTES, parseOtio, type OtioNode } from '../shared/otio-model.ts'

export function otioSubpath(path: string): { source: string; view: string } | undefined {
  if (/^(?:v:|https?:)/i.test(path)) return
  const match = /^(.*?\.otio)[\\/](.*)$/i.exec(path)
  if (!match) return
  const view = match[2].replaceAll('\\', '/')
  if (!view || view.split('/').some(s => !s || s === '.' || s === '..')) throw new Error('Invalid OTIO subpath')
  return { source: match[1], view }
}


/** Bounded single-file snapshot, with no network, media access or expensive analysis. */
export async function readOtioIndex(source: string, reference: string, signal: AbortSignal): Promise<OtioIndex> {
  signal.throwIfAborted()
  const file = await open(source, 'r')
  try {
    const before = await file.stat()
    if (!before.isFile() || before.size > MAX_OTIO_BYTES) throw new Error('OTIO source must be a regular file of at most 8 MiB')
    const buffer = Buffer.alloc(before.size + 1)
    let size = 0
    while (size < buffer.length) {
      signal.throwIfAborted()
      const part = await file.read(buffer, size, buffer.length - size, null)
      if (!part.bytesRead) break
      size += part.bytesRead
    }
    const after = await file.stat()
    if (size !== before.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('OTIO source changed during read; retry')
    const bytes = buffer.subarray(0, size)
    return projectOtio(new TextDecoder('utf-8', { fatal: true }).decode(bytes), reference, createHash('sha256').update(bytes).digest('hex'))
  } finally { await file.close() }
}

// Budgets apply after the mandatory bounded source parse. No full view is materialized.
export const OTIO_PAGE_CHARS = 48_000
export const OTIO_RECORD_CHARS = 16_000
export const OTIO_SEARCH_LINES = 2048
export const OTIO_SEARCH_CHARS = 256_000
export const OTIO_SEARCH_VIEWS = 128
export interface OtioView { readonly lineCount: number; lineAt(index: number): string }
export interface OtioIndex {
  readonly sourceVersion: string
  readonly source: string
  readonly paths: Iterable<string>
  readonly metrics: { viewsOpened: number; recordsSerialized: number }
  view(path: string): OtioView
}

/** Parse once and index references only: O(nodes), no serialized views/descendant copies. */
export function projectOtio(text: string, source: string, version = createHash('sha256').update(text).digest('hex')): OtioIndex {
  const model = parseOtio(text)
  const raw: unknown = JSON.parse(text)
  const metrics = { viewsOpened: 0, recordsSerialized: 0 }
  const views = new Map<string, () => OtioView>()
  const tracks: OtioNode[] = [], clips: OtioNode[] = []
  const children = new Map<string, OtioNode[]>()
  const id = (node: OtioNode) => 'p' + Buffer.from(node.id).toString('hex')
  const ref = (node: OtioNode) => `${source}/${node.kind === 'Track' ? 'tracks' : 'clips'}/${id(node)}`
  // Only short identity fields and precise parser timing, not arbitrary metadata/effects.
  const record = (node: OtioNode) => ({ ...node, name: node.name.slice(0, 512), targetUrl: node.targetUrl?.slice(0, 2048),
    kind: node.kind.slice(0, 128), schema: node.schema.slice(0, 128), trackKind: node.trackKind?.slice(0, 128),
    activeMediaKey: node.activeMediaKey?.slice(0, 256),
    transition: node.transition ? { ...node.transition, type: node.transition.type?.slice(0, 256) } : undefined,
    sourcePointer: node.id, read: ['Track', 'Clip'].includes(node.kind) ? ref(node) : undefined })
  const authored = (node: OtioNode) => node.id.split('/').slice(1).reduce<unknown>((v, key) => (v as Record<string, unknown>)[key], raw) as Record<string, unknown>
  const meta = { source, sourceVersion: `sha256:${version}`, readonly: true,
    timeSemantics: 'Projected seconds use the shared preview parser. Authored RationalTime value/rate pairs preserve source precision; raw .otio read retains all metadata.' }
  const bounded = (value: unknown, pointer?: string) => {
    metrics.recordsSerialized++
    const omitted = () => JSON.stringify({ sourcePointer: pointer,
      omitted: 'Record exceeds 16000 characters or JSON serialization depth; read the raw source at this JSON pointer.', source })
    try {
      const line = JSON.stringify(value)
      return line.length <= OTIO_RECORD_CHARS ? line : omitted()
    } catch (error) {
      if (error instanceof RangeError) return omitted()
      throw error
    }
  }
  const single = (body: Record<string, unknown>, pointer?: string): OtioView => {
    // One bounded detail record only; pretty printing never receives an unbounded collection.
    const head = JSON.stringify(meta, null, 2).split('\n').slice(0, -1)
    const fields = Object.entries(JSON.parse(bounded(body, pointer)))
    if (fields.length) head[head.length - 1] += ','
    const lines = [...head, ...fields.map(([key, value], i) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)}${i + 1 < fields.length ? ',' : ''}`), '}']
    return { lineCount: lines.length, lineAt: i => lines[i]! }
  }
  const list = (key: string, nodes: readonly OtioNode[], item: (node: OtioNode) => unknown = record, extra = {}): OtioView => {
    const header = JSON.stringify({ ...meta, ...extra }, null, 2).split('\n')
    header[header.length - 2] += ','
    header[header.length - 1] = `  ${JSON.stringify(key)}: [`
    const end = header.length + nodes.length
    return { lineCount: end + 2, lineAt: i => {
      if (i < header.length) return header[i]!
      if (i === end) return '  ]'
      if (i === end + 1) return '}'
      const n = i - header.length
      return '    ' + bounded(item(nodes[n]!), nodes[n]!.id) + (n + 1 < nodes.length ? ',' : '')
    } }
  }
  const add = (path: string, factory: () => OtioView) => views.set(`${source}/${path}`, factory)
  // Factories capture nodes, never serialized content or filtered descendant arrays.
  add('overview', () => single({ name: model.root.name.slice(0, 512), rate: model.rate, duration: model.duration,
    globalStart: model.globalStart, trackCount: tracks.length, clipCount: clips.length,
    follow: ['timeline', 'tracks', 'clips', 'media', 'diagnostics'].map(p => `${source}/${p}`) }))
  add('timeline', () => list('nodes', model.nodes))
  add('tracks', () => list('tracks', tracks))
  add('clips', () => list('clips', clips))
  add('media', () => list('media', clips, node => ({ clip: ref(node), sourcePointer: node.id,
    media_reference: authored(node).media_reference, media_references: authored(node).media_references,
    activeMediaKey: node.activeMediaKey, targetUrl: node.targetUrl, status: 'Reference only; not fetched or probed.' })))
  add('diagnostics', () => single({ warnings: model.warnings, limitations: [
    'Shared preview hard-cut transition approximations apply. No media probing, decoding or existence checks.',
    'IDs encode source JSON pointers. Structural edits may change IDs; compare sourceVersion across pages.',
    'Track details list direct children only; timeline contains projected nodes, not a second copy of raw JSON.',
    'Names/URLs in node summaries are capped at 512/2048 characters. Oversize records are replaced by explicit source-pointer omission records.',
  ] }))
  for (const node of model.nodes) {
    if (node.parentId !== null) {
      let siblings = children.get(node.parentId)
      if (!siblings) children.set(node.parentId, siblings = [])
      siblings.push(node)
    }
    if (node.kind === 'Track') {
      tracks.push(node)
      add(`tracks/${id(node)}`, () => list('children', children.get(node.id) ?? [], record, { track: record(node) }))
    } else if (node.kind === 'Clip') {
      clips.push(node)
      add(`clips/${id(node)}`, () => single({ clip: record(node), authored: authored(node) }, node.id))
    }
  }
  return { source, sourceVersion: meta.sourceVersion, get paths() { return views.keys() }, metrics, view(path) {
    const factory = views.get(path)
    if (!factory) throw new Error('Unknown OTIO view. Read <source>.otio/overview for follow references.')
    metrics.viewsOpened++
    return factory()
  } }
}

// Transport receipt, not a view line: never included in lineAt/lineCount or grep numbering.
function snapshotReceipt(index: OtioIndex): string {
  return `[OTIO snapshot ${JSON.stringify({ source: index.source, sourceVersion: index.sourceVersion })}]\n`
}

/** Random-access lines: skipped list records are never serialized just to reach offset. */
export function otioPage(index: OtioIndex, path: string, offset: number, limit: number, numbered = false): string {
  const view = index.view(path)
  const receipt = snapshotReceipt(index)
  const lines: string[] = []
  let chars = 0, cursor = Math.min(offset, view.lineCount)
  for (; cursor < view.lineCount && lines.length < Math.min(limit, 200); cursor++) {
    const line = view.lineAt(cursor)
    const rendered = numbered ? `${cursor + 1}  ${line}` : line
    if (chars + rendered.length + 1 > OTIO_PAGE_CHARS - 256 - receipt.length) break
    lines.push(rendered)
    chars += rendered.length + 1
  }
  return (offset > 0 || cursor < view.lineCount ? receipt : '') + lines.join('\n') + (cursor < view.lineCount ? `\n\n[more: use offset=${cursor + 1}; OTIO pages cap at 200 lines / 48000 characters]` : '')
}

/** Bounded wildcard matching without evaluating a caller-supplied regular expression. */
function globMatch(pattern: string, text: string): boolean {
  let p = 0, t = 0, star = -1, restart = 0
  while (t < text.length) {
    if (pattern[p] === '?' || pattern[p] === text[t]) { p++; t++ }
    else if (pattern[p] === '*') { star = p++; restart = t }
    else if (star >= 0) { p = star + 1; t = ++restart }
    else return false
  }
  while (pattern[p] === '*') p++
  return p === pattern.length
}

export function otioSearch(index: OtioIndex, handler: string, query: string, scope: string, offset: number, limit: number): string {
  if (query.length > 256) throw new Error('OTIO search query is limited to 256 characters.')
  const results: string[] = []
  const receipt = snapshotReceipt(index)
  let matched = 0, chars = 0, lines = 0, opened = 0, outputChars = 0, stopped = false, budget = false
  const accept = (result: string) => {
    if (matched++ < offset) return false
    if (results.length >= limit || outputChars + result.length + 1 > OTIO_PAGE_CHARS - 512 - receipt.length) { stopped = true; return true }
    results.push(result); outputChars += result.length + 1
    return false
  }
  outer: for (const path of index.paths) {
    if (path !== scope && !path.startsWith(scope + '/')) continue
    if (handler === 'glob') {
      chars += path.length
      if (++lines > OTIO_SEARCH_LINES || chars > OTIO_SEARCH_CHARS) { budget = true; break }
      if ((globMatch(query, path.slice(scope.length + 1)) || globMatch(query, path)) && accept(path)) break
    } else {
      if (++opened > OTIO_SEARCH_VIEWS) { budget = true; break }
      const view = index.view(path)
      for (let i = 0; i < view.lineCount; i++) {
        if (++lines > OTIO_SEARCH_LINES || chars >= OTIO_SEARCH_CHARS) { budget = true; break outer }
        const line = view.lineAt(i)
        chars += line.length
        if (chars > OTIO_SEARCH_CHARS) { budget = true; break outer }
        if (line.includes(query) && accept(`${path}:${i + 1}:${line}`)) break outer
      }
    }
  }
  return receipt + `[OTIO ${handler === 'grep' ? 'literal grep' : 'glob'}; bounded scan; offset=${offset}]\n` + results.join('\n') +
    (stopped ? `\n[more: offset=${offset + results.length}]` : '') +
    (budget ? '\n[scan budget reached: narrow path/query; this is not an exhaustive search. Limits: 128 views, 2048 lines/paths, 256000 characters.]' : '')
}
