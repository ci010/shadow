import { isManagedWorkdir, ownsManagedWorkdir } from '../execution/managed-workdir.ts'

/** Current persisted ownership contract. Older formats are not imported or reinterpreted. */
export const OWNERSHIP_VERSION = 2 as const

export class OwnershipValidationError extends TypeError {
  constructor(message: string) {
    super(message)
    this.name = 'OwnershipValidationError'
  }
}

export function validateOwnership(value: Record<string, unknown>): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.ownershipVersion !== OWNERSHIP_VERSION) {
    throw new OwnershipValidationError('Unsupported ownership format; expected ownershipVersion: 2')
  }
  for (const key of ['projectId', 'folderId']) {
    const id = value[key]
    if (id !== undefined && (typeof id !== 'string' || !id.trim() || id !== id.trim())) {
      throw new OwnershipValidationError(`Invalid ${key} ownership`)
    }
  }
  const ref = value.workdir as { capabilityId?: unknown; nodeId?: unknown } | undefined
  if (ref && typeof ref.capabilityId === 'string' && isManagedWorkdir(ref.capabilityId) &&
    (typeof value.projectId !== 'string' || !ownsManagedWorkdir(value.projectId, ref.capabilityId) ||
      typeof ref.nodeId !== 'string' || !ref.nodeId || ref.nodeId === 'local' || value.folderId !== undefined)) {
    throw new OwnershipValidationError('Managed remote workdirs require matching project ownership and no folderId')
  }
  return { ...value }
}
