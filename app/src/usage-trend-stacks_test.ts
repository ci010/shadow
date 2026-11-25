import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { ProjectUsage } from '../../src/projects/usage-contract.ts'
import { buildUsageStacks } from './usage-trend-stacks.ts'
import { usageChartOption } from './usage-chart-options.ts'

test('trend stacks preserve project and model totals, unattributed use and missing dates', () => {
  const date = '2026-11-25'
  const usage = (total: number, model: number) => ({ daily: [{ date, usage: { calls: total }, models: [{ name: 'A', usage: { calls: model } }] }] }) as ProjectUsage
  const projects = [{ id: 'a', name: 'Alpha', usage: usage(5, 3) }, { id: 'b', name: 'Beta', usage: usage(7, 7) }]
  const dates = ['2026-11-24', date]
  const labels = { project: 'Project', unnamed: 'Unattributed' }
  assert.deepEqual(buildUsageStacks(projects, dates, 'project', 'calls', 'USD', labels).map(s => s.values), [[null, 5], [null, 7]])
  const stacks = buildUsageStacks(projects, dates, 'model', 'calls', 'USD', labels)
  assert.deepEqual(stacks.map(s => s.values), [[null, 10], [null, 2]])
  const points = dates.map(date => ({ date, label: `${date}: 12`, value: 12, partial: false }))
  const colors = { primary: '#111', text: '#111', muted: '#111', border: '#111', surface: '#111', selection: '#111' }
  for (const kind of ['bar', 'line'] as const) {
    const option = usageChartOption('Calls', kind, points, colors, String, 1, false, stacks)
    assert.deepEqual((option.series as { stack: string }[]).map(row => row.stack), ['usage-total', 'usage-total'])
  }
})
