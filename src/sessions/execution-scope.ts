import type { SessionState } from './session-store.ts'
import type { SessionManager } from './session-manager.ts'
import type { ExecutionContext } from '../tools/context.ts'

export const MAX_CALL_TIMEOUT_MS = 120_000

type ExecutionAccess = Pick<SessionManager, 'getSessionState' | 'assertFolderAccess' | 'getDelegationOwner'>

export function assertExecutionActor(sessions: Pick<ExecutionAccess, 'getSessionState' | 'assertFolderAccess'>, context: ExecutionContext): void {
  context.signal.throwIfAborted()
  const owner = sessions.getSessionState(context.sessionId)
  if (!owner || !context.projectId || owner.projectId !== context.projectId) {
    throw new Error('Execution access requires an owning session in this Project.')
  }
  sessions.assertFolderAccess(context.sessionId)
}

export function assertOwnedExecution(sessions: ExecutionAccess, executionId: string, context: ExecutionContext): SessionState {
  assertExecutionActor(sessions, context)
  const state = sessions.getSessionState(executionId)
  if (!state || state.projectId !== context.projectId || sessions.getDelegationOwner(executionId) !== context.sessionId) {
    throw new Error('Only the execution owner in this Project can access it.')
  }
  if (state.mode !== 'task' && state.mode !== 'call') throw new Error('Expected an execution, not a durable conversation.')
  sessions.assertFolderAccess(executionId)
  return state
}

/** Indexed parent history is a context fork, not delegation ownership. */
export function delegationOwner(state: SessionState | null | undefined): string | undefined {
  if (!state) return undefined
  if (state.mode === 'session') return undefined
  if (Object.hasOwn(state, 'parentSessionId')) return state.parentSessionId ?? undefined
  return state.parent?.index === undefined && (state.workspaceRoot || state.reportTo || state.description || state.parent?.physicalId)
    ? state.parent?.id : undefined
}
