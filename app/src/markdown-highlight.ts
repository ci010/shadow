
import { shallowRef } from 'vue'
import type { MarkedExtension } from 'marked'
import type { HighlighterCore } from 'shiki/core'
import { fenceLanguage, prepareFenceHighlighter } from './file-highlighting.ts'

// Read during synchronous Markdown rendering: lazy grammar completion invalidates
// Vue consumers without making marked (or streamed message rendering) asynchronous.
const revision = shallowRef(0)
let highlighter: HighlighterCore | undefined
const pending = new Map<string, Promise<void>>()
const failed = new Set<string>()
const cache = new Map<string, string>()
const MAX_CODE = 20_000
const MAX_CACHE = 64
const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

export async function prepareMarkdownLanguage(language: string): Promise<void> {
  if (pending.has(language)) return pending.get(language)
  if (failed.has(language)) return
  const loading = (async () => {
    try {
      const resolved = fenceLanguage(language)
      if (!resolved) { failed.add(language); return }
      highlighter = await prepareFenceHighlighter(resolved)
      revision.value++
    } catch {
      // Offline/chunk errors never break Markdown. Do not retry each stream token.
      failed.add(language)
    }
  })()
  pending.set(language, loading)
  return loading
}

export function markdownHighlight(): MarkedExtension {
  return { renderer: { code({ text, lang }) {
    void revision.value
    const label = lang?.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
    const language = fenceLanguage(label) ?? label
    const plain = () => `<pre><code${language ? ` class="language-${escape(label)}"` : ''}>${escape(text)}\n</code></pre>\n`
    // Never infer a grammar for prose, ASCII diagrams, or unlabelled fences.
    if (!language || /^(?:text|txt|plaintext|plain|ascii|ansi|mermaid)$/.test(language) || text.length > MAX_CODE) return plain()
    if (!highlighter?.getLoadedLanguages().includes(language)) {
      void prepareMarkdownLanguage(language)
      return plain()
    }
    const key = `${language}\0${text}`
    const cached = cache.get(key)
    if (cached) return cached
    try {
      const result = highlighter.codeToTokensWithThemes(text, { lang: language, tokenizeMaxLineLength: 2000, tokenizeTimeLimit: 50, themes: { light: 'github-light', dark: 'github-dark' } })
      // Only generated hex-color classes; no inline styles or sanitizer exemptions.
      const colorClass = (prefix: string, color: string = '') => /^#[\da-f]{6}$/i.test(color) ? ` ${prefix}-${color.slice(1).toLowerCase()}` : ''
      const body = result.map(line => line.map(token => `<span class="${colorClass('sl', token.variants.light.color).trim()}${colorClass('sd', token.variants.dark.color)}">${escape(token.content)}</span>`).join('')).join('\n')
      const html = `<pre class="shiki"><code class="language-${escape(label)}">${body}\n</code></pre>\n`
      if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value!)
      cache.set(key, html)
      return html
    } catch { return plain() }
  } } }
}
