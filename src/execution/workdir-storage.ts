/** Storage-only identity adapter. Never call at a live wire/tool boundary. */
export function normalizeStoredWorkdirIdentity(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const fields = ['workdirId', 'resourceId', 'capabilityId'].filter(key => Object.hasOwn(record, key))
  if (fields.length !== 1 || typeof record[fields[0]] !== 'string' || !(record[fields[0]] as string).length) return null
  const { [fields[0]]: workdirId, ...rest } = record
  return { ...rest, workdirId }
}
