import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

test('tool-only completed responses retain cost usage in the live message list', () => {
  const source = readFileSync(new URL('./components/ChatTab.vue', import.meta.url), 'utf8')
  const start = source.indexOf('function flushStreamResponse(')
  const end = source.indexOf('\nfunction resetStreamPresentation(', start)
  assert.ok(start >= 0 && end > start)
  const { outputText } = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } })
  const messages: { value: Array<Record<string, unknown>> } = { value: [] }
  let resets = 0
  const flush = new Function('messages', 'messageAttachments', 'resetStreamPresentation', `${outputText}; return flushStreamResponse`)(
    messages, (text: string, paths: string[] = []) => ({ text, paths }), () => { resets++ },
  )
  const usage = { promptTokens: 100, completionTokens: 10, totalTokens: 110, costs: [{ amount: .1, currency: 'AI_CREDITS' }] }
  const state = { accumulated: '', responseContext: { responseId: 'tool-only' }, timestamp: '2026-10-18T00:00:00Z' }
  flush(state, usage)
  assert.equal(messages.value.length, 1)
  assert.deepEqual(messages.value[0]?.usage, usage)
  assert.deepEqual(messages.value[0]?.responseContext, { responseId: 'tool-only' })
  assert.equal(state.responseContext, undefined)
  flush({ accumulated: '' })
  assert.equal(messages.value.length, 1, 'an entirely empty event without usage remains invisible')
  assert.equal(resets, 2)
})
