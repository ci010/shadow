import type { ProjectUsageMetrics } from '../../src/projects/usage-contract.ts'
import { displayCosts, type CostUnit } from './project-usage-charts.ts'

export const usageMetrics = [
  { key: 'tokens', label: 'Tokens' }, { key: 'cost', label: 'Estimated cost' },
  { key: 'calls', label: 'Provider calls' }, { key: 'time', label: 'Provider time' },
] as const
export type UsageMetric = typeof usageMetrics[number]['key']
export type BreakdownRow = { id: string; name: string; calls?: number; usage?: ProjectUsageMetrics }
export function measure(row: Omit<BreakdownRow, 'id' | 'name'>, metric: UsageMetric, unit: CostUnit) {
  const usage = row.usage
  switch (metric) {
    case 'tokens': return { value: usage?.tokens ?? null, partial: !!usage?.unknownTokenCalls }
    case 'cost': return { value: displayCosts(usage?.costs ?? []).find(cost => cost.currency === unit)?.amount ?? null, partial: !!usage?.unknownCostCalls }
    case 'time': return { value: usage?.durationMs == null ? null : usage.durationMs / 1000, partial: !!usage?.unknownDurationCalls }
    case 'calls': return { value: row.calls ?? usage?.calls ?? null, partial: false }
  }
}
export function rankBreakdown(rows: BreakdownRow[], metric: UsageMetric, unit: CostUnit) {
  return rows.map(row => ({ ...row, ...measure(row, metric, unit) }))
    .sort((a, b) => (b.value ?? -1) - (a.value ?? -1) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
}
