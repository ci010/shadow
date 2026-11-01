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
