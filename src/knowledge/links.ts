import { isAbsolute, posix, relative } from 'node:path'
import type { KnowledgeDetail, KnowledgeLink } from './contracts.ts'

export interface MarkdownReference {
  target: string
  label: string
  start: number
  end: number
  supported: boolean
  destinationSupported: boolean
}

function escaped(text: string, index: number): boolean {
  let slashes = 0
  while (index > 0 && text[--index] === '\\') slashes++
  return slashes % 2 === 1
}

function blank(text: string): string { return text.replace(/[^\r\n]/g, ' ') }

/** Mask examples without changing offsets used by the confirmed repair preview. */
function prose(content: string): string {
  let fence: { marker: string; length: number } | undefined
  const text = content.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, blank)
    .replace(/<!--[\s\S]*?(?:-->|$)/g, blank)
    .replace(/<(pre|code|script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, blank)
    .split('\n').map(line => {
      const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line)
      if (fence) {
        if (new RegExp(`^ {0,3}${fence.marker}{${fence.length},}\\s*$`).test(line)) fence = undefined
        return blank(line)
      }
      if (opening) {
        fence = { marker: opening[1][0], length: opening[1].length }
        return blank(line)
      }
      return /^(?: {4}|\t)/.test(line) ? blank(line) : line
    }).join('\n')
  const runs = [...text.matchAll(/`+/g)]
  const parts: string[] = []
  let cursor = 0
  for (let i = 0; i < runs.length; i++) {
    const open = runs[i]
    if (escaped(text, open.index)) continue
    let end = i + 1
    while (end < runs.length && runs[end][0].length !== open[0].length) end++
    if (end === runs.length) continue
    const until = runs[end].index + runs[end][0].length
    parts.push(text.slice(cursor, open.index), blank(text.slice(open.index, until)))
    cursor = until
    i = end
  }
  return parts.join('') + text.slice(cursor)
}

function unescapeDestination(value: string): string {
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
  return value.replace(/&(#(?:x|X)[0-9a-fA-F]+|#\d+|amp|AMP|lt|LT|gt|GT|quot|QUOT|apos);/g, (all, name: string, offset: number) => {
      if (escaped(value, offset)) return all
      if (name[0] !== '#') return entities[name.toLowerCase()] ?? all
      const point = Number.parseInt(name.slice(/^#x/i.test(name) ? 2 : 1), /^#x/i.test(name) ? 16 : 10)
      return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
        ? String.fromCodePoint(point) : '\ufffd'
    })
    .replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g, '$1')
}

function destination(text: string, opening: number): { target: string; end: number } | undefined {
  let at = opening + 1
  while (/\s/.test(text[at] ?? '') && at < text.length) at++
  const start = at
  let target: string
  if (text[at] === '<') {
    at++
    while (at < text.length && (text[at] !== '>' || escaped(text, at)) && !/[\r\n]/.test(text[at])) at++
    if (text[at] !== '>') return undefined
    target = text.slice(start + 1, at++)
  } else {
    let depth = 0
    while (at < text.length) {
      const char = text[at]
      if (!escaped(text, at)) {
        if (/\s/.test(char)) break
        if (char === '(') depth++
        if (char === ')') {
          if (!depth) break
          depth--
        }
      }
      at++
    }
    if (depth) return undefined
    target = text.slice(start, at)
  }
  const hadSpace = /\s/.test(text[at] ?? '')
  while (/\s/.test(text[at] ?? '') && at < text.length) at++
  if (hadSpace && ['"', "'", '('].includes(text[at])) {
    const close = text[at] === '(' ? ')' : text[at]
    at++
    while (at < text.length && (text[at] !== close || escaped(text, at))) at++
    if (at === text.length) return undefined
    at++
    while (/\s/.test(text[at] ?? '') && at < text.length) at++
  }
  if (text[at] !== ')') return undefined
  return { target: unescapeDestination(target), end: at + 1 }
}

function bracketEnd(text: string, opening: number): number {
  let depth = 1
  for (let at = opening + 1; at < text.length; at++) {
    if (escaped(text, at)) continue
    if (text[at] === '[') depth++
    if (text[at] === ']' && --depth === 0) return at
  }
  return -1
}

/** Common parser for graph and maintenance, including reference-link usage spans. */
export function markdownReferenceSpans(content: string): MarkdownReference[] {
  let text = prose(content)
  const definitions = new Map<string, string>()
  const key = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase()
  text = text.replace(/^ {0,3}\[([^\]\r\n]+)\]:[ \t]*(?:\r?\n[ \t]*)?([^\r\n]+)$/gm,
    (all, name: string, tail: string) => {
      const parsed = destination(`(${tail.trim()})`, 0)
      if (parsed && !definitions.has(key(name))) definitions.set(key(name), parsed.target)
      return blank(all)
    })
  const result: MarkdownReference[] = []
  for (let at = 0; at < text.length; at++) {
    if (text[at] === '<' && !escaped(text, at)) {
      const end = text.indexOf('>', at + 1)
      if (end >= 0) { at = end; continue }
    }
    if (text[at] !== '[' || escaped(text, at)) continue
    const close = bracketEnd(text, at)
    if (close < 0) break
    const label = content.slice(at + 1, close)
    let target: string | undefined
    let end = close + 1
    if (text[end] === '(') {
      const parsed = destination(text, end)
      target = parsed?.target
      end = parsed?.end ?? end
    } else if (text[end] === '[') {
      const referenceEnd = bracketEnd(text, end)
      if (referenceEnd >= 0) {
        target = definitions.get(key(text.slice(end + 1, referenceEnd) || label))
        end = referenceEnd + 1
      }
    } else {
      target = definitions.get(key(label))
    }
    if (target && !(text[at - 1] === '!' && !escaped(text, at - 1)) && !label.includes('![')) {
      result.push({
        target, label, start: at, end,
        supported: !/[\[\]<>\r\n]/.test(label.replace(/\\./g, '')),
        destinationSupported: !/&(?:#[xX]?[0-9a-f]+|[a-z][a-z\d]+);/i.test(target),
      })
    }
    at = end - 1
  }
  return result
}

export function markdownReferences(content: string): Array<{ target: string; label: string }> {
  return markdownReferenceSpans(content).filter(ref => ref.destinationSupported).map(({ target, label }) => ({ target, label }))
}

export function canonicalReference(
  raw: string,
  source: string,
  workspace: string,
  skillIds: ReadonlyMap<string, string>,
): string | undefined {
  let target: string
  try { target = decodeURIComponent(raw.split(/[?#]/, 1)[0]).replace(/\\/g, '/') }
  catch (error) {
    if (error instanceof URIError) return undefined
    throw error
  }
  if (!target || /[\0-\x1f]/.test(target) || target.startsWith('//')) return undefined
  if (target.startsWith('v:skills/')) {
    const [name, ...rest] = target.slice('v:skills/'.length).split('/')
    if (!name || name === '.' || name === '..') return undefined
    if (!rest.length || (rest.length === 1 && rest[0] === 'SKILL.md')) {
      return skillIds.get(name) ?? `skills/${name}/SKILL.md`
    }
    const base = skillIds.get(name)
    target = base?.startsWith('builtin:') ? `${base}/${rest.join('/')}`
      : `${base ? posix.dirname(base) : `skills/${name}`}/${rest.join('/')}`
  } else {
    target = target.replace(/^v:memory(?=\/)/, 'memory')
  }
  if (target.startsWith('builtin:skills/')) {
    const value = target.slice('builtin:'.length)
    const normalized = posix.normalize(value)
    if (!normalized.startsWith('skills/') || normalized.split('/').some(p => p.startsWith('.'))) return undefined
    return `builtin:${normalized.replace(/\/SKILL\.md$/, '')}`
  }
  if (isAbsolute(target)) target = relative(workspace, target).replace(/\\/g, '/')
  else if (/^[a-z][a-z\d+.-]*:/i.test(target)) return undefined
  else if (!/^(?:memory|skills)\//.test(target)) {
    if (source.startsWith('builtin:')) {
      return canonicalReference(`builtin:${posix.join(source.slice('builtin:'.length), target)}`, source, workspace, skillIds)
    }
    target = posix.join(posix.dirname(source), target)
  }
  target = posix.normalize(target)
  if (target === '.' || target.split('/').some(p => !p || p.startsWith('.') || p.includes(':'))) return undefined
  return target
}

export function extractLinks(
  detail: KnowledgeDetail,
  workspace: string,
  skillIds: ReadonlyMap<string, string>,
  related?: string,
): KnowledgeLink[] {
  const references = detail.entry.path.endsWith('.jsonl')
    ? jsonlReferences(detail.content)
    : markdownReferences(detail.content)
  for (const name of related?.split(',').map(value => value.trim()).filter(Boolean) ?? []) {
    references.push({ target: `v:skills/${name}`, label: 'related' })
  }
  const links: KnowledgeLink[] = []
  for (const ref of references) {
    const target = canonicalReference(ref.target, detail.entry.id, workspace, skillIds)
    if (target) links.push({ source: detail.entry.id, target, label: ref.label })
  }
  return links
}

export function jsonlReferences(content: string): Array<{ target: string; label: string }> {
  const references: Array<{ target: string; label: string }> = []
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue
    const value: unknown = JSON.parse(line)
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const record = value as Record<string, unknown>
    if (Array.isArray(record.refs)) {
      for (const ref of record.refs) {
        if (typeof ref === 'string') references.push({ target: ref, label: 'refs' })
      }
    }
    if (typeof record.path === 'string') references.push({ target: record.path, label: 'modified' })
  }
  return references
}
