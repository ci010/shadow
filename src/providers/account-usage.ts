import { parseProviderUsage, type ProviderUsage } from '../shared/provider-usage.ts'

export const unavailableUsage = { kind: 'unavailable' } as const
const object = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : undefined

function quotaNumber(value: unknown): number | undefined {
  const number = typeof value === 'string' && /^\d{1,20}(?:\.\d{1,12})?$/.test(value) ? Number(value) : value
  return typeof number === 'number' && Number.isFinite(number) && number >= 0 && number <= Number.MAX_SAFE_INTEGER ? number : undefined
}

export function copilotUsage(value: unknown): ProviderUsage {
  const data = object(value)
  const quota = object(object(data?.quota_snapshots)?.premium_interactions)
  if (data?.token_based_billing !== true || quota?.unlimited !== false) return unavailableUsage
  // Same basis as VS Code's included quota. credits_used has no matching denominator,
  // and legacy remaining may be rounded. Do not reconstruct counts from percentages.
  const allowance = quotaNumber(quota.entitlement)
  const remaining = quotaNumber(quota.quota_remaining)
  if (allowance === undefined || remaining === undefined || remaining > allowance) return unavailableUsage
  return parseProviderUsage({ kind: 'copilot-credits', allowance, used: allowance - remaining })
}

export function deepseekUsage(value: unknown): ProviderUsage {
  const data = object(value)
  return parseProviderUsage({
    kind: 'deepseek-balance', sufficient: data?.is_available,
    balances: Array.isArray(data?.balance_infos) && data.balance_infos.length <= 2
      ? data.balance_infos.map(value => ({ currency: object(value)?.currency, total: object(value)?.total_balance }))
      : undefined,
  })
}

export function isOfficialDeepSeek(baseUrl?: string): boolean {
  if (!baseUrl) return false
  try {
    const url = new URL(baseUrl)
    return url.origin === 'https://api.deepseek.com' && !url.username && !url.password && !url.search && !url.hash &&
      /^\/(?:v1\/*)?$/.test(url.pathname)
  } catch { return false }
}

export async function fetchAccountUsage(
  request: typeof fetch, url: string, headers: HeadersInit, parse: (value: unknown) => ProviderUsage, signal: AbortSignal,
): Promise<ProviderUsage> {
  try {
    const response = await request(url, { headers, signal, redirect: 'error' })
    if (!response.ok) {
      await response.body?.cancel()
      return unavailableUsage
    }
    return parse(await response.json())
  } catch { return unavailableUsage }
}
