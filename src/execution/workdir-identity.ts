export const WORKDIR_IDENTITY_OPERATION = 'workdir.identity'
export const MAX_WORKDIR_IDENTITY_BYTES = 32 * 1024
export const MAX_WORKDIR_ANCESTORS = 256

export interface WorkdirIdentityV1 {
  version: 1
  rootId: string
  ancestorIds: string[]
}

export function parseWorkdirIdentity(value: unknown): WorkdirIdentityV1 {
  const invalid = () => new TypeError('The device returned an invalid workdir identity. Update the node and retry.')
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  const record = value as Record<string, unknown>
  const validId = (id: unknown): id is string => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id)
  if (Object.keys(record).some(key => !['version', 'rootId', 'ancestorIds'].includes(key)) ||
    record.version !== 1 || !validId(record.rootId) || !Array.isArray(record.ancestorIds) ||
    record.ancestorIds.length > MAX_WORKDIR_ANCESTORS || !record.ancestorIds.every(validId) ||
    new Set(record.ancestorIds).size !== record.ancestorIds.length ||
    record.ancestorIds.includes(record.rootId)) throw invalid()
  return { version: 1, rootId: record.rootId, ancestorIds: [...record.ancestorIds] }
}

export function workdirIdentitiesOverlap(a: WorkdirIdentityV1, b: WorkdirIdentityV1): boolean {
  return a.rootId === b.rootId || a.ancestorIds.includes(b.rootId) || b.ancestorIds.includes(a.rootId)
}
