import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'
import { groupToolActivity } from './tool-activity.ts'

const source = readFileSync(new URL('./components/ChatTab.vue', import.meta.url), 'utf8')
function extract(startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker), end = source.indexOf(endMarker, start)
  assert.ok(start >= 0 && end > start)
  return ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
}

test('history collapse preserves result timing by ID and leaves legacy timing absent', () => {
  const code = extract('function collapseHistory(', '\n// ── Session list')
  const collapse = new Function('groupSenderNames', 'isDirectChat', 'rawTextContent', 'rawMediaContent', 'toolImages',
    `${code}; return collapseHistory`)(() => [], { value: true }, (m: { content: string }) => m.content ?? '', () => [], () => [])
  const raw = [
    { role: 'assistant', content: '', timestamp: '2026-01-01T00:00:00.000Z', tool_calls: [
      { id: 'a', function: { name: 'read', arguments: '{}' } },
      { id: 'b', function: { name: 'exec', arguments: '{}' } },
      { id: 'legacy', function: { name: 'read', arguments: '{}' } },
    ] },
    { role: 'tool', content: 'b', tool_call_id: 'b', timestamp: '2026-01-01T00:00:01.234Z' },
    { role: 'tool', content: 'a', tool_call_id: 'a', timestamp: '2026-01-01T00:00:00.000Z' },
    { role: 'tool', content: 'legacy', tool_call_id: 'legacy' },
    { role: 'tool', content: 'orphan', tool_call_id: 'orphan', timestamp: '2026-01-01T00:00:00.012Z' },
  ]
  const entries = groupToolActivity(collapse(raw)).get(0)!.entries
  assert.deepEqual(entries.map(e => e.durationMs), [0, 1234, undefined, undefined])
})

test('live calls and results use local receipt timestamps', () => {
  const code = extract('function applyStreamPayload(', '\nfunction flushStreamResponse(')
  const messages: { value: Array<Record<string, unknown>> } = { value: [] }
  const apply = new Function('messages', 'streamPhase', 'streamingToolCallData', 'flushStreamResponse', 'scrollToBottom',
    `${code}; return applyStreamPayload`)(messages, { value: '' }, { value: null }, () => {}, () => {})
  apply({ event: 'tool_call', toolCallId: 'a', toolName: 'read' }, {})
  const start = Date.parse(messages.value[0].timestamp as string)
  assert.ok(Number.isFinite(start))
  apply({ event: 'tool_result', toolCallId: 'a', toolName: 'read', content: 'ok' }, {})
  assert.ok(Date.parse(messages.value[1].timestamp as string) >= start)
  assert.ok(groupToolActivity(messages.value as any).get(0)!.durationMs! >= 0)
  apply({ event: 'tool_result', toolName: 'read', content: 'legacy' }, {})
  assert.ok(Number.isFinite(Date.parse(messages.value[2].timestamp as string)))
})
