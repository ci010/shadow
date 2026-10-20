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
export function lineSegments(points: UsagePoint[], maximum: number): string[] {
  const segments: string[] = []
  let current: string[] = []
  points.forEach((point, i) => {
    if (point.seconds === null) { if (current.length) segments.push(current.join(' ')); current = []; return }
    current.push(`${30 + i * 540 / Math.max(1, points.length - 1)},${160 - point.seconds / maximum * 130}`)
  })
  if (current.length) segments.push(current.join(' '))
  return segments
}
export function tokenShares(points: UsagePoint[]) {
  const positive = points.filter(p => p.tokens !== null && p.tokens > 0).sort((a, b) => b.tokens! - a.tokens!)
  const groups = positive.slice(0, 5).map(p => ({ label: p.date, value: p.tokens! }))
  if (positive.length > 5) groups.push({ label: 'Other days', value: positive.slice(5).reduce((sum, p) => sum + p.tokens!, 0) })
  const total = groups.reduce((sum, p) => sum + p.value, 0)
  let offset = 0
  return groups.map(group => { const share = group.value / total; const result = { ...group, share, offset }; offset += share; return result })
}

export type CostUnit = ProjectUsageMetrics['costs'][number]['currency']
export const costUnits: CostUnit[] = ['USD', 'CNY', 'AI_CREDITS']
/** A missing unit is zero only with complete daily cost coverage. */
export function costWindow(points: UsagePoint[], unit: CostUnit) {
  return points.map(point => {
    const usage = point.usage
    const cost = usage?.costs.find(cost => cost.currency === unit)
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
