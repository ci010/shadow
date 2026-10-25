import { markdownHighlight } from './markdown-highlight.ts'
import { Marked } from 'marked'

export interface SourceLines {
  start: number
  end: number
  provenance?: 'source block' | 'source document'
}

/** Offsets are UTF-16 DOM offsets; the exclusive end never includes the next line. */
export function sourceLines(source: string, anchor: number, focus: number): SourceLines | undefined {
  const start = Math.min(anchor, focus)
  const end = Math.max(anchor, focus)
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > source.length || start === end) return
  const lineAt = (offset: number) => {
    let line = 1
    for (const match of source.matchAll(/\r\n|\r|\n/g)) {
      if (match.index + match[0].length > offset) break
      line++
    }
    return line
  }
  return { start: lineAt(start), end: lineAt(end - 1) }
}

export function plainSelectionLines(root: HTMLElement, range: Range, source: string): SourceLines | undefined {
  if (root.textContent !== source || !root.contains(range.startContainer) || !root.contains(range.endContainer)) return
  const prefix = root.ownerDocument.createRange()
  prefix.selectNodeContents(root)
  prefix.setEnd(range.startContainer, range.startOffset)
  const start = prefix.toString().length
  prefix.setEnd(range.endContainer, range.endOffset)
  return sourceLines(source, start, prefix.toString().length)
}

export interface MarkdownSourceBlock extends SourceLines {
  html: string
}

/** Root tokens consume source in order, so duplicate excerpts cannot change provenance. */
export function markdownSourceBlocks(source: string): MarkdownSourceBlock[] {
  const normalized = source.replace(/\r\n?/g, '\n')
  const markdown = new Marked({ gfm: true })
  markdown.use(markdownHighlight())
  const tokens = markdown.lexer(normalized)
  // Fail conservatively if a future lexer changes its raw-token coverage.
  const exact = tokens.map(token => token.raw).join('') === normalized
  const documentLines = exact ? undefined : sourceLines(normalized, 0, normalized.length)
  let line = 1
  return tokens.flatMap(token => {
    const start = line
    line += (token.raw.match(/\n/g) ?? []).length
    const html = markdown.parser([token])
    if (!html.trim()) return []
    const lines = exact
      ? { start, end: start + (token.raw.trimEnd().match(/\n/g) ?? []).length }
      : documentLines
    return lines ? [{ ...lines, html, provenance: exact ? 'source block' as const : 'source document' as const }] : []
  })
}

/** Only direct, application-created wrappers are trusted, never attributes inside file content. */
export function renderedSelectionLines(root: HTMLElement, range: Range, blocks: readonly SourceLines[]): SourceLines | undefined {
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return
  if (root.children.length !== blocks.length) return
  const spans: SourceLines[] = []
  for (const [index, block] of Array.from(root.children).entries()) {
    const intersection = root.ownerDocument.createRange()
    intersection.selectNodeContents(block)
    // START_TO_START / END_TO_END; strict textual overlap excludes the next block's boundary.
    if (range.compareBoundaryPoints(0, intersection) > 0) intersection.setStart(range.startContainer, range.startOffset)
    if (range.compareBoundaryPoints(2, intersection) < 0) intersection.setEnd(range.endContainer, range.endOffset)
    if (intersection.collapsed || !intersection.toString().trim()) continue
    const { start, end, provenance } = blocks[index]!
    if (!Number.isInteger(start) || start < 1 || !Number.isInteger(end) || end < start) return
    spans.push({ start, end, provenance: provenance === 'source document' ? 'source document' : 'source block' })
  }
  if (!spans.length) return
  return { start: Math.min(...spans.map(span => span.start)), end: Math.max(...spans.map(span => span.end)),
    provenance: spans.some(span => span.provenance === 'source document') ? 'source document' : 'source block' }
}

export { renderedSelectionLines as markdownSelectionLines }

export function formatFileQuote(path: string, text: string, lines: SourceLines, truncated = false): string {
  const label = lines.start === lines.end ? String(lines.start) : `${lines.start}-${lines.end}`
  return `File: ${path}\nLines: ${label}${lines.provenance ? ` (${lines.provenance})` : ''}${truncated ? '\nContext: truncated file preview' : ''}\n\n${text}`
}

/** Keep Markdown resources within the file scope; external HTTP links retain existing behavior. */
export function fileMarkdownUrl(value: string, attribute: 'href' | 'src', base: string, root: string): string | undefined {
  let url: URL
  try { url = new URL(value, base) } catch { return }
  const scope = new URL(root)
  const relative = !/^[a-z][a-z\d+.-]*:/i.test(value) && !value.startsWith('//')
  if (!['http:', 'https:', ...(attribute === 'href' ? ['mailto:'] : [])].includes(url.protocol)
    || (relative && (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)))) return
  return url.href
}
