import type { LLMResponseUsage } from './provider.ts'

export interface UsageCost {
  amount: number
  currency: 'USD' | 'CNY' | 'AI_CREDITS'
}

type Rates = readonly [input: number, cached: number, output: number, write?: number]
/** USD per million tokens. Deliberately exact IDs; no guessed aliases. See docs/provider-cost.md. */
const COPILOT: Record<string, Rates> = {
  'claude-haiku-4.5': [1, 0.1, 5, 1.25],
  'claude-sonnet-4': [3, 0.3, 15, 3.75],
  'claude-sonnet-4.6': [3, 0.3, 15, 3.75],
  'claude-opus-4.8': [5, 0.5, 25, 6.25],
  'claude-opus-5': [5, 0.5, 25, 6.25],
  'claude-opus-5.5': [4, 0.2, 20, 5],
  'gpt-6-astra': [10, 1, 50, 12.5],
  'gpt-6.1-sol': [2, 0.1, 10, 2.5],
  'gpt-6-luna': [0.1, 0.01, 0.5, 0.125],
  'gpt-6-sol': [2, 0.2, 10, 2.5],
  'gpt-5.6-luna': [0.2, 0.02, 1.2, 0.25],
  'gpt-5.6-sol': [4, 0.4, 20, 5],
  'gpt-5.6-terra': [2, 0.2, 12, 2.5],
  'grok-4.5': [2, 0.5, 6],
  'grok-4.6': [2, 0.5, 6],
  'grok-4.7': [2, 0.5, 6],
  'gpt-5-mini': [0.25, 0.025, 2],
  'gpt-5.3-codex': [1.75, 0.175, 14],
  'gpt-5.4': [2.5, 0.25, 15],
  'gpt-5.4-mini': [0.75, 0.075, 4.5],
  'gpt-5.4-nano': [0.2, 0.02, 1.25],
  'gpt-5.5': [5, 0.5, 30],
}
// Thresholds apply to total input (including cached input), strictly greater than.
const COPILOT_LONG_CONTEXT: Record<string, { threshold: number; rates: Rates }> = {
  'gpt-5.4': { threshold: 272_000, rates: [5, 0.5, 22.5] },
  'gpt-5.5': { threshold: 272_000, rates: [10, 1, 45] },
  'gpt-5.6-luna': { threshold: 200_000, rates: [0.4, 0.04, 1.8, 0.5] },
  'gpt-5.6-sol': { threshold: 272_000, rates: [8, 0.8, 30, 10] },
  'gpt-5.6-terra': { threshold: 272_000, rates: [4, 0.4, 18, 5] },
  'gpt-6-astra': { threshold: 272_000, rates: [20, 2, 75, 25] },
  'gpt-6-luna': { threshold: 272_000, rates: [0.2, 0.02, 0.75, 0.25] },
  'gpt-6-sol': { threshold: 272_000, rates: [4, 0.4, 15, 5] },
  'gpt-6.1-sol': { threshold: 272_000, rates: [4, 0.2, 15, 5] },
  'grok-4.5': { threshold: 200_000, rates: [4, 1, 12] },
  'grok-4.6': { threshold: 200_000, rates: [4, 1, 12] },
  'grok-4.7': { threshold: 200_000, rates: [4, 1, 12] },
}
const DEEPSEEK: Record<string, Rates> = {
  'deepseek-flash': [0.15, 0.003, 0.6],
  'deepseek-v4-flash': [0.15, 0.003, 0.6],
  'deepseek-v4-flash-vision-exp': [0.15, 0.003, 0.6],
  'deepseek-v4-pro': [0.66, 0.022, 1.98],
}

/** An estimate of token consumption, not an invoice or remaining balance. */
export function estimateUsageCost(provider: string, model: string, usage: LLMResponseUsage, at = new Date()): LLMResponseUsage {
  const table = provider === 'copilot' ? COPILOT : provider === 'deepseek' ? DEEPSEEK : undefined
  let rates = table && Object.hasOwn(table, model) ? table[model] : undefined
  if (provider === 'deepseek') {
    const day = at.getUTCDay(), hour = at.getUTCHours()
    // Chinese public holidays can make a weekday peak window off-peak.
    // Without an authoritative holiday calendar, do not guess that price.
    if (day !== 0 && day !== 6 && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10))) rates = undefined
  }
  if (provider === 'copilot' && Object.hasOwn(COPILOT_LONG_CONTEXT, model)) {
    const tier = COPILOT_LONG_CONTEXT[model]!
    if (usage.promptTokens > tier.threshold) rates = tier.rates
  }
  // promptTokens includes both cache reads and writes. When only writes are
  // unreported, charging all non-read input at the ordinary rate is a lower
  // bound, but only if the write rate is at least the ordinary input rate.
  const missingWrite = rates?.[3] !== undefined && usage.cacheWriteTokens === undefined
  const write = usage.cacheWriteTokens === undefined ? 0 : usage.cacheWriteTokens
  if (!rates || (missingWrite && rates[3]! < rates[0]) || usage.cachedTokens === undefined || usage.cacheReportedPromptTokens !== undefined ||
    ![usage.promptTokens, usage.completionTokens, usage.cachedTokens].every(n => Number.isSafeInteger(n) && n >= 0) ||
    usage.cachedTokens + write > usage.promptTokens || !Number.isSafeInteger(write) || write < 0) return { ...usage, costIncomplete: true }
  const amount = ((usage.promptTokens - usage.cachedTokens - write) * rates[0] + usage.cachedTokens * rates[1]
    + usage.completionTokens * rates[2] + write * (rates[3] ?? rates[0])) / 1_000_000 * (provider === 'copilot' ? 100 : 1)
  return { ...usage, ...(missingWrite ? { costIncomplete: true } : {}), costs: [{ amount, currency: provider === 'copilot' ? 'AI_CREDITS' : 'USD' }] }
}
