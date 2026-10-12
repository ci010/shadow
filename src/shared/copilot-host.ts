/** GitHub.com and GitHub Enterprise Cloud with data residency, not arbitrary GHES. */
export function normalizeCopilotHost(value: unknown): string {
  if (value === undefined) return 'github.com'
  if (typeof value !== 'string') throw new Error('Use github.com or a single enterprise subdomain of ghe.com.')
  const host = value.trim().toLowerCase()
  if (host === 'github.com' || /^(?!xn--)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ghe\.com$/.test(host)) return host
  throw new Error('Use github.com or a single enterprise subdomain of ghe.com.')
}

/** Exact device verification URL; never open a URL supplied by an untrusted response. */
export function copilotVerificationUri(host: string): string {
  return `https://${normalizeCopilotHost(host)}/login/device`
}
