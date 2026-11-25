import type { ExecutionContext } from '../tools/context.ts'
import type { SessionState } from './session-store.ts'

/** Legacy durable sessions omit mode; execution itself treats that as session. */
export function isOwnerSession(state: SessionState | null | undefined, projectId: string): boolean {
  return !!state && state.projectId === projectId && (state.mode ?? 'session') === 'session' &&
    !state.parentSessionId && !state.parent && !state.automation && !state.statePersistence && state.sessionId.startsWith('web:')
}

type OwnerContext = Pick<ExecutionContext, 'sessionId' | 'channel' | 'inputSource' | 'admin' | 'isGroup' | 'channelAddress'> & Partial<Pick<ExecutionContext, 'tools' | 'memoryAccess'>>

function isPrivateWebSession(context: OwnerContext): boolean {
  return context.sessionId.startsWith('web:') && context.channel === 'web' &&
    context.isGroup !== true && context.channelAddress === undefined && !context.memoryAccess &&
    (context.tools === undefined || context.tools.executionMode === 'session')
}

/** Only direct administrator turns in private Web sessions may manage Project capabilities. */
export function isDirectOwnerTurn(context: OwnerContext): boolean {
  return isPrivateWebSession(context) && context.inputSource === 'user' && context.admin === true
}

/** BOT control-plane ownership only. Resolve structural lineage from host records,
 * never from tool arguments, input-source/admin bits, or historical fork parents.
 * Other capabilities intentionally retain isDirectOwnerTurn's stricter policy.
 */
export function botWebExecutionOwner(
  sessionId: string, projectId: string,
  lookup: (id: string) => SessionState | null | undefined,
): string | undefined {
  const seen = new Set<string>()
  let id = sessionId
  while (!seen.has(id)) {
    seen.add(id)
    const state = lookup(id)
    if (!state || state.sessionId !== id || state.projectId !== projectId || state.automation || state.statePersistence || state.serviceGeneration || state.channelBoundary || state.channelSource) return
    if (!state.parentSessionId) return isOwnerSession(state, projectId) ? id : undefined
    // Only host-owned execution lineage conveys authority; workspaceRoot and
    // fork snapshots do not. Channel/Service sessions cannot borrow a Web parent.
    if (!['web:', 'virtual:', 'task:', 'call:'].some(prefix => id.startsWith(prefix))) return
    id = state.parentSessionId
  }
}
