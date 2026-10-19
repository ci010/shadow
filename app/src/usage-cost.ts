import { t, formatNumber } from './i18n.ts'

/** Separate units must never be added together or silently currency-converted. */
export interface UsageCost { amount: number; currency: 'USD' | 'CNY' | 'AI_CREDITS' }
export interface CostUsage { costs?: UsageCost[]; costIncomplete?: boolean }

export function isUsageCost(value: unknown): value is UsageCost {
  if (!value || typeof value !== 'object') return false
  const cost = value as Record<string, unknown>
  return typeof cost.amount === 'number' && Number.isFinite(cost.amount) && cost.amount >= 0
    && ['USD', 'CNY', 'AI_CREDITS'].includes(cost.currency as string)
}

export function validCostUsage(value: Record<string, unknown>): boolean {
  return (value.costs === undefined || Array.isArray(value.costs) && value.costs.length > 0
    && value.costs.every(isUsageCost) && new Set(value.costs.map(cost => cost.currency)).size === value.costs.length)
    && (value.costIncomplete === undefined || typeof value.costIncomplete === 'boolean')
}

export function formatUsageCost(cost: UsageCost): string {
  // Preserve tiny non-zero costs instead of presenting them as free.
  const amount = formatNumber(cost.amount, { maximumSignificantDigits: 6 })
  return cost.currency === 'AI_CREDITS' ? t('{amount} AI credits', { amount }) : `${cost.currency} ${amount}`
}
