import assert from 'node:assert/strict'
import test from 'node:test'
import { readableMcpText } from './text.ts'

test('encoded JSON wrappers become readable without changing rawResponse or any parsed value', () => {
  const original = String.raw`{"rawResponse":"{\u0022value\u0022:[{\u0022subject\u0022:\u0022\u4f60\u597d \u0026 \u002b\u0022}]}","hasMoreResults":false}`
  const readable = readableMcpText(original)
  assert.deepEqual(JSON.parse(readable), JSON.parse(original))
  assert.match(readable, /你好 & \+/)
  assert.doesNotMatch(readable, /\\u0022/)
  assert.equal(typeof JSON.parse(readable).rawResponse, 'string')
})

test('literal escapes, surrogate pairs, exact numbers and duplicate keys keep their semantics', () => {
  const original = String.raw`{"literal":"\\u4f60","emoji":"\ud83d\ude00","id":9007199254740993123,"huge":1e400,"value":"\u0041","value":"\u0042"}`
  const readable = readableMcpText(original)
  assert.match(readable, /"literal":"\\\\u4f60"/)
  assert.match(readable, /😀/)
  assert.match(readable, /9007199254740993123/)
  assert.match(readable, /1e400/)
  assert.match(readable, /"value":"A","value":"B"/)
  assert.deepEqual(JSON.parse(readable), JSON.parse(original))
})

test('ordinary text and invalid or truncated JSON are not globally unescaped', () => {
  for (const text of [String.raw`Use \u0041 in a regex`, String.raw`{"value":"\u0041"`, '{"text":"already readable"}']) {
    assert.equal(readableMcpText(text), text)
  }
})
