import assert from 'node:assert/strict'
import test from 'node:test'
import { inlineAskRounds } from './inline-ask-history.ts'
import { inlineAnswerTarget, parseInlineAskCall, validateInlineAnswers, type InlineAskRequest } from './inline-ask.ts'
import { inlineInputQuestions } from './input-history.ts'
import { groupToolActivity, type ToolActivityMessage } from './tool-activity.ts'

const stamp = '2026-10-12T08:00:00.000Z'
const first = { content: '**Which** file?', options: ['First', 'Second'] as [string, string] }
const second = { content: 'Which format?', options: ['  TXT  ', 'CSV'] as [string, string] }
const request: InlineAskRequest = { kind: 'input', id: 'round', sessionId: 'owner', origin: { physicalId: 'p', toolCallId: 'a' },
  recipient: { kind: 'user', sessionId: 'owner' }, question: first.content, questions: [first, second], createdAt: stamp, deadline: null }
const call = (toolCallId: string, args: Record<string, unknown> = { questions: request.questions }): ToolActivityMessage =>
  ({ event: 'tool_call', content: '', toolCall: { name: 'ask', arguments: args }, toolCallId, timestamp: stamp })
const answers = [{ text: 'My own file', media: ['/uploads/answer.txt'] }, { option: second.options[0] }]
const receipt = { requestId: request.id, text: 'My own file\n  TXT  ', answeredBy: 'user' as const, answeredAt: stamp, answers }
const result = (toolCallId: string, value: unknown = receipt): ToolActivityMessage =>
  ({ event: 'tool_result', content: JSON.stringify(value), toolCallId })

test('projects a linked live round, replacing its ordinary tool row and not changing legacy input', () => {
  const messages = [call('other'), call('a'), call('legacy', { kind: 'input', question: 'Legacy input' })]
  const view = inlineAskRounds(messages, request)
  assert.equal(view.entries.get(0)?.status, 'unknown')
  assert.equal(view.entries.get(1)?.status, 'waiting-user')
  assert.deepEqual(view.entries.get(1)?.questions, [first, second])
  assert.deepEqual(view.unlinked, [])
  assert.deepEqual([...view.excluded], [0, 1])
  assert.equal(inlineInputQuestions(messages).entries.get(2)?.question, 'Legacy input')
})

test('physical rollover and an unlinked snapshot never attach live controls to a similarly worded older call', () => {
  const unlinked = inlineAskRounds([call('a')], request, null, () => 'older')
  assert.equal(unlinked.entries.get(0)?.status, 'unknown')
  assert.equal(unlinked.unlinked[0]?.requestId, request.id)
  const linked = inlineAskRounds([call('a'), call('a'), result('a')], request, null, i => i === 0 ? 'older' : 'p')
  assert.equal(linked.entries.get(0)?.status, 'unknown')
  assert.equal(linked.entries.get(1)?.status, 'user')
  assert.deepEqual(linked.unlinked, [])
})

test('confirmation bridges the wait to history; a stored paired receipt wins and never duplicates', () => {
  const confirmed = { request, receipt }
  assert.equal(inlineAskRounds([], request, confirmed).unlinked[0]?.status, 'user')
  assert.deepEqual(inlineAskRounds([call('a')], null, confirmed).entries.get(0)?.receipt?.answers, answers)
  const messages = [call('a'), result('a')]
  const restored = inlineAskRounds(messages, request, confirmed)
  assert.deepEqual(restored.entries.get(0)?.receipt, receipt)
  assert.deepEqual([...restored.excluded], [0, 1])
  assert.equal(groupToolActivity(messages, restored.excluded).size, 0)
  assert.equal(restored.unlinked.length, 0)
})

test('malformed calls stay in tools and malformed or terminal outcomes do not show active controls', () => {
  assert.equal(inlineAskRounds([call('a', { ...first, kind: 'input' })], null).excluded.size, 0)
  assert.equal(inlineAskRounds([call('a'), result('a', { ...receipt, answers: [{ option: 'Fake' }] })], request).entries.get(0)?.status, 'unknown')
  assert.equal(inlineAskRounds([call('a'), { ...result('a'), content: 'Error: Input cancelled by user.', isError: true }], request).entries.get(0)?.status, 'cancelled')
})

test('validates exact ordered options, enforces a complete round, and targets explicit or first unanswered', () => {
  assert.deepEqual(parseInlineAskCall(first), [first])
  assert.equal(parseInlineAskCall({ ...first, options: ['First', 'First'] }), undefined)
  assert.equal(parseInlineAskCall({ questions: [first, first, first, first] }), undefined)
  assert.deepEqual(validateInlineAnswers(request.questions, answers), answers)
  assert.equal(validateInlineAnswers(request.questions, [answers[0], { option: 'TXT' }]), undefined)
  assert.equal(validateInlineAnswers(request.questions, [answers[0]]), undefined)
  assert.equal(validateInlineAnswers(request.questions, [{ option: 'CSV' }, { option: 'First' }]), undefined)
  assert.equal(inlineAnswerTarget([answers[0], undefined]), 1)
  assert.equal(inlineAnswerTarget([undefined, answers[1]], 1), 1)
  assert.equal(inlineAnswerTarget(answers), -1)
})
