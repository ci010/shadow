export type ProviderUsage =
  | { kind: 'unavailable' }
  | { kind: 'copilot-credits'; used: number; allowance: number }
  | { kind: 'deepseek-balance'; sufficient: boolean; balances: { currency: 'CNY' | 'USD'; total: string }[] }

const unavailable = { kind: 'unavailable' } as const
const record = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : undefined
const amount = (value: unknown): value is string => typeof value === 'string' && /^-?\d{1,20}(?:\.\d{1,12})?$/.test(value)

export function parseProviderUsage(value: unknown): ProviderUsage {
  const data = record(value)
  if (data?.kind === 'copilot-credits') {
    const { used, allowance } = data
    if (typeof used === 'number' && Number.isFinite(used) && used >= 0 &&
      typeof allowance === 'number' && allowance <= Number.MAX_SAFE_INTEGER && allowance > 0 && used <= allowance) {
      return { kind: data.kind, used, allowance }
    }
  } else if (data?.kind === 'deepseek-balance' && typeof data.sufficient === 'boolean' &&
    Array.isArray(data.balances) && data.balances.length > 0 && data.balances.length <= 2) {
    const balances: Extract<ProviderUsage, { kind: 'deepseek-balance' }>['balances'] = []
    for (const value of data.balances) {
      const entry = record(value)
      if (!entry || (entry.currency !== 'USD' && entry.currency !== 'CNY') || !amount(entry.total) ||
        balances.some(({ currency }) => currency === entry.currency)) return unavailable
      balances.push({ currency: entry.currency, total: entry.total })
    }
    return { kind: data.kind, sufficient: data.sufficient, balances }
  }
  return unavailable
}
