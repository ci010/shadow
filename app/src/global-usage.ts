import type { ProjectUsage, ProjectUsageMetrics } from '../../src/projects/usage-contract.ts'

export const usagePeriods = ['total', 'today', 'past7Days', 'month'] as const

export function sumUsageMetrics(rows: ProjectUsageMetrics[]): ProjectUsageMetrics {
  const result: ProjectUsageMetrics = { calls: 0, tokens: null, durationMs: null, costs: [], unknownTokenCalls: 0, unknownCostCalls: 0, unknownDurationCalls: 0 }
  for (const row of rows) {
    for (const field of ['calls', 'unknownTokenCalls', 'unknownCostCalls', 'unknownDurationCalls'] as const) result[field] += row[field]
    for (const field of ['tokens', 'durationMs'] as const) if (row[field] !== null) result[field] = (result[field] ?? 0) + row[field]
    for (const cost of row.costs) {
      const existing = result.costs.find(item => item.currency === cost.currency)
      if (existing) existing.amount += cost.amount
      else result.costs.push({ ...cost })
    }
  }
  return result
}

export function mergeUsage(rows: ProjectUsage[]): ProjectUsage | undefined {
  if (!rows.length) return undefined
  const days = new Map<string, ProjectUsageMetrics[]>()
  for (const row of rows) for (const day of row.daily) {
    if (!days.has(day.date)) days.set(day.date, [])
    days.get(day.date)!.push(day.usage)
  }
  const result: ProjectUsage = {
    projectId: '', timeZone: 'UTC', asOf: rows.map(row => row.asOf).sort().at(-1)!,
    activity: { total: { models: [], tools: [] }, today: { models: [], tools: [] }, past7Days: { models: [], tools: [] }, month: { models: [], tools: [] } },
    total: sumUsageMetrics([]), today: sumUsageMetrics([]), past7Days: sumUsageMetrics([]), month: sumUsageMetrics([]),
    daily: [...days].sort(([a], [b]) => b.localeCompare(a)).map(([date, usage]) => ({ date, usage: sumUsageMetrics(usage) })),
    scanLimitReached: rows.some(row => row.scanLimitReached),
    untrackedSessions: rows.reduce((sum, row) => sum + row.untrackedSessions, 0),
    undatedCalls: rows.reduce((sum, row) => sum + row.undatedCalls, 0),
  }
  for (const period of usagePeriods) {
    result[period] = sumUsageMetrics(rows.map(row => row[period]))
    for (const kind of ['models', 'tools'] as const) {
      const counts = new Map<string, number>()
      for (const row of rows) for (const entry of row.activity[period][kind]) counts.set(entry.name, (counts.get(entry.name) ?? 0) + entry.calls)
      result.activity[period][kind] = [...counts].map(([name, calls]) => ({ name, calls }))
    }
  }
  return result
}
