/** Display-only command output. Never a provider message. */
export interface CommandReceipt {
  id: string
  command: string
  output: string
  timestamp: string
  failed: boolean
}

export function isCommandReceipt(value: unknown): value is CommandReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record.id === 'string' && record.id.length > 0
    && typeof record.command === 'string' && record.command.trimStart().startsWith('/')
    && typeof record.output === 'string'
    && typeof record.timestamp === 'string' && Number.isFinite(Date.parse(record.timestamp))
    && typeof record.failed === 'boolean'
}
