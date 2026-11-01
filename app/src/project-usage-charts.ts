import type { ProjectUsage, ProjectUsageMetrics } from '../../src/projects/usage-contract.ts'

export interface UsagePoint { date: string; usage?: ProjectUsageMetrics; tokens: number | null; seconds: number | null }
/** Missing calendar rows stay unavailable; never infer telemetry from an absent row. */
export function usageWindow(data: ProjectUsage, days: number): UsagePoint[] {
  const end = Date.parse(`${data.asOf.slice(0, 10)}T00:00:00Z`)
  const rows = new Map(data.daily.map(day => [day.date, day.usage]))
  return Array.from({ length: days }, (_, i) => {
    const date = new Date(end - (days - 1 - i) * 86400000).toISOString().slice(0, 10)
    const usage = rows.get(date)
    return { date, usage, tokens: usage?.tokens ?? null, seconds: usage?.durationMs == null ? null : usage.durationMs / 1000 }
  })
}
export function lineSegments(points: UsagePoint[], maximum: number, plotWidth = 540): string[] {
  const segments: string[] = []
  let current: string[] = []
  points.forEach((point, i) => {
    if (point.seconds === null) { if (current.length) segments.push(current.join(' ')); current = []; return }
    current.push(`${30 + i * plotWidth / Math.max(1, points.length - 1)},${160 - point.seconds / maximum * 130}`)
  })
  if (current.length) segments.push(current.join(' '))
  return segments
}
export type CostUnit = 'USD' | 'CNY'
export const costUnits: CostUnit[] = ['USD', 'CNY']
/** Presentation only: retain raw provider estimates, convert credits at 100:1,
 * and never infer an exchange rate for CNY. Used by summaries, plots and history. */
export function displayCosts(costs: ProjectUsageMetrics['costs']): Array<{ currency: CostUnit; amount: number }> {
  const totals = new Map<CostUnit, number>()
  for (const cost of costs) {
    const currency = cost.currency === 'AI_CREDITS' ? 'USD' : cost.currency
    const amount = cost.currency === 'AI_CREDITS' ? cost.amount / 100 : cost.amount
    totals.set(currency, (totals.get(currency) ?? 0) + amount)
  }
  return costUnits.filter(currency => totals.has(currency)).map(currency => ({ currency, amount: totals.get(currency)! }))
}
/** A missing unit is zero only with complete daily cost coverage. */
export function costWindow(points: UsagePoint[], unit: CostUnit) {
  return points.map(point => {
    const usage = point.usage
    const cost = usage && displayCosts(usage.costs).find(cost => cost.currency === unit)
    const partial = !!usage?.unknownCostCalls
    return { date: point.date, amount: cost?.amount ?? (usage && !partial ? 0 : null), partial }
  })
}

/** Stable Latin compact suffixes keep large counts readable in both UI locales. */
export function compactUsageNumber(value: number, format: (value: number, options?: Intl.NumberFormatOptions) => string): string {
  const unit = value >= 999_950_000 ? 1e9 : value >= 999_950 ? 1e6 : value >= 1e3 ? 1e3 : 1
  return `${format(value / unit, { maximumFractionDigits: unit === 1 ? 0 : 1 })}${unit === 1e9 ? 'B' : unit === 1e6 ? 'M' : unit === 1e3 ? 'K' : ''}`
}
export function compactUsageCost(value: number, format: (value: number, options?: Intl.NumberFormatOptions) => string): string {
  if (value >= 1000) return compactUsageNumber(value, format)
  // Tiny positive estimates must not round to a misleading zero.
  return format(value, value > 0 && value < 0.01 ? { maximumSignificantDigits: 2 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
export function durationParts(ms: number) {
  const total = Math.round(ms / 1000)
  return { hours: Math.floor(total / 3600), minutes: Math.floor(total % 3600 / 60), seconds: total < 60 ? Math.round(ms / 100) / 10 : total % 60 }
}
