import assert from 'node:assert/strict'
import test from 'node:test'
import { Marked } from 'marked'
import { markedMath } from './marked-math.ts'

const marked = new Marked({ breaks: true }).use(markedMath())
const render = (source: string) => marked.parse(source, { async: false }) as string
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
  const html = render(String.raw`before \(\mathbf x\) and $x^2$ and $$x+1$$ after`)
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
    '`code\n\\[x\\]\nend`',
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
