import assert from 'node:assert/strict'
import test from 'node:test'
import type { ProjectUsage, ProjectUsageMetrics } from '../../src/projects/usage-contract.ts'
import { usageWindow, lineSegments, tokenShares } from './project-usage-charts.ts'
const usage = (tokens: number | null, durationMs: number | null = tokens): ProjectUsageMetrics => ({ calls: 1, tokens, durationMs, unknownTokenCalls: tokens === null ? 1 : 0, unknownDurationCalls: durationMs === null ? 1 : 0, costs: [{ currency: 'USD', amount: 2 }, { currency: 'CNY', amount: 3 }, { currency: 'AI_CREDITS', amount: 10 }], unknownCostCalls: 0 })
const fixture = { asOf: '2026-01-02T00:01:00Z', daily: [{ date: '2026-01-02', usage: usage(0, 0) }, { date: '2026-01-01', usage: usage(100, 2000) }, { date: '2025-12-30', usage: usage(null) }] } as ProjectUsage

test('UTC windows include today across year boundary, preserve zeros and missing rows', () => {
  const points = usageWindow(fixture, 7)
  assert.equal(points.length, 7)
  assert.equal(points[0].date, '2025-12-27')
  assert.equal(points.at(-1)?.tokens, 0)
  assert.equal(points.at(-1)?.seconds, 0)
  assert.equal(points[4].date, '2025-12-31')
  assert.equal(points[4].tokens, null)
  assert.equal(points[3].tokens, null)
  assert.equal(points[5].seconds, 2)
  assert.equal(usageWindow(fixture, 30).length, 30)
})
test('line never bridges missing values; zero and isolated points remain coordinates', () => {
  const points = usageWindow(fixture, 7)
  assert.deepEqual(lineSegments(points, 2), ['480,30 570,160'])
  assert.deepEqual(lineSegments(points.map((p, i) => i === 5 ? { ...p, seconds: null } : p), 2), ['570,160'])
})
test('token shares are disjoint daily known subtotals, never currencies or overlapping periods', () => {
  const points = usageWindow(fixture, 7)
  assert.deepEqual(tokenShares(points), [{ label: '2026-01-01', value: 100, share: 1, offset: 0 }])
  assert.deepEqual(tokenShares(points.map(p => ({ ...p, tokens: 0 }))), [])
  assert.deepEqual(tokenShares(points.map(p => ({ ...p, tokens: null }))), [])
  const groups = tokenShares(points.map((p, i) => ({ ...p, tokens: i + 1 })))
  assert.equal(groups.length, 6)
  assert.equal(groups.at(-1)?.label, 'Other days')
  assert.equal(groups.at(-1)?.value, 3)
  assert.equal(groups.reduce((sum, p) => sum + p.value, 0), 28)
  assert.ok(Math.abs(groups.reduce((sum, p) => sum + p.share, 0) - 1) < 1e-12)
})


test('cost window separates units and infers absent-unit zero only with complete coverage', async () => {
  const { costWindow } = await import('./project-usage-charts.ts')
  const points = usageWindow(fixture, 7)
  assert.equal(costWindow(points, 'USD').at(-1)?.amount, 2)
  assert.equal(costWindow(points, 'CNY').at(-1)?.amount, 3)
  assert.equal(costWindow(points, 'AI_CREDITS').at(-1)?.amount, 10)
  assert.equal(costWindow(points, 'USD')[0].amount, null)
  const base = { ...points.at(-1)!, usage: { ...usage(0), costs: [{ currency: 'USD' as const, amount: 2 }] } }
  assert.deepEqual(costWindow([base], 'CNY'), [{ date: base.date, amount: 0, partial: false }])
  const incomplete = { ...base, usage: { ...base.usage, unknownCostCalls: 1 } }
  assert.deepEqual(costWindow([incomplete], 'CNY'), [{ date: base.date, amount: null, partial: true }])
  assert.deepEqual(costWindow([incomplete], 'USD'), [{ date: base.date, amount: 2, partial: true }])
})

test('compact counts, costs and duration parts preserve meaningful precision without mixing units', async () => {
  const { compactUsageNumber, compactUsageCost, durationParts } = await import('./project-usage-charts.ts')
  const format = (n: number, options?: Intl.NumberFormatOptions) => new Intl.NumberFormat('en-US', options).format(n)
  assert.equal(compactUsageNumber(156300000, format), '156.3M')
  assert.equal(compactUsageNumber(0, format), '0')
  assert.equal(compactUsageCost(0.0000123456, format), '0.000012')
  assert.equal(compactUsageCost(1, format), '1.00')
  assert.equal(compactUsageCost(0, format), '0.00')
  assert.deepEqual(durationParts(293000), { hours: 0, minutes: 4, seconds: 53 })
  assert.deepEqual(durationParts(59999), { hours: 0, minutes: 1, seconds: 0 })
  assert.deepEqual(durationParts(1500), { hours: 0, minutes: 0, seconds: 1.5 })
})
