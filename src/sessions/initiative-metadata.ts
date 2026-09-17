const INITIATIVE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/

export class InitiativeMetadataError extends TypeError {}

export function parseInitiativeId(record: Record<string, unknown>): string | undefined {
  let result: string | undefined
  for (const key of ['initiativeId', 'initiativeName', 'projectName']) {
    const value = record[key]
    if (value === undefined) continue
    if (typeof value !== 'string' || !INITIATIVE_ID.test(value)) {
      throw new InitiativeMetadataError(`${key} must be an initiative ID: 1-64 lowercase letters, digits, or hyphens.`)
    }
    if (result !== undefined && result !== value) {
      throw new InitiativeMetadataError('Conflicting current and legacy initiative identities.')
    }
    result = value
  }
  return result
}

export function normalizeInitiativeMetadata(record: Record<string, unknown>): Record<string, unknown> {
  const initiativeId = parseInitiativeId(record)
  const result = { ...record }
  delete result.projectName
  delete result.initiativeName
  if (initiativeId !== undefined) result.initiativeId = initiativeId
  const preloads = result.preloadTools
  if (preloads && typeof preloads === 'object' && !Array.isArray(preloads) && 'project' in preloads) {
    const renamed = { ...preloads }
    if ('initiative' in renamed && JSON.stringify(renamed.initiative) !== JSON.stringify(renamed.project)) {
      throw new InitiativeMetadataError('Conflicting current and legacy initiative preloads.')
    }
    const { project, ...remaining } = renamed
    result.preloadTools = { ...remaining, initiative: project }
  }
  return result
}
