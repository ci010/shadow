import { sessionNavigationParent, type SidebarSession } from './folders-sidebar.ts'
import type { SessionStage } from './session-activity.ts'

export type ExecutionStatus = 'pending' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled'
export function isExecutionStatus(value: unknown): value is ExecutionStatus {
  return ['pending', 'running', 'waiting', 'completed', 'failed', 'cancelled'].includes(value as string)
}
export function isOneShot(session: Pick<SidebarSession, 'mode'> | undefined): boolean {
  return session?.mode === 'task' || session?.mode === 'call'
}
export function executionStatus(session: SidebarSession, stage?: string): ExecutionStatus | undefined {
  // Durable terminal state outranks stale live activity.
  if (session.executionStatus && ['completed', 'failed', 'cancelled'].includes(session.executionStatus)) return session.executionStatus
  if ((session.mode !== 'call' && session.waitingForCall) || stage === 'waiting' || stage === 'waiting-for-call') return 'waiting'
  if (stage === 'llm' || stage === 'tool') return 'running'
  return session.executionStatus
}
export function executionDisplayStage(session: SidebarSession, stage?: string): SessionStage | undefined {
  const status = executionStatus(session, stage)
  return status === 'waiting' && session.mode !== 'call' && (session.waitingForCall || stage === 'waiting-for-call') ? 'waiting-for-call' : status
}
export function executionStages(sessions: readonly SidebarSession[], stages: Record<string, SessionStage>): Record<string, SessionStage> {
  const result = { ...stages }
  for (const session of sessions) {
    if (!isOneShot(session) && !session.waitingForCall) continue
    const status = executionDisplayStage(session, stages[session.sessionId])
    if (status) result[session.sessionId] = status
    else delete result[session.sessionId]
  }
  return result
}
export function ownedExecutions(sessions: readonly SidebarSession[], ownerId: string): SidebarSession[] {
  return sessions.filter(session => session.sessionId !== ownerId && session.parentSessionId === ownerId && isOneShot(session))
}
export function persistentConversations(sessions: readonly SidebarSession[]): SidebarSession[] {
  const byId = new Map(sessions.map(session => [session.sessionId, session]))
  const hidden = new Set<string>()
  for (const session of sessions) {
    if (!isOneShot(session) || !session.parentSessionId) continue
    const seen = new Set([session.sessionId])
    let parent = byId.get(session.parentSessionId)
    while (parent && !seen.has(parent.sessionId)) {
      seen.add(parent.sessionId)
      if (!isOneShot(parent) || !parent.parentSessionId) {
        hidden.add(session.sessionId)
        break
      }
      parent = parent.parentSessionId ? byId.get(parent.parentSessionId) : undefined
    }
  }
  // Incomplete/cyclic graphs keep an inspectable entry rather than losing diagnostics.
  return sessions.filter(session => !hidden.has(session.sessionId)).map(session => {
    let parent = sessionNavigationParent(session)
    while (parent && hidden.has(parent)) parent = sessionNavigationParent(byId.get(parent))
    if (parent === sessionNavigationParent(session)) return session
    return session.parentSessionId === null
      ? { ...session, contextParentSessionId: parent }
      : { ...session, parentSessionId: parent }
  })
}
