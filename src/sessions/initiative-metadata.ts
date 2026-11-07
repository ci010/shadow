const WORK_KEY = /^(?:work|initiative|item|topic):[^/\\\s]+$/

export class InitiativeMetadataError extends TypeError {}

/** Public context selector; stored metadata retains its internal field name. */
export function parseWorkRoot(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length > 600 || !WORK_KEY.test(value)) {
    throw new InitiativeMetadataError('Work context must use a canonical Work key.')
  }
  return value
}

export function parseInitiativeId(record: Record<string, unknown>): string | undefined {
  if (record.initiativeName !== undefined || record.projectName !== undefined) {
    throw new InitiativeMetadataError('Unsupported legacy Work context metadata. Preserve the record; legacy planning identities are not imported.')
  }
  return parseWorkRoot(record.initiativeId)
}

export function normalizeInitiativeMetadata(record: Record<string, unknown>): Record<string, unknown> {
  const initiativeId = parseInitiativeId(record)
  const preloads = record.preloadTools
  if (preloads && typeof preloads === 'object' && !Array.isArray(preloads) && ('project' in preloads || 'initiative' in preloads)) {
    throw new InitiativeMetadataError('Unsupported legacy planning tool preload. Use the current Work tool.')
  }
  return { ...record, ...(initiativeId === undefined ? {} : { initiativeId }) }
}
