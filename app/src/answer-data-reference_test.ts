import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { encodeAnswerData } from '../../src/shared/answer-data.ts'
import { latestAnswerData, splitAnswerDataReference } from './answer-data-reference.ts'

const reference = '```answer-data\nlatest\n```'
const prose = 'Here is the computed result.'
const data = { kind: 'line', title: 'Computed sales', columns: ['Label', 'Count'], rows: [['<img src=bad>', -1], ['B', 5]] }
const content = encodeAnswerData(data)
const result = { role: 'assistant', event: 'tool_result', toolName: 'exec', toolCallId: 'call-a', content, responseContext: { turnId: 'turn-a' } }
const answer = { role: 'assistant', content: `${prose}\n\n${reference}`, responseContext: { turnId: 'turn-a' } }

test('answer-data references are complete top-level trailing fences', () => {
  assert.equal(splitAnswerDataReference(answer.content), prose)
  assert.equal(splitAnswerDataReference(reference), '')
  for (const bad of [reference.slice(0, -1), `${reference}\nMore prose`, `\`\`\`md\n${reference}`, reference.replace('latest', '../somewhere'), reference.replace('latest', 'https://example.test'), reference.replace('latest', ' latest'), reference.replace('latest', '1')]) {
    assert.equal(splitAnswerDataReference(bad), undefined, bad)
  }
})

test('only preceding complete exec results in the exact turn resolve, including after reload', () => {
  const history = JSON.parse(JSON.stringify([result, answer]))
  assert.deepEqual(latestAnswerData(history, 1, 'turn-a'), data)
  assert.equal(latestAnswerData(history, 1, 'turn-b'), undefined)
  assert.equal(latestAnswerData(history, 0, 'turn-a'), undefined)
  assert.equal(latestAnswerData(history, 1, undefined), undefined)
  assert.equal(latestAnswerData([{ ...result, content: content.slice(0, -1) }], 1, 'turn-a'), undefined)
  assert.equal(latestAnswerData([{ ...result, toolName: 'read' }], 1, 'turn-a'), undefined)
  assert.equal(latestAnswerData([{ ...result, toolCallId: undefined }], 1, 'turn-a'), undefined)
})

test('the Markdown answer body renders the rehydrated native chart, never an incomplete or cross-turn reference', async t => {
  const server = await createServer({ root: resolve('app'), configFile: false, optimizeDeps: { noDiscovery: true, include: [] }, plugins: [vue()], server: { middlewareMode: true, ws: false } })
  t.after(() => server.close())
  const { default: MarkdownContent } = await server.ssrLoadModule('/src/components/MarkdownContent.vue')
  const history = JSON.parse(JSON.stringify([result, answer]))
  const render = (text: string, turnId: string) => renderToString(createSSRApp({
    render: () => h(MarkdownContent, { text, answerData: latestAnswerData(history, 1, turnId), renderContent: (source: string) => `<p>${source.replaceAll('<', '&lt;')}</p>` }),
  }))
  const html = await render(answer.content, 'turn-a')
  assert.match(html, /Here is the computed result\.<\/p>.*<figure/s)
  assert.match(html, /<polyline/)
  assert.match(html, /&lt;img src=bad&gt;/)
  assert.doesNotMatch(html, /<img|```answer-data/)
  assert.doesNotMatch(await render(answer.content.slice(0, -1), 'turn-a'), /<figure/)
  assert.doesNotMatch(await render(answer.content, 'turn-b'), /<figure/)
})
