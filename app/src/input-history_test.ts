import assert from 'node:assert/strict'
import test from 'node:test'
import { inlineInputQuestions } from './input-history.ts'
import { inlineYieldDecisions } from './yield-history.ts'
import type { InputRequest } from '../../src/sessions/input-request.ts'
import type { ToolActivityMessage } from './tool-activity.ts'
const at = '2026-10-12T08:00:00.000Z'
const ask = (id = 'a', question = 'Which file?'): ToolActivityMessage => ({ event: 'tool_call', content: '', toolCallId: id, toolCall: { name: 'ask', arguments: { kind: 'input', question } } })
const receipt = (id = 'a', text = 'report.txt', extra = {}): ToolActivityMessage => ({ event: 'tool_result', content: JSON.stringify({ requestId: `request-${id}`, text, answeredBy: 'user', answeredAt: at, ...extra }), toolCallId: id })
const pending = (extra: Partial<InputRequest> = {}): InputRequest => ({ kind: 'input', id: 'request-a', sessionId: 'owner', question: 'Which file?', origin: { physicalId: 'physical', toolCallId: 'a' }, recipient: { kind: 'user', sessionId: 'owner' }, createdAt: at, deadline: null, ...extra })

test('restored input calls pair answers by tool id, including out-of-order results and attachments', () => {
  const messages = [ask(), ask('b', 'Which date?'), receipt('b', 'Tomorrow'), receipt('a', 'report.txt', { media: ['/uploads/report.txt'] })]
  const history = inlineInputQuestions(messages)
  assert.equal(history.entries.get(0)?.answer?.text, 'report.txt')
  assert.equal(history.entries.get(1)?.answer?.text, 'Tomorrow')
  assert.deepEqual(history.entries.get(0)?.answer?.media, ['/uploads/report.txt'])
  assert.deepEqual([...history.excluded], [0, 3, 1, 2])
  assert.equal(inlineYieldDecisions(messages).entries.size, 0)
})

test('only live pending establishes waiting; clearing it never fabricates an answer', () => {
  assert.equal(inlineInputQuestions([ask()]).entries.get(0)?.status, 'unknown')
  for (const kind of ['user', 'parent', 'caller'] as const) {
    assert.equal(inlineInputQuestions([ask()], pending({ recipient: { kind, sessionId: 'owner' } })).entries.get(0)?.status, `waiting-${kind}`)
  }
  assert.equal(inlineInputQuestions([ask(), receipt()], pending()).entries.get(0)?.status, 'user')
  assert.equal(inlineInputQuestions([], pending()).unlinked?.status, 'waiting-user')
})

test('explicit origin does not attach live pending to an unrelated repeated question', () => {
  const history = inlineInputQuestions([ask('other')], pending())
  assert.equal(history.entries.get(0)?.status, 'unknown')
  assert.equal(history.unlinked?.requestId, 'request-a')
})

test('malformed and decision receipts do not count as input answers; errors and cancellation are explicit', () => {
  for (const content of ['{}', 'not JSON', JSON.stringify({ requestId: 'request-a', option: 'Yes', answeredBy: 'user', answeredAt: at }), JSON.stringify({ requestId: 'request-a', text: 'Yes', answeredBy: 'timeout', answeredAt: at })]) {
    assert.equal(inlineInputQuestions([ask(), { ...receipt(), content }]).entries.get(0)?.status, 'unknown')
  }
  for (const [content, expected] of [['Error: network failed', 'failed'], ['Error: Input cancelled by user.', 'cancelled'], ['AbortError: stopped', 'cancelled']]) {
    const entry = inlineInputQuestions([ask(), { ...receipt(), content }], pending()).entries.get(0)
    assert.equal(entry?.status, expected)
    assert.equal(entry?.answer, undefined)
  }
  assert.equal(inlineInputQuestions([ask('a', '')]).entries.size, 0)
})

test('legacy serialized calls and invoke_tool wrappers restore without losing raw details', () => {
  for (const message of [
    { event: 'tool_call', toolCallId: 'a', content: 'ask({"kind":"input","question":"Which file?"})' },
    { event: 'tool_call', toolCallId: 'a', content: '', toolCall: { name: 'invoke_tool', arguments: { name: 'ask', args: { kind: 'input', question: 'Which file?' } } } },
  ]) {
    const entry = inlineInputQuestions([message, receipt()]).entries.get(0)
    assert.equal(entry?.answer?.text, 'report.txt')
    assert.ok(entry?.arguments)
    assert.ok(entry?.result)
  }
})

test('attachment annotations after a receipt retain the confirmed answer', () => {
  const result = receipt('a', 'See attached', { media: ['/uploads/file.txt'] })
  result.content += '\n[file: /uploads/file.txt]\nImage snapshots: image.png'
  const entry = inlineInputQuestions([ask(), result]).entries.get(0)!
  assert.equal(entry.status, 'user')
  assert.deepEqual(entry.answer?.media, ['/uploads/file.txt'])
})
