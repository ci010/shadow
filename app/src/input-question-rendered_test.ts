import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import { createSSRApp, defineComponent, h, type Component } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { compileScript, parse } from 'vue/compiler-sfc'
import ts from 'typescript'
import { inlineInputQuestions, type InputQuestion } from './input-history.ts'

const url = new URL('./components/InputQuestion.vue', import.meta.url)
const { descriptor } = parse(readFileSync(url, 'utf8'))
const compiled = compileScript(descriptor, { id: 'input-question', inlineTemplate: true })
const { outputText } = ts.transpileModule(compiled.content, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
const module = { exports: {} as { default: Component } }
const require = createRequire(url)
const { i18n } = require('../i18n.ts') as typeof import('./i18n.ts')
const attachmentProbe = defineComponent({ props: ['paths', 'sessionId', 'apiBase'], setup: props => () => h('div', { 'data-attachments': JSON.stringify(props.paths), 'data-session': props.sessionId }) })
const empty = defineComponent({ render: () => null })
new Function('require', 'module', 'exports', outputText)((id: string) => id.endsWith('.vue') ? { default: id.includes('MessageAttachments') ? attachmentProbe : empty } : require(id), module, module.exports)
const render = (entry: InputQuestion) => renderToString(createSSRApp(module.exports.default, { entry, apiBase: 'http://fixture', sessionId: 'owner' }))

test('restored question and confirmed answer render together safely in English and Chinese', async () => {
  const question = '<script>alert(1)</script>\nWhich file?'
  const answer = '<img src=x onerror=alert(1)>\n文件.txt'
  const entry = inlineInputQuestions([
    { event: 'tool_call', toolCallId: 'a', content: '', toolCall: { name: 'ask', arguments: { kind: 'input', question } } },
    { event: 'tool_result', toolCallId: 'a', content: JSON.stringify({ requestId: 'r', text: answer, answeredBy: 'user', answeredAt: '2026-10-12T08:00:00.000Z', media: ['/uploads/file.txt'] }) },
  ]).entries.get(0)!
  const original = i18n.global.locale.value
  try {
    for (const locale of ['en', 'zh-CN'] as const) {
      i18n.global.locale.value = locale
      const html = await render(entry)
      assert.match(html, /<article[^>]*data-request-id="r"/)
      assert.match(html, /<h2[^>]*>.*&lt;script&gt;/s)
      assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/)
      assert.doesNotMatch(html, /<script|<img|Decision|Timeout default/)
      assert.match(html, /data-attachments="\[&quot;\/uploads\/file.txt&quot;\]"/)
      assert.match(html, /data-session="owner"/)
      assert.ok(html.includes(locale === 'en' ? 'Answered by user' : '用户已回答'))
    }
  } finally { i18n.global.locale.value = original }
})

test('waiting, missing, failed and cancelled render distinct text without an answer section', async () => {
  i18n.global.locale.value = 'en'
  for (const [status, label] of [['waiting-user', 'Needs your reply'], ['waiting-parent', 'Waiting for parent'], ['waiting-caller', 'Waiting for caller'], ['unknown', 'No confirmed answer'], ['failed', 'Question did not complete'], ['cancelled', 'Question cancelled']] as const) {
    const html = await render({ question: 'Need a filename', status })
    assert.ok(html.includes(label))
    assert.doesNotMatch(html, /class="input-answer/)
    assert.doesNotMatch(html, /Approved|Default selected/)
  }
})
