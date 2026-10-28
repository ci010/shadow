import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import { createSSRApp, defineComponent, h, type Component } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { compileScript, parse } from 'vue/compiler-sfc'
import ts from 'typescript'
import { groupToolActivity } from './tool-activity.ts'

test('tool entry headers render duration for completed calls only, including zero and failures', async () => {
  const url = new URL('./components/ToolActivityGroup.vue', import.meta.url)
  const { descriptor } = parse(readFileSync(url, 'utf8'))
  const source = compileScript(descriptor, { id: 'tool-duration', inlineTemplate: true }).content
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
  const module = { exports: {} as { default: Component } }
  const require = createRequire(url)
  new Function('require', 'module', 'exports', outputText)((id: string) => id.endsWith('.vue')
    ? { default: defineComponent({ render: () => h('span') }) } : require(id), module, module.exports)
  const batch = groupToolActivity([
    { event: 'tool_call', content: '', timestamp: '2026-01-01T00:00:00Z', toolCall: { name: 'read', arguments: {} } },
    { event: 'tool_result', content: 'ok', timestamp: '2026-01-01T00:00:00Z' },
    { event: 'tool_call', content: '', timestamp: '2026-01-01T00:00:00Z', toolCall: { name: 'exec', arguments: {} } },
    { event: 'tool_result', content: 'Error: fixture', timestamp: '2026-01-01T00:00:01.234Z' },
    { event: 'tool_call', content: '', toolCall: { name: 'read', arguments: {} } },
  ]).get(0)!
  const completeBatch = groupToolActivity([
    { event: 'tool_call', content: '', timestamp: '2026-01-01T00:00:00Z' },
    { event: 'tool_result', content: 'ok', timestamp: '2026-01-01T00:00:05Z' },
  ]).get(0)!
  const completeHtml = await renderToString(createSSRApp(module.exports.default, { batch: completeBatch }))
  const summary = completeHtml.slice(0, completeHtml.indexOf('</summary>'))
  assert.match(summary, /class="activity-title"/)
  assert.match(summary, /class="tool-duration"[^>]*>≈ 5\.0 s<\/span>/)
  const html = await renderToString(createSSRApp(module.exports.default, { batch }))
  assert.match(html, /class="tool-duration"[^>]*>≈ 0 ms<\/span>/)
  assert.match(html, /class="tool-duration"[^>]*>≈ 1\.2 s<\/span>/)
  assert.equal((html.match(/class="tool-duration"/g) ?? []).length, 2)
  // Failures remain visible on individual calls, without opening disclosures
  // or adding an aggregate error badge to the group header.
  const groupSummary = html.slice(0, html.indexOf('</summary>'))
  assert.doesNotMatch(groupSummary, /activity-failed/)
  assert.match(html, /class="activity-failed"/)
  assert.doesNotMatch(html, /<details[^>]*\sopen(?:[\s=>])/)
  const openHtml = await renderToString(createSSRApp(module.exports.default, { batch, defaultOpen: true }))
  assert.match(openHtml, /^<details[^>]*\sopen(?:[\s=>])/)
  assert.doesNotMatch(openHtml, /<details[^>]*class="tool-entry"[^>]*\sopen(?:[\s=>])/)
})
