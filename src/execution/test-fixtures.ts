/** Explicit synthetic authority for execution tests; never imported by runtime code. */
import { ProjectExecutor } from '../projects/executor.ts'
import type { Executor } from './executor.ts'
import type { ExecutionRequestV2 } from './contracts.ts'
import { assertExecutionSupported } from './workdir-contracts.ts'
import { MANAGED_WORKDIR_OPERATIONS } from './managed-workdir.ts'
import type { WorkdirBinding } from './capability-filesystem.ts'

export function fixtureProjectExecutor(projectId: string, executor: Executor): ProjectExecutor {
  return new ProjectExecutor(projectId, executor, () => {})
}
export function fixtureDirectoryAdmission(nodeId: string, bindings: readonly WorkdirBinding[]) {
  return (request: ExecutionRequestV2) => {
    assertExecutionSupported(request, bindings.map(b => ({ version: 2, nodeId, workdirId: b.workdirId, displayName: b.workdirId, online: true, support: { operations: [...MANAGED_WORKDIR_OPERATIONS] } })), { operations: ['process.execute'] })
  }
}
