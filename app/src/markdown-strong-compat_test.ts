import assert from 'node:assert/strict'
import test from 'node:test'
import { Marked } from 'marked'
import { paddedStrongCompatibility } from './markdown-strong-compat.ts'

const standard = new Marked({ breaks: true })
const compatible = new Marked({ breaks: true }).use(paddedStrongCompatibility())
const render = (source: string) => compatible.parse(source, { async: false })

test('display tolerates padded Chinese strong labels without changing source', () => {
  const source = '**验证： **4 项专项测试及 Vue 类型检查通过。'
  assert.equal(render(source), '<p><strong>验证：</strong>4 项专项测试及 Vue 类型检查通过。</p>\n')
  assert.equal(source, '**验证： **4 项专项测试及 Vue 类型检查通过。')
  for (const label of ['** 验证： **', '** 验证：**', '**验证： **']) {
    assert.equal(render(label), '<p><strong>验证：</strong></p>\n')
    assert.match(render(`- ${label}4 项\n  - ** 结果： **通过`), /<li><strong>验证：<\/strong>4 项/)
    assert.match(render(`1. ${label}4 项`), /<li><strong>验证：<\/strong>4 项/)
  }
  assert.equal(render('甲。** 验证 ** 和 ** 结果 **'), '<p>甲。<strong>验证</strong> 和 <strong>结果</strong></p>\n')
})

test('standard Markdown stays byte-for-byte compatible', () => {
  const cases = [
    '**hello world**', '**中文 内部 空格**', '**验证：**4 项', '*emphasis* and ***strong emphasis***',
    '```md\n** 验证 **\n```', '    ** 验证 **', '`** 验证 **`', '``** 验证 **``',
    String.raw`\*\* 验证： **`, String.raw`** 验证： \**`, String.raw`\*** 验证 **`,
    '$** 验证 **$', '$$** 验证 **$$', '\x00MATH0\x00',
    '[** 验证 **](https://example.com/**test** "** 标题 **")',
    '![** 验证 **](https://example.com/a.png)',
    '<span>** 验证 **</span>', '<code>** 验证 **</code>', '<div>\n** 验证 **\n</div>',
    '<https://example.com/**test**>', '** unmatched', '** **', '*** 验证 ***', '**** 验证 ****',
    'a** label **b', '** line\nbreak **', '** nested *text* **', '** [link](url) **',
    '** $math$ **', '** `code` **', '** <b>html</b> **',
  ]
  for (const source of cases) assert.equal(render(source), standard.parse(source, { async: false }), source)
})

test('compatibility applies in blockquotes and tables, with escape boundaries intact', () => {
  assert.match(render('> ** 验证 **通过'), /<blockquote>\n<p><strong>验证<\/strong>通过/)
  assert.match(render('| 结果 |\n| --- |\n| ** 验证 ** |'), /<td><strong>验证<\/strong><\/td>/)
  assert.equal(render(String.raw`\** 验证 **`), standard.parse(String.raw`\** 验证 **`, { async: false }))
})

test('CJK punctuation-ended strong remains bold before adjacent prose', () => {
  for (const punctuation of ['。', '，', '：', '！', '？', '；', '）', '”', '.']) {
    const label = `首选 Sahil Tara，次选 Pankaj Gaur${punctuation}`
    for (const prefix of ['', '建议']) {
      assert.equal(render(`${prefix}**${label}**两人都有经验`),
        `<p>${prefix}<strong>${label}</strong>两人都有经验</p>\n`)
    }
  }
  assert.equal(render('**重点。**说明，**其次。**继续'),
    '<p><strong>重点。</strong>说明，<strong>其次。</strong>继续</p>\n')
  assert.match(render('> **重点。**说明'), /<strong>重点。<\/strong>说明/)
  assert.match(render('| 结果 |\n| --- |\n| **重点。**说明 |'), /<td><strong>重点。<\/strong>说明<\/td>/)
})

test('CJK repair preserves protected, ambiguous and incomplete Markdown', () => {
  const cases = [
    '`**重点。**说明`', '```md\n**重点。**说明\n```',
    String.raw`\**重点。**说明`, String.raw`**重点。\**说明`,
    '**包含 `**` 的代码。**说明', '***重点。***说明', '****重点。****说明',
    '**包含 *强调*。**说明', '**跨行\n重点。**说明',
    '[**重点。**说明](https://example.com)', '![**重点。**说明](image.png)',
    '<span>**重点。**说明</span>', '$**重点。**说明$',
    'a**label.**b', 'a**重点。**说明', '**重点。**English',
    '**重点。', '**重点。*', '**重点。**',
  ]
  for (const source of cases) assert.equal(render(source), standard.parse(source, { async: false }), source)
  // Streaming reparses the accumulated source; only the completed boundary changes.
  assert.equal(render('**重点。**说'), '<p><strong>重点。</strong>说</p>\n')
})
