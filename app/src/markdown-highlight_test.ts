import test from 'node:test'
import assert from 'node:assert/strict'
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
