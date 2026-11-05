import assert from 'node:assert/strict'
import test from 'node:test'
import { createMarkdown } from './markdown.ts'

const marked = createMarkdown()
const render = (source: string) => marked.render(source)
const count = (html: string) => (html.match(/class="katex"/g) || []).length

test('block math preserves TeX before setext/escape parsing, including adjacent prose and lists', () => {
  const sample = String.raw`\[
y^{\rm TS}_{ij}
=
\sum_k x_k
\]`
  for (const source of [sample, `before\n${sample}\nafter`, `- item\n\n  ${sample.replace(/\n/g, '\n  ')}\n\n- next`]) {
    const html = render(source)
    assert.match(html, /katex-display/)
    assert.doesNotMatch(html, /<h1/)
    assert.equal(count(html), 1)
  }
  assert.equal(count(render('before\n$$x$$\nafter')), 1)
})

test('all inline delimiters, display dollars and adjacent text', () => {
  const html = render(String.raw`before \(\mathbf x\) and $x^2$ after

$$x+1$$`)
  assert.equal(count(html), 3)
  assert.match(html, /katex-display/)
  assert.match(html, /before/)
  assert.match(html, /after/)
})

test('code, currency and escaped dollars remain literal', () => {
  for (const source of [
    '```tex\n$x$ $$x$$ \\[x\\] \\(x\\)\n```',
    '    $x$\n    \\[x\\]',
    '`$x$ $$x$$ \\[x\\] \\(x\\)`',
    String.raw`Cost $5 and $10, or $20.00. Escaped \$x\$ and \$5.`,
    String.raw`Escaped \\(x\\) and \\[x\\]`,
  ]) assert.equal(count(render(source)), 0, source)
  assert.match(render('`$x$`'), /<code>\$x\$<\/code>/)
})

test('unclosed, invalid, excessive and untrusted math fail safely', () => {
  for (const source of ['$x', '$$x', '\\[x\n=', '\\(x', '$' + 'x'.repeat(20_000) + '$']) {
    assert.doesNotThrow(() => render(source))
    assert.equal(count(render(source)), 0)
  }
  assert.doesNotMatch(render(String.raw`$\href{javascript:alert(1)}{x}$`), /href=/)
  const html = render(String.raw`$\notACommand{<img src=x onerror=alert(1)>}$`)
  assert.doesNotMatch(html, /<img/)
  assert.match(html, /&lt;img/)
})


test('delimiter whitespace and length bounds', () => {
  for (const source of ['$a $', '$a$5']) {
    assert.equal(count(render(source)), 0, source)
  }
  assert.equal(count(render('$$$$')), 1) // upstream accepts empty display math
  assert.match(render('before $$$x$$ after'), /before \$\$\$x\$\$ after/) // invalid TeX preserves raw delimiters
  assert.equal(count(render('$' + 'x'.repeat(16_384) + '$')), 1)
  assert.equal(count(render('$' + 'x'.repeat(16_385) + '$')), 0)
  assert.equal(count(render('$$' + 'x'.repeat(16_385) + '$$')), 0)
  assert.equal(count(render('$$' + 'x'.repeat(16_386) + '$$')), 0)
})

test('inline rendering survives recursive emphasis/links, multiple paragraphs and parse reuse', () => {
  const source = 'before **bold $x$ and _inner $y$_** [link $z$](https://example.com) tail $w$\n\nnext $q$'
  for (let i = 0; i < 3; i++) {
    assert.equal(count(render(source)), 5)
    assert.equal(count(render('plain **bold** and $r$')), 1)
    assert.equal(count(render('Cost $5 and $10.')), 0)
  }
})

test('long ordinary Markdown and dense unmatched delimiters have bounded scanning cost', t => {
  // Deliberately generous wall-clock guard: the old start() rescans every
  // remaining suffix; dense unclosed delimiters took over two minutes locally.
  // Also exercise tokens before a valid opener, not only a no-math fast path.
  for (const [name, source, expected] of [
    ['ordinary tokens', 'word **bold** and `code` '.repeat(4000) + '$x$', 1],
    ['currency', 'price $5 and $10. '.repeat(4000), 0],
    ['unclosed parentheses', '\\( '.repeat(10000), 0],
    ['unclosed brackets', 'word \\[ '.repeat(6000), 0],
    ['unclosed bracket lines', '\\[\n'.repeat(6000), 0],
    ['many openers with one closer', '\\( '.repeat(10000) + '\\)', 0],
    ['escaped dollars', String.raw`word \$x\$ `.repeat(6000), 0],
  ] as const) {
    const start = performance.now()
    assert.equal(count(render(source)), expected, name)
    const elapsed = performance.now() - start
    t.diagnostic(`${name}: ${source.length} chars, ${elapsed.toFixed(1)} ms`)
    assert.ok(elapsed < 500, `${name}: ${elapsed.toFixed(1)}ms exceeds 500ms budget`)
  }
})

// Deliberate upstream grammar differences, not removed safety assertions.
test('upstream delimiter boundaries are explicit', () => {
  assert.equal(count(render('before $$x$$ after')), 1)
  assert.equal(count(render(String.raw`$a\$b$`)), 1)
  assert.equal(count(render('\\(x\ny\\)')), 1)
  assert.equal(count(render('$$ $$')), 1)
  // Block TeX interrupts a paragraph, including an unmatched multiline backtick.
  // Complete fenced/indented code and single-line code remain protected above.
  assert.equal(count(render('`code\n\\[x\\]\nend`')), 1)
})

test('stream prefixes remain safe and completed delimiters recover on reparsing', () => {
  for (const [open, close] of [['$', '$'], ['$$', '$$'], ['\\(', '\\)'], ['\\[', '\\]']]) {
    assert.equal(count(render(open + 'x')), 0)
    assert.equal(count(render(open + 'x' + close)), 1)
    assert.equal(count(render(open + 'x')), 0)
  }
  assert.equal(count(render('before $$x$$ after')), 1)
  assert.equal(count(render('_inner $y$_')), 1)
  assert.doesNotMatch(render('before $$x$$ after'), /<p>before <p/)
})

test('shared parser retains GFM tables, strike, links and disabled task checkboxes', () => {
  const html = render('| A | B |\n| - | - |\n| ~~old~~ | new |\n\n- [x] done\n- [ ] todo\n\nhttps://example.com')
  assert.match(html, /<table>/)
  assert.match(html, /<s>old<\/s>/)
  assert.equal((html.match(/type="checkbox"/g) ?? []).length, 2)
  assert.equal((html.match(/disabled=/g) ?? []).length, 2)
  assert.match(html, /href="https:\/\/example.com"/)
})
