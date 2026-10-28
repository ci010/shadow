import { normalizeCopilotHost } from '../../src/shared/copilot-host.ts'

/** Existing persisted hosts use full names; the enterprise field shows only its label. */
export function enterprisePrefix(host: string): string {
  const normalized = normalizeCopilotHost(host)
  return normalized === 'github.com' ? '' : normalized.slice(0, -'.ghe.com'.length)
}

export function enterpriseHostFromPrefix(prefix: string): string {
  const label = prefix.trim().toLowerCase()
  if (!label || label.includes('.')) throw new Error('Enter only the enterprise subdomain prefix.')
  return normalizeCopilotHost(`${label}.ghe.com`)
}
