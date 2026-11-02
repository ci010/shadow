import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Marked } from 'marked'
import { markdownHighlight, prepareMarkdownLanguage } from './markdown-highlight.ts'

const markdown = new Marked().use(markdownHighlight())
const render = (source: string) => markdown.parse(source, { async: false }) as string

test('plain and unknown fences remain escaped, including diagrams and malicious labels', async () => {
  for (const lang of ['', 'ascii', 'text', 'not-a-language', '"><script>']) {
    const html = render('```' + lang + '\n<script>alert(1)</script>\n```')
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'))
    assert.ok(!html.includes('<script>'))
    assert.ok(!html.includes('class="shiki"'))
  }
  await prepareMarkdownLanguage('not-a-language')
})

test('lazy shared grammars support aliases and dual theme classes without inline styles', async () => {
  await Promise.all([prepareMarkdownLanguage('js'), prepareMarkdownLanguage('typescript')])
  const source = '```js\nconst value = "<script>"\n```'
  const html = render(source)
  assert.ok(html.includes('class="shiki"'))
  assert.match(html, /sl-[a-f\d]{6}/)
  assert.match(html, /sd-[a-f\d]{6}/)
  assert.ok(!html.includes('style='))
  assert.ok(html.includes('&lt;script&gt;'))
  assert.equal(render(source), html)
  assert.ok(render('```typescript\nlet x: number = 1\n```').includes('class="shiki"'))
  assert.ok(!render('```js\n' + 'x'.repeat(20_001) + '\n```').includes('class="shiki"'))
})

test('Markdown fences pair theme-aware surfaces with light and dark syntax palettes', async () => {
  const css = readFileSync(new URL('./markdown-highlight.css', import.meta.url), 'utf8')
  assert.match(css, /pre\.shiki\s*\{[^}]*background: var\(--c-bg-soft\);[^}]*color: var\(--c-text\);/)
  const chat = readFileSync(new URL('./components/ChatTab.vue', import.meta.url), 'utf8')
  assert.match(chat, /\.chat-content :deep\(pre\)\s*\{\s*background: var\(--c-bg-soft\);\s*color: var\(--c-text\);/)
  const typography = readFileSync(new URL('../unocss.config.ts', import.meta.url), 'utf8')
  assert.ok(typography.includes("'pre': { background: 'var(--c-bg-soft)', color: 'var(--c-text)' }"))
  assert.ok(typography.includes("'pre code': { color: 'inherit' }"))
  await prepareMarkdownLanguage('typescript')
  const html = render('```typescript\nprompt: `${roleAgentType.prompt}\n\n# Personal BOT instructions\n${personal.prompt}`\n```')
  for (const [prefix, selector] of [['sl', '.shiki'], ['sd', '.dark .shiki']]) {
    const colors = [...html.matchAll(new RegExp(`\\b${prefix}-([a-f\\d]{6})`, 'g'))].map(match => match[1])
    assert.ok(colors.length > 0)
    for (const color of new Set(colors)) {
      assert.ok(css.includes(`${selector} .${prefix}-${color} { color: #${color}; }`))
    }
  }
})
