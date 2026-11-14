import { MarkdownExit, type PluginSimple } from 'markdown-exit'
import cjkFriendly from 'markdown-it-cjk-friendly'
import { tasklist } from '@mdit/plugin-tasklist'
import { katex } from '@mdit/plugin-katex'
import { highlightMarkdownCode } from './markdown-highlight.ts'

export const MAX_MATH = 16_384

/** Shared synchronous parser. Sanitization remains at each DOM/resource boundary. */
export function createMarkdown(options: { html?: boolean; breaks?: boolean; math?: boolean } = {}) {
  const md = new MarkdownExit({ html: options.html ?? true, breaks: options.breaks ?? true, linkify: true })
  // markdown-exit exposes markdown-it's inline State/scanDelims plugin API.
  md.use(cjkFriendly as unknown as PluginSimple)
  md.use(tasklist as unknown as PluginSimple, { disabled: true, label: false, containerClass: '', itemClass: '', checkboxClass: '' })
  md.renderer.rules.fence = (tokens, index) => {
    const token = tokens[index]!
    return highlightMarkdownCode(token.content.replace(/\n$/, ''), token.info)
  }
  if (options.math !== false) {
    // markdown-exit implements the markdown-it plugin API; the upstream plugin's
    // nominal MarkdownIt types still refer to that package's concrete class.
    const inlineBefore = new Set(md.inline.ruler.getRules(''))
    const blockBefore = new Set(md.block.ruler.getRules(''))
    md.use(katex as unknown as PluginSimple, { delimiters: 'all', trust: false, maxExpand: 1000, maxSize: 20, logger: () => 'ignore' })
    // Bound upstream forward searches, not a second TeX lexer. A final-closer
    // check avoids repeated scans of streamed, entirely unclosed delimiters.
    const inlineRules = md.inline.ruler.getRules('').filter(rule => !inlineBefore.has(rule))
    const blockRules = md.block.ruler.getRules('').filter(rule => !blockBefore.has(rule))
    // These are the two rules installed by plugin-tex in parser order:
    // brackets before escape, dollars after escape; both block rules follow
    // blockquote, with brackets installed last (therefore ordered first).
    if (inlineRules.length !== 2 || blockRules.length !== 2) throw new Error('Unsupported KaTeX rule layout')
    const lastClosers = new WeakMap<object, Map<string, number>>()
    for (const [name, closer] of [['math_inline_bracket', '\\)'], ['math_inline_dollar', '$']] as const) {
      const rule = inlineRules[name === 'math_inline_bracket' ? 0 : 1]!
      md.inline.ruler.at(name, (state, silent) => {
        if (silent) return false
        if (name === 'math_inline_dollar' ? state.src[state.pos] !== '$' : !state.src.startsWith('\\(', state.pos)) return false
        let cache = lastClosers.get(state)
        if (!cache) { cache = new Map(); lastClosers.set(state, cache) }
        if (!cache.has(closer)) cache.set(closer, state.src.lastIndexOf(closer))
        if (cache.get(closer)! <= state.pos) return false
        const end = state.posMax
        state.posMax = Math.min(end, state.pos + MAX_MATH + 4)
        const source = state.src
        // The upstream dollar closer treats '_' as a word character. Mask only
        // that following boundary during its bounded rule, never TeX content.
        if (name === 'math_inline_dollar') {
          const slice = source.slice(state.pos, state.posMax)
          const closer = slice.indexOf('$', 1)
          if (closer > 0 && slice[closer - 1] !== '\\' && slice[closer + 1] === '_') {
            const at = state.pos + closer + 1
            state.src = source.slice(0, at) + ' ' + source.slice(at + 1)
          }
        }
        try { return rule(state, silent) } finally { state.posMax = end; state.src = source }
      })
    }
    // Upstream supports display dollars only as blocks. Keep Shadow's existing
    // inline $$ compatibility with one bounded, current-position adapter; all
    // rendering/security/expansion remains in the mature KaTeX plugin.
    md.inline.ruler.before('math_inline_dollar', 'shadow_inline_display', (state, silent) => {
      if (silent || !state.src.startsWith('$$', state.pos)) return false
      const bodyStart = state.pos + 2
      const bounded = state.src.slice(bodyStart, Math.min(state.posMax, bodyStart + MAX_MATH + 2))
      const end = bounded.indexOf('$$')
      if (end < 0 || end > MAX_MATH) return false
      const token = state.push('math_block', 'math', 0)
      token.markup = '$$'; token.content = bounded.slice(0, end); token.meta = { inlineDisplay: true }
      state.pos = bodyStart + end + 2
      return true
    })
    for (const name of ['math_block_dollar', 'math_block_bracket']) {
      const closer = name === 'math_block_bracket' ? '\\]' : '$$'
      const rule = blockRules[name === 'math_block_bracket' ? 0 : 1]!
      md.block.ruler.at(name, (state, start, end, silent) => {
        let cache = lastClosers.get(state)
        if (!cache) { cache = new Map(); lastClosers.set(state, cache) }
        if (!cache.has(closer)) cache.set(closer, state.src.lastIndexOf(closer))
        if (cache.get(closer)! <= state.bMarks[start]! + state.tShift[start]!) return false
        // Binary search line offsets to bound block searches by source length.
        let low = start + 1, high = end
        const limit = state.bMarks[start]! + MAX_MATH + 8
        while (low < high) { const mid = (low + high) >>> 1; if (state.bMarks[mid]! <= limit) low = mid + 1; else high = mid }
        return rule(state, start, low, silent)
      }, { alt: ['paragraph', 'reference', 'blockquote', 'list'] })
    }
    for (const name of ['math_inline', 'math_block']) {
      const render = md.renderer.rules[name]!
      md.renderer.rules[name] = (tokens, index, ...args) => {
        const token = tokens[index]!
        if (token.content.replace(/\n$/, '').length > MAX_MATH) return md.utils.escapeHtml(token.markup + token.content + (token.markup === '\\(' ? '\\)' : token.markup === '\\[' ? '\\]' : token.markup))
        let html = render(tokens, index, ...args)
        if (typeof html === 'string' && html.includes('class="katex-error"')) {
          return md.utils.escapeHtml(token.markup + token.content + (token.markup === '\\(' ? '\\)' : token.markup === '\\[' ? '\\]' : token.markup))
        }
        if (token.meta?.inlineDisplay && typeof html === 'string') html = html.replace(/^<p class='katex-block'>/, '<span class="katex-block">').replace(/<\/p>\n$/, '</span>')
        return html
      }
    }
  }
  return md
}
