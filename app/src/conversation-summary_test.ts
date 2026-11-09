import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { compileStyle, compileTemplate, parse } from 'vue/compiler-sfc'

test('summary uses the event card surface and retains lazy native disclosure', () => {
  const filename = new URL('./components/ConversationSummary.vue', import.meta.url).pathname
  const { descriptor } = parse(readFileSync(filename, 'utf8'))
  const template = descriptor.template!.content
  assert.deepEqual(compileTemplate({ source: template, filename, id: 'summary' }).errors, [])
  assert.match(template, /<details[^>]+@toggle.self="onToggle"/)
  assert.match(template, /v-if="expanded"/)
  assert.ok(template.indexOf('summary-icon') < template.indexOf('compaction-summary-title'))
  assert.ok(template.indexOf('summary-chevron') > template.indexOf('compaction-summary-title'))
  const style = descriptor.styles[0]!.content
  assert.deepEqual(compileStyle({ source: style, filename, id: 'summary', scoped: true }).errors, [])
  assert.match(style, /background: var\(--c-chat-action-bg\)/)
  assert.match(style, /border: 1px solid var\(--c-chat-border\)/)
  assert.doesNotMatch(style, /border-left:/)
  assert.match(style, /max-width: 700px/)
  assert.match(style, /:focus-visible/)
})
