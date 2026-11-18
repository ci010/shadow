import assert from 'node:assert/strict'
import test from 'node:test'
import { projectUsageSchema } from '../../src/projects/usage-contract.ts'
import { mergeUsage, sumUsageMetrics } from './global-usage.ts'

const missing = sumUsageMetrics([])
const partial = { ...missing, calls: 1, unknownTokenCalls: 1, costs: [{ currency: 'CNY' as const, amount: 1 }] }
const measured = { ...missing, calls: 2, tokens: 0, durationMs: 42, costs: [{ currency: 'USD' as const, amount: 2 }, { currency: 'CNY' as const, amount: 3 }] }

test('aggregation preserves unknown vs zero, sums matching currencies and never mutates sources', () => {
  assert.deepEqual(sumUsageMetrics([partial, measured]), { ...measured, calls: 3, unknownTokenCalls: 1,
    costs: [{ currency: 'CNY', amount: 4 }, { currency: 'USD', amount: 2 }] })
  assert.equal(sumUsageMetrics([partial]).tokens, null)
  assert.equal(partial.costs[0]!.amount, 1)
})

test('aggregate aligns daily rows by UTC date and combines model/tool activity and coverage', () => {
  const activity = { models: [{ name: 'model', calls: 1 }], tools: [{ name: 'tool', calls: 2 }] }
  const a = projectUsageSchema.parse({ projectId: 'a', timeZone: 'UTC', asOf: '2026-10-01T04:00:00Z', today: partial, past7Days: partial, month: partial, total: partial,
    activity: { today: activity, past7Days: activity, month: activity, total: activity },
    daily: [{ date: '2026-10-01', usage: partial }], scanLimitReached: true, untrackedSessions: 1, undatedCalls: 2 })
  const b = { ...a, projectId: 'b', asOf: '2026-10-01T05:00:00Z', daily: [{ date: '2026-09-30', usage: measured }, { date: '2026-10-01', usage: measured }], scanLimitReached: false }
  const combined = mergeUsage([a, b])!
  assert.equal(combined.asOf, b.asOf)
  assert.deepEqual(combined.daily.map(row => [row.date, row.usage.calls]), [['2026-10-01', 3], ['2026-09-30', 2]])
  assert.deepEqual(combined.activity.today, { models: [{ name: 'model', calls: 2 }], tools: [{ name: 'tool', calls: 4 }] })
  assert.equal(combined.untrackedSessions, 2)
  assert.equal(combined.undatedCalls, 4)
  assert.equal(combined.scanLimitReached, true)
})


test('model metrics merge per name and mark mixed legacy coverage without inventing costs', () => {
  const period = (model: { name: string; calls: number; usage?: typeof measured }) => ({ models: [model], tools: [] })
  const project = (id: string, activity: ReturnType<typeof period>) => projectUsageSchema.parse({
    projectId: id, timeZone: 'UTC', asOf: '2026-10-01T04:00:00Z', today: measured, past7Days: measured, month: measured, total: measured,
    activity: { today: activity, past7Days: activity, month: activity, total: activity },
    daily: [], coverage: 'complete', scanLimitReached: false, untrackedSessions: 0, undatedCalls: 0,
  })
  const known = project('a', period({ name: 'model', calls: measured.calls, usage: measured }))
  const legacy = project('b', period({ name: 'model', calls: 4 }))
  const [combined] = mergeUsage([known, legacy])!.activity.today.models
  assert.equal(combined.calls, measured.calls + 4)
  assert.equal(combined.usage?.tokens, measured.tokens)
  assert.deepEqual(combined.usage?.costs, measured.costs)
  assert.equal(combined.usage?.unknownCostCalls, measured.unknownCostCalls + 4)
  assert.equal(combined.usage?.unknownTokenCalls, measured.unknownTokenCalls + 4)
  assert.equal(combined.usage?.unknownDurationCalls, measured.unknownDurationCalls + 4)
})
