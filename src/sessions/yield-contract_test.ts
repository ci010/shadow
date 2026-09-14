import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MAX_YIELD_TIMEOUT_MS, parseYieldPolicy, parseYieldQuestion, parseYieldRequest } from './yield-contract.ts'

const question = { question: 'Choose?', options: ['A', 'B', 'C'], defaultOption: 'B' }
const request = {
  ...question, id: 'request-1', sessionId: 'root', recipient: { kind: 'user', sessionId: 'root' },
  createdAt: '2026-09-13T12:00:00.000Z', deadline: null,
}

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

test('question requires exactly three distinct options and an exact default', () => {
  assert.deepEqual(parseYieldQuestion(question), question)
  for (const value of [
    null, [], {}, { ...question, question: '' }, { ...question, question: ' ' },
    { ...question, question: 'x'.repeat(4001) }, { ...question, question: 1 },
    ...[[], ['A'], ['A', 'B'], ['A', 'B', 'C', 'D'], ['A', 'A', 'C'],
      ['A', ' A ', 'C'], ['A', '', 'C'], ['A', ' ', 'C'], ['A', 1, 'C'], [, 'B', 'C'],
      ['A', 'x'.repeat(501), 'C']].map(options => ({ ...question, options })),
    ...['', 'b', ' B', null, 1].map(defaultOption => ({ ...question, defaultOption })),
  ]) assert.throws(() => parseYieldQuestion(value), TypeError)
  assert.equal(parseYieldQuestion({ ...question, question: 'x'.repeat(4000), options: ['A', 'B', 'x'.repeat(500)] }).options[2].length, 500)
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
    { ...request, options: ['A', 'B'] },
  ]) assert.throws(() => parseYieldRequest(value, 'root'), TypeError)
  const input = { ...request, recipient: { ...request.recipient }, options: [...request.options] }
  const parsed = parseYieldRequest(input, 'root')
  input.options[0] = 'Changed'
  input.recipient.sessionId = 'other'
  assert.equal(parsed.options[0], 'A')
  assert.equal(parsed.recipient.sessionId, 'root')
})
