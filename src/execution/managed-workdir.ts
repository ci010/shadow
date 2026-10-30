import { createHash } from 'node:crypto'

export const LEGACY_MANAGED_SERVICE_ID = 'managed-sessions-v1'
export const MANAGED_SESSION_OPERATION = 'workdir.session.allocate'
export const MANAGED_WORKDIR_PREFIX = 'managed-v1:'
export const MANAGED_WORKDIR_OPERATIONS = [
  'filesystem.read', 'filesystem.write', 'workdir.process.execute', 'workdir.git.status', 'workdir.git.diff', 'workdir.identity',
  'workdir.process.execute-once', 'workdir.process.reconcile',
]

export function projectExecutionKey(projectId: string, kind: string, value: string): string {
  return `project-${createHash('sha256').update(JSON.stringify([projectId, kind, value])).digest('hex')}`
}

export function managedProjectScope(projectId: string): string {
  return createHash('sha256').update(JSON.stringify(['managed-project-v1', projectId])).digest('hex').slice(0, 32)
}

export function isManagedWorkdir(workdirId: unknown): boolean {
  return typeof workdirId === 'string' && workdirId.startsWith(MANAGED_WORKDIR_PREFIX)
}

export function managedWorkdirForScope(projectScope: string, executionSessionId: string): string {
  if (!/^[0-9a-f]{32}$/.test(projectScope) || !/^project-[0-9a-f]{64}$/.test(executionSessionId)) {
    throw new TypeError('Managed workdirs require a project-scoped execution identity')
  }
  return `${MANAGED_WORKDIR_PREFIX}${projectScope}:${executionSessionId.slice('project-'.length)}`
}

export function managedSessionWorkdirId(projectId: string, sessionId: string): string {
  return managedWorkdirForScope(managedProjectScope(projectId), projectExecutionKey(projectId, 'session', sessionId))
}

export function ownsManagedWorkdir(projectId: string, workdirId: string): boolean {
  return workdirId.startsWith(`${MANAGED_WORKDIR_PREFIX}${managedProjectScope(projectId)}:`) &&
    /^managed-v1:[0-9a-f]{32}:[0-9a-f]{64}$/.test(workdirId)
}
