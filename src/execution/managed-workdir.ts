import { createHash } from 'node:crypto'

export const MANAGED_SESSION_CAPABILITY = 'managed-sessions-v1'
export const MANAGED_SESSION_OPERATION = 'workdir.session.allocate'
export const MANAGED_WORKDIR_PREFIX = 'managed-v1:'
export const MANAGED_WORKDIR_PERMISSIONS = [
  'filesystem.read', 'filesystem.write', 'workdir.process.execute', 'workdir.git.status', 'workdir.git.diff', 'workdir.identity',
]

export function projectExecutionKey(projectId: string, kind: string, value: string): string {
  return `project-${createHash('sha256').update(JSON.stringify([projectId, kind, value])).digest('hex')}`
}

export function managedProjectScope(projectId: string): string {
  return createHash('sha256').update(JSON.stringify(['managed-project-v1', projectId])).digest('hex').slice(0, 32)
}

export function isManagedWorkdir(capabilityId: unknown): boolean {
  return typeof capabilityId === 'string' && capabilityId.startsWith(MANAGED_WORKDIR_PREFIX)
}

export function managedCapabilityForScope(projectScope: string, executionSessionId: string): string {
  if (!/^[0-9a-f]{32}$/.test(projectScope) || !/^project-[0-9a-f]{64}$/.test(executionSessionId)) {
    throw new TypeError('Managed workdirs require a project-scoped execution identity')
  }
  return `${MANAGED_WORKDIR_PREFIX}${projectScope}:${executionSessionId.slice('project-'.length)}`
}

export function managedSessionCapability(projectId: string, sessionId: string): string {
  return managedCapabilityForScope(managedProjectScope(projectId), projectExecutionKey(projectId, 'session', sessionId))
}

export function ownsManagedWorkdir(projectId: string, capabilityId: string): boolean {
  return capabilityId.startsWith(`${MANAGED_WORKDIR_PREFIX}${managedProjectScope(projectId)}:`) &&
    /^managed-v1:[0-9a-f]{32}:[0-9a-f]{64}$/.test(capabilityId)
}
