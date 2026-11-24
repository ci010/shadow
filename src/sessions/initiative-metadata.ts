import { workKeySchema } from '../initiatives/work-key.ts'

export class InitiativeMetadataError extends TypeError {}

/** Public context selector; stored metadata retains its internal field name. */
export function parseWorkRoot(value: unknown): string | undefined {
  if (value === undefined) return undefined
  const parsed = workKeySchema.safeParse(value)
  if (!parsed.success) {
    throw new InitiativeMetadataError('Work context must use a canonical Work key.')
  }
  return parsed.data
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
