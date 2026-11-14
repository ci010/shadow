import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createMarkdown } from './markdown.ts'

const md = createMarkdown()

test('shared parser supports CJK punctuation boundaries without display-only repairs', () => {
  for (const label of ['重要提示：', '中文（带括号）', '重点。', '中文【说明】', '重要提示（Important Notice）：']) {
    assert.equal(md.render(`这是**${label}**后续中文`), `<p>这是<strong>${label}</strong>后续中文</p>\n`)
    assert.equal(md.render(`这是*${label}*后续中文`), `<p>这是<em>${label}</em>后续中文</p>\n`)
  }
  assert.equal(md.render('这是~~删除。~~后续中文'), '<p>这是<s>删除。</s>后续中文</p>\n')
  assert.match(md.render('**重点：*说明。*结束。**后文'), /<strong>重点：<em>说明。<\/em>结束。<\/strong>后文/)
  assert.match(md.render('> **重点。**后文'), /<strong>重点。<\/strong>后文/)
  assert.match(md.render('| 内容 |\n| --- |\n| **重点。**后文 |'), /<td><strong>重点。<\/strong>后文<\/td>/)
})

test('CJK parsing preserves literal boundaries, math and streaming prefixes', () => {
  assert.equal(md.render('`**重点。**后文`'), '<p><code>**重点。**后文</code></p>\n')
  assert.equal(md.render('\\*\\*重点。\\*\\*后文'), '<p>**重点。**后文</p>\n')
  assert.match(md.render('```text\n**重点。**后文\n```'), /\*\*重点。\*\*后文/)
  assert.match(md.render('**重点。**后文 $x_1$'), /<strong>重点。<\/strong>后文 <span class="katex"/)
  assert.equal(md.render('**English.**adjacent'), '<p>**English.**adjacent</p>\n')
  for (const prefix of ['*', '**', '**重点。', '**重点。*']) assert.doesNotThrow(() => md.render(prefix))
  assert.equal(md.render('**重点。**后文'), '<p><strong>重点。</strong>后文</p>\n')
  assert.equal(createMarkdown({ html: false, math: false }).render('**重点。**后文'), '<p><strong>重点。</strong>后文</p>\n')
})
