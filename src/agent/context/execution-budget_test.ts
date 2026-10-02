import assert from 'node:assert/strict'
import test from 'node:test'
import type { ChatMessage } from '../../providers/provider.ts'
import { SESSION_ITERATION_LIMIT, withExecutionBudget } from './execution-budget.ts'

test('remaining budget is current request metadata, not persisted history or permission', () => {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'Original policy' },
    { role: 'user', content: 'Synthetic task' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'one', type: 'function', function: { name: 'read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'one', content: 'Result' },
  ]
  const before = structuredClone(messages)
  const first = withExecutionBudget(messages, SESSION_ITERATION_LIMIT, 'turn')
  const last = withExecutionBudget(messages, 1, 'turn')
  assert.match(String(first[0].content), /100 inference requests including this one/)
  assert.match(String(first[0].content), /not a provider quota/)
  assert.doesNotMatch(String(first[0].content), /optional polish/)
  assert.match(String(last[0].content), /1 inference requests including this one/)
  assert.match(String(last[0].content), /only after approval/)
  assert.deepEqual(messages, before)
  assert.deepEqual(last.slice(1), messages.slice(1))
  assert.match(String(last[0].content), /^Original policy/)
  assert.equal(last.filter(m => String(m.content).includes('Remaining execution budget')).length, 1)
  for (const remaining of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => withExecutionBudget(messages, remaining, 'turn'), RangeError)
  }
  assert.doesNotMatch(String(withExecutionBudget(messages, 21, 'evaluation')[0].content), /optional polish/)
  assert.match(String(withExecutionBudget(messages, 20, 'evaluation')[0].content), /optional polish/)
  assert.match(String(withExecutionBudget([], 5, 'evaluation')[0].content), /another turn does not reset it/)
  const timeBound = String(withExecutionBudget(messages, 80, 'evaluation', 300000)[0].content)
  assert.match(timeBound, /deadline is in 300 seconds/)
  assert.match(timeBound, /operator waiting/)
  assert.match(timeBound, /only an upper bound/)
  assert.match(timeBound, /optional polish/)
  assert.doesNotMatch(String(withExecutionBudget(messages, 80, 'evaluation', 300001)[0].content), /optional polish/)
  assert.match(String(withExecutionBudget(messages, 80, 'evaluation', 0)[0].content), /deadline is in 0 seconds/)
  for (const value of [-1, NaN, Infinity]) assert.throws(() => withExecutionBudget(messages, 80, 'evaluation', value), RangeError)
})
