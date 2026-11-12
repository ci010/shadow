import { test } from 'node:test'
import assert from 'node:assert/strict'
import { projectHistoryMessages } from './history-wire.ts'

test('HTTP message projection omits only top-level null without mutating business payloads', () => {
  const content = [{ type: 'text', text: '', userValue: null }]
  const tool_calls = [{ id: 'call', function: { name: 'example', arguments: '{"value":null}' }, result: { value: null } }]
  const provider_state = { opaque: { value: null } }
  const input = [Object.freeze({ role: 'assistant', content: null, reasoning_content: null, reasoning_text: null,
    tool_calls, provider_state, empty: '', disabled: false, count: 0, list: [] }),
  { role: 'user', content }, { role: 'tool', content: '{"value":null}' }]
  const projected = projectHistoryMessages(input)
  assert.deepEqual(projected[0], { role: 'assistant', tool_calls, provider_state, empty: '', disabled: false, count: 0, list: [] })
  assert.equal(projected[0].tool_calls, tool_calls)
  assert.equal(projected[0].provider_state, provider_state)
  assert.equal(projected[1].content, content)
  assert.equal(projected[2].content, '{"value":null}')
  assert.equal(input[0].content, null)
  assert.deepEqual(projectHistoryMessages(projected), projected)
})

test('synthetic tool-only history byte reduction is exactly the omitted fields', () => {
  const messages = Array.from({ length: 100 }, (_, i) => ({ role: 'assistant', content: null,
    reasoning_content: null, reasoning_text: null,
    tool_calls: [{ id: `call-${i}`, type: 'function', function: { name: 'read', arguments: '{"value":null}' } }] }))
  const before = Buffer.byteLength(JSON.stringify(messages))
  const after = Buffer.byteLength(JSON.stringify(projectHistoryMessages(messages)))
  assert.equal(before - after, 100 * Buffer.byteLength(',"content":null,"reasoning_content":null,"reasoning_text":null'))
  console.log(`Synthetic history (100 tool-only messages): ${before} -> ${after} bytes (${before - after} saved)`)
})
