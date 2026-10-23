import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MAX_YIELD_TIMEOUT_MS, MAX_YIELD_CUSTOM_TEXT_LENGTH, parseYieldAnswer, parseYieldCustomText, parseYieldPolicy, parseYieldQuestion, parseYieldRequest, parseYieldReview } from './yield-contract.ts'

const question = { question: 'Choose?', options: ['A', 'B', 'C'], defaultOption: 'B' }
const request = {
  ...question, id: 'request-1', sessionId: 'root', recipient: { kind: 'user', sessionId: 'root' },
  createdAt: '2026-09-13T12:00:00.000Z', deadline: null,
}

test('answer attachments are copied, bounded and limited to custom human answers; old receipts still parse', () => {
  const answer = { requestId: request.id, option: 'My own answer', custom: true, answeredBy: 'user', answeredAt: request.createdAt }
  const media = ['C:\\fixture\\uploads\\notes.txt']
  const parsed = parseYieldAnswer({ ...answer, media })
  media[0] = 'Changed'
  assert.deepEqual(parsed.media, ['C:\\fixture\\uploads\\notes.txt'])
  assert.equal(parseYieldAnswer(answer).media, undefined)
  for (const fields of [{ media: [] }, { media: [1] }, { media: [''] }, { media: Array(33).fill('file') },
    { media: ['file'], custom: undefined }, { media: ['file'], answeredBy: 'parent' }]) {
    assert.throws(() => parseYieldAnswer({ ...answer, ...fields }), TypeError)
  }
})

test('discussion contracts reject fabricated completion or cross-owner replacement metadata', () => {
  const reference = { sessionId: 'root', physicalId: 'segment', requestId: 'request-1' }
  const review = { id: 'review', reference, kind: 'clarify', question: 'Explain?', sessionId: 'review-session',
    createdAt: request.createdAt, status: 'running' }
  assert.equal(parseYieldReview(review).status, 'running')
  for (const fields of [
    { status: 'completed' }, { status: 'failed' }, { status: 'running', response: 'Done' },
    { status: 'completed', kind: 'revise', response: 'Revised' },
    { status: 'completed', response: 'Explained', replacement: { ...reference, requestId: 'new' } },
    { status: 'completed', kind: 'revise', response: 'Revised', replacement: { ...reference, sessionId: 'other', requestId: 'new' } },
  ]) assert.throws(() => parseYieldReview({ ...review, ...fields }), TypeError)
  assert.equal(parseYieldReview({ ...review, kind: 'revise', status: 'completed', response: 'Revised',
    replacement: { ...reference, requestId: 'new' } }).replacement?.requestId, 'new')
})

test('custom answers trim edges, preserve multiline text and enforce the shared length limit', () => {
  assert.equal(parseYieldCustomText('  A different approach\nwith details  '), 'A different approach\nwith details')
  assert.equal(parseYieldCustomText('a'.repeat(MAX_YIELD_CUSTOM_TEXT_LENGTH)).length, MAX_YIELD_CUSTOM_TEXT_LENGTH)
  for (const value of [undefined, null, 1, [], {}, '', ' \n\t ', 'x'.repeat(MAX_YIELD_CUSTOM_TEXT_LENGTH + 1)]) {
    assert.throws(() => parseYieldCustomText(value), TypeError)
  }
})

test('yield policy accepts only explicit infinite or bounded positive integer timeout', () => {
  for (const timeoutMs of [null, 1, 1000, MAX_YIELD_TIMEOUT_MS]) {
    assert.deepEqual(parseYieldPolicy({ timeoutMs }), { timeoutMs })
  }
  for (const value of [
    undefined, null, [], {}, { timeoutMs: null, unknown: true },
    ...[0, -1, 1.5, NaN, Infinity, MAX_YIELD_TIMEOUT_MS + 1, '1', true, undefined].map(timeoutMs => ({ timeoutMs })),
  ]) assert.throws(() => parseYieldPolicy(value), TypeError)
  const original = { timeoutMs: 10 }
  const parsed = parseYieldPolicy(original)
  original.timeoutMs = 20
  assert.equal(parsed.timeoutMs, 10)
})

test('question requires two or three distinct options and an exact default', () => {
  assert.deepEqual(parseYieldQuestion(question), question)
  assert.deepEqual(parseYieldQuestion({ question: 'Continue?', options: ['Yes', 'No'], defaultOption: 'No' }),
    { question: 'Continue?', options: ['Yes', 'No'], defaultOption: 'No' })
  for (const value of [
    null, [], {}, { ...question, question: '' }, { ...question, question: ' ' },
    { ...question, question: 'x'.repeat(4001) }, { ...question, question: 1 },
    ...[[], ['A'], ['A', 'A'], ['A', 'B', 'C', 'D'], ['A', 'A', 'C'],
      ['A', ' A ', 'C'], ['A', '', 'C'], ['A', ' ', 'C'], ['A', 1, 'C'], [, 'B', 'C'],
      ['A', 'x'.repeat(501), 'C']].map(options => ({ ...question, options })),
    ...['', 'b', ' B', null, 1].map(defaultOption => ({ ...question, defaultOption })),
  ]) assert.throws(() => parseYieldQuestion(value), TypeError)
  assert.equal(parseYieldQuestion({ ...question, question: 'x'.repeat(4000), options: ['A', 'B', 'x'.repeat(500)] }).options[2]!.length, 500)
  const input = { ...question, options: [...question.options] }
  const parsed = parseYieldQuestion(input)
  input.options[0] = 'Changed'
  assert.equal(parsed.options[0], 'A')
})

test('request parser validates recipient, session identity and timestamp shape and returns copies', () => {
  assert.deepEqual(parseYieldRequest(request, 'root'), request)
  const parent = { ...request, recipient: { kind: 'parent', sessionId: 'parent' }, deadline: '2026-09-13T12:00:01.000Z' }
  assert.deepEqual(parseYieldRequest(parent, 'root'), parent)
  for (const value of [
    null, {}, { ...request, id: '' }, { ...request, sessionId: 'other' },
    { ...request, recipient: null }, { ...request, recipient: { kind: 'user', sessionId: 'other' } },
    { ...request, recipient: { kind: 'parent', sessionId: 'root' } },
    { ...request, recipient: { kind: 'parent', sessionId: '' } },
    { ...request, recipient: { kind: 'unknown', sessionId: 'root' } },
    { ...request, createdAt: 'invalid' }, { ...request, createdAt: 123 },
    { ...request, deadline: 'invalid' }, { ...request, deadline: 123 },
    { ...request, options: ['A'] },
  ]) assert.throws(() => parseYieldRequest(value, 'root'), TypeError)
  const input = { ...request, recipient: { ...request.recipient }, options: [...request.options] }
  const parsed = parseYieldRequest(input, 'root')
  input.options[0] = 'Changed'
  input.recipient.sessionId = 'other'
  assert.equal(parsed.options[0], 'A')
  assert.equal(parsed.recipient.sessionId, 'root')
})

test('decision references are bounded, distinct and copied without accepting a routing override', () => {
  const source = { sessionId: 'child', physicalId: 'child-0', requestId: 'question' }
  for (const sources of [null, [], [source, source], [source, source, source, source],
    [{}], [{ ...source, recipient: 'other' }], [{ ...source, requestId: '' }], [, source]]) {
    assert.throws(() => parseYieldQuestion({ ...question, sources }), TypeError)
  }
  const input = { ...request, sources: [source], origin: { physicalId: 'root-0', toolCallId: 'ask' } }
  const parsed = parseYieldRequest(input, 'root')
  source.requestId = 'changed'
  input.origin.physicalId = 'changed'
  assert.equal(parsed.sources?.[0]?.requestId, 'question')
  assert.equal(parsed.origin?.physicalId, 'root-0')
  assert.deepEqual(parsed.recipient, request.recipient)
})
