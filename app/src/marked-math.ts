import { type MarkedExtension, type Tokens } from 'marked'
import katex from 'katex'

// Bound delimiter scanning and KaTeX expansion independently. Sanitization still
// belongs to each caller; this extension must not be used as a sanitizer.
const MAX_MATH_LENGTH = 16_384
function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
function escaped(source: string, index: number): boolean {
  let slashes = 0
  while (index > 0 && source[--index] === '\\') slashes++
  return slashes % 2 === 1
}
function mathAt(source: string) {
  const open = ['$$', '\\[', '\\(', '$'].find(value => source.startsWith(value))
  if (!open) return
  const close = open === '\\[' ? '\\]' : open === '\\(' ? '\\)' : open
  const display = open === '$$' || open === '\\['
  const limit = Math.min(source.length, MAX_MATH_LENGTH + open.length + close.length)
  for (let end = open.length; end < limit; end++) {
    if (!display && source[end] === '\n') return
    if (!source.startsWith(close, end) || escaped(source, end)) continue
    const text = source.slice(open.length, end)
    if (!text.trim()) return
    // Dollar math uses tight edges and cannot end immediately before a digit:
    // "$5 and $10", "$ 5", and escaped currency remain ordinary Markdown.
    if (open === '$' && (/^\s|\s$/.test(text) || /\d/.test(source[end + 1] ?? '') || text.includes('$'))) return
    return { raw: source.slice(0, end + close.length), text, display }
  }
}
// Locate paragraph interruptions on the original source (Marked's startBlock
// hint drops its first character, which can hide an opening code-span backtick).
function blockStart(source: string): number | undefined {
  const spans = [...source.matchAll(/(`+)([\s\S]*?)\1(?!`)/g)]
  for (const match of source.matchAll(/(?:^|\n) {0,3}(?:\$\$|\\\[)/g)) {
    const index = match.index + (match[0].startsWith('\n') ? 1 : 0)
    if (spans.some(span => span.index < index && span.index + span[0].length > index)) continue
    const math = mathAt(source.slice(index).trimStart())
    if (math?.display && /^[ \t]*(?:\n|$)/.test(source.slice(index).trimStart().slice(math.raw.length))) return index
  }
}
function renderMath(token: Tokens.Generic): string {
  try {
    return katex.renderToString(token.text, {
      displayMode: token.display, trust: false, throwOnError: true,
      maxExpand: 1000, maxSize: 20,
    })
  } catch {
    // Preserve the original delimiters, but never introduce raw HTML on error.
    return escapeHtml(token.raw)
  }
}

/** Install on a local Marked instance, before parsing (no global preprocessing). */
export function markedMath(): MarkedExtension {
  return {
    // Both setext and paragraphs run before math on subsequent lines. Split
    // paragraphs here rather than using startBlock, preserving multiline code.
    tokenizer: {
      lheading(source) {
        const heading = this.rules.block.lheading.exec(source)
        const start = blockStart(source)
        if (heading && start !== undefined && start < heading[0].length) return undefined
        return false
      },
      paragraph(source) {
        const start = blockStart(source)
        if (start === undefined || start === 0) return false
        // Preserve Marked's own earlier paragraph boundary (lists, headings, etc.).
        const paragraph = this.rules.block.paragraph.exec(source)
        if (!paragraph || start >= paragraph[0].length) return false
        const raw = source.slice(0, start)
        const text = raw.trimEnd()
        return { type: 'paragraph', raw, text, tokens: this.lexer.inline(text) }
      },
    },
    extensions: [
      {
        name: 'blockMath', level: 'block',
        tokenizer(source) {
          const indent = /^ {0,3}/.exec(source)![0]
          const math = mathAt(source.slice(indent.length))
          if (!math?.display) return
          // Block math must finish its line. Otherwise leave it to inline math.
          const tail = source.slice(indent.length + math.raw.length)
          const end = /^[ \t]*(?:\n|$)/.exec(tail)
          if (!end) return
          return { type: 'blockMath', ...math, raw: indent + math.raw + end[0] }
        },
        renderer(token) { return renderMath(token) + '\n' },
      },
      {
        name: 'inlineMath', level: 'inline',
        start(source) {
          for (let index = 0; index < source.length; index++) {
            if ((source[index] === '$' || source[index] === '\\') && !escaped(source, index) && mathAt(source.slice(index))) return index
          }
        },
        tokenizer(source) {
          const math = mathAt(source)
          if (math) return { type: 'inlineMath', ...math }
        },
        renderer: renderMath,
      },
    ],
  }
}
