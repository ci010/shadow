import assert from 'node:assert/strict'
import test from 'node:test'
import { InferenceBudget, SESSION_ITERATION_LIMIT } from './execution-budget.ts'

test('default turn budget allows exactly 1000 inference requests', () => {
  assert.equal(SESSION_ITERATION_LIMIT, 1000)
  const budget = new InferenceBudget()
  assert.equal(budget.remaining, SESSION_ITERATION_LIMIT)
  for (let i = 0; i < SESSION_ITERATION_LIMIT; i++) budget.take()
  assert.equal(budget.remaining, 0)
  assert.throws(() => budget.take(), /exhausted/)
  assert.equal(budget.remaining, 0)
})

test('custom budgets enforce reservations without spending rejected requests', () => {
  const budget = new InferenceBudget(3)
  budget.take(1)
  budget.take(1)
  assert.equal(budget.remaining, 1)
  assert.throws(() => budget.take(1), /exhausted/)
  assert.equal(budget.remaining, 1)
  budget.take()
  assert.equal(budget.remaining, 0)
  assert.throws(() => budget.take(), /exhausted/)
})

test('inference limits and reservations require valid safe integers', () => {
  for (const limit of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => new InferenceBudget(limit), RangeError)
  }
  const budget = new InferenceBudget(2)
  for (const reserve of [-1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => budget.take(reserve), RangeError)
    assert.equal(budget.remaining, 2)
  }
})
