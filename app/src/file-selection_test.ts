import assert from 'node:assert/strict'
import test from 'node:test'
import { Marked } from 'marked'
import { fileMarkdownUrl, formatFileQuote, markdownSelectionLines, markdownSourceBlocks, plainSelectionLines, sourceLines } from './file-selection.ts'

test('source ranges use exclusive UTF-16 offsets, including CRLF and reversed selections', () => {
  assert.deepEqual(sourceLines('one\ntwo\nthree', 0, 4), { start: 1, end: 1 })
  assert.deepEqual(sourceLines('one\ntwo\nthree', 4, 8), { start: 2, end: 2 })
  assert.deepEqual(sourceLines('one\r\ntwo\r\nthree', 5, 10), { start: 2, end: 2 })
  assert.deepEqual(sourceLines('one\r\ntwo\r\nthree', 10, 5), { start: 2, end: 2 })
  assert.deepEqual(sourceLines('one\rtwo\rthree', 4, 8), { start: 2, end: 2 })
  assert.deepEqual(sourceLines('😀\r\nsame\r\nsame', 10, 14), { start: 3, end: 3 })
  assert.deepEqual(sourceLines('one\ntwo\nthree', 2, 10), { start: 1, end: 3 })
  for (const [start, end] of [[0, 0], [-1, 2], [0, 100], [0.5, 2]]) {
    assert.equal(sourceLines('hello', start!, end!), undefined)
  }
})

test('plain selection uses Range positions rather than matching repeated text', () => {
  const source = 'same\nsame\nsame'
  const node = { textContent: source }
  let end = 0
  const root = {
    textContent: source,
    contains: (candidate: unknown) => candidate === node,
    ownerDocument: { createRange: () => ({
      selectNodeContents() {},
      setEnd(_node: unknown, offset: number) { end = offset },
      toString: () => source.slice(0, end),
    }) },
  } as unknown as HTMLElement
  const range = { startContainer: node, startOffset: 10, endContainer: node, endOffset: 14 } as unknown as Range
  assert.deepEqual(plainSelectionLines(root, range, source), { start: 3, end: 3 })
  assert.equal(plainSelectionLines(root, range, 'changed'), undefined)
  assert.equal(plainSelectionLines(root, { ...range, endContainer: {} } as Range, source), undefined)
})

test('Markdown maps duplicate paragraphs, definitions and CRLF by sequential token provenance', () => {
  const blocks = markdownSourceBlocks('[ref]: https://example.com\r\n\r\nsame\r\n\r\nsame\r\n\r\n[ref]\r\n')
  assert.deepEqual(blocks.map(({ start, end, provenance }) => ({ start, end, provenance })), [
    { start: 3, end: 3, provenance: 'source block' },
    { start: 5, end: 5, provenance: 'source block' },
    { start: 7, end: 7, provenance: 'source block' },
  ])
  assert.match(blocks[2]!.html, /href="https:\/\/example.com"/)
})

test('nested Markdown, fenced code and tables report truthful enclosing source blocks', () => {
  const source = '# Heading\n\n> first\n> second\n\n- one\n  - nested\n\n```ts\nsame\nsame\n```\n\n| A | B |\n| - | - |\n| x | y |\n'
  const blocks = markdownSourceBlocks(source)
  assert.deepEqual(blocks.map(({ start, end }) => [start, end]), [[1, 1], [3, 4], [6, 7], [9, 12], [14, 16]])
  assert.match(blocks[1]!.html, /<blockquote>/)
  assert.match(blocks[2]!.html, /<ul>[\s\S]*<ul>/)
  assert.match(blocks[3]!.html, /<pre><code class="language-ts">/)
  assert.match(blocks[4]!.html, /<table>/)
  assert.equal(blocks.map(block => block.html).join(''), new Marked({ gfm: true }).parse(source))
})

test('quotes carry scoped relative paths, line provenance and optional truncation without changing selection', () => {
  assert.equal(formatFileQuote('src/main.ts', '  selected\ntext  ', { start: 3, end: 5 }),
    'File: src/main.ts\nLines: 3-5\n\n  selected\ntext  ')
  assert.equal(formatFileQuote('README.md', 'same', { start: 5, end: 5, provenance: 'source block' }, true),
    'File: README.md\nLines: 5 (source block)\nContext: truncated file preview\n\nsame')
})

test('rendered source provenance trusts generated block records, never file-supplied DOM attributes', () => {
  const node = {}
  const blocks = markdownSourceBlocks('same\n\n<div data-source-start="999" data-source-end="999">same</div>\n')
  const children = blocks.map(() => ({
    textContent: 'same',
    getAttribute() { throw new Error('DOM source attributes are untrusted') },
  }))
  const root = {
    children,
    contains: (candidate: unknown) => candidate === node,
    ownerDocument: { createRange: () => ({
      collapsed: false,
      selectNodeContents() {},
      toString: () => 'same',
    }) },
  } as unknown as HTMLElement
  const range = { startContainer: node, endContainer: node, compareBoundaryPoints: () => 0 } as unknown as Range
  assert.deepEqual(markdownSelectionLines(root, range, blocks), { start: 1, end: 3, provenance: 'source block' })
  assert.equal(markdownSelectionLines(root, range, blocks.slice(1)), undefined)
  assert.equal(markdownSelectionLines(root, { ...range, endContainer: {} } as Range, blocks), undefined)
})

test('Markdown link and image normalization preserves safe scope and rejects unsafe resources', () => {
  const root = 'http://localhost/api/projects/project/static/'
  const base = `${root}docs/readme.md`
  assert.equal(fileMarkdownUrl('image.png', 'src', base, root), `${root}docs/image.png`)
  assert.equal(fileMarkdownUrl('../index.html', 'href', base, root), `${root}index.html`)
  assert.equal(fileMarkdownUrl('mailto:person@example.com', 'href', base, root), 'mailto:person@example.com')
  assert.equal(fileMarkdownUrl('https://example.com/image.png', 'src', base, root), 'https://example.com/image.png')
  for (const value of ['../../outside', '/api/projects/other/static/file', 'javascript:alert(1)', 'data:text/html,test', 'file:///private']) {
    assert.equal(fileMarkdownUrl(value, 'href', base, root), undefined, value)
    assert.equal(fileMarkdownUrl(value, 'src', base, root), undefined, value)
  }
  assert.equal(fileMarkdownUrl('mailto:person@example.com', 'src', base, root), undefined)
})
