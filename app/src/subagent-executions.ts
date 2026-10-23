import { t } from './i18n.ts'
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

export interface SubagentActivity { running: number; waiting: number; pending: number }

export function activeSubagentsByOwner(sessions: readonly SidebarSession[], stages: Record<string, string>): Map<string, SidebarSession[]> {
  const byId = new Map(sessions.map(session => [session.sessionId, session]))
  const result = new Map<string, SidebarSession[]>()
  for (const session of sessions) {
    if (!isOneShot(session)) continue
    const status = executionStatus(session, stages[session.sessionId])
    if (status !== 'running' && status !== 'waiting' && status !== 'pending') continue
    const seen = new Set([session.sessionId])
    let owner = session.parentSessionId ? byId.get(session.parentSessionId) : undefined
    while (owner && !seen.has(owner.sessionId)) {
      if (session.projectId && owner.projectId && session.projectId !== owner.projectId) break
      seen.add(owner.sessionId)
      const executions = result.get(owner.sessionId) ?? []
      executions.push(session)
      result.set(owner.sessionId, executions)
      // Persistent conversation lineage is history, not delegated work ownership.
      if (!isOneShot(owner)) break
      owner = owner.parentSessionId ? byId.get(owner.parentSessionId) : undefined
    }
  }
  return result
}

export function summarizeSubagents(sessions: readonly SidebarSession[], stages: Record<string, string>): SubagentActivity {
  const activity: SubagentActivity = { running: 0, waiting: 0, pending: 0 }
  for (const session of new Map(sessions.map(session => [session.sessionId, session])).values()) {
    const stage = executionDisplayStage(session, stages[session.sessionId])
    if (stage === 'running' || stage === 'waiting-for-call') activity.running++
    else if (stage === 'waiting') activity.waiting++
    else if (stage === 'pending') activity.pending++
  }
  return activity
}

export function subagentActivityLabel(activity?: SubagentActivity): string {
  if (!activity) return ''
  return (['running', 'waiting', 'pending'] as const).flatMap(kind => {
    const count = activity[kind]
    const message = kind === 'running' ? '{count} subagents working'
      : kind === 'waiting' ? '{count} subagents waiting for a response' : '{count} subagents pending'
    return count ? [t(message, { count }, count)] : []
  }).join(', ')
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
