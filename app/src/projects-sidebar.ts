import type { ProjectRecord } from '../../src/projects/contracts.ts'
import { isReasoningEffort, type ReasoningEffort } from '../../src/agent/llm-config.ts'
import { isSelfReflectionId } from '../../src/sessions/session-purpose.ts'
import { isExecutionStatus, persistentConversations, type ExecutionStatus } from './subagent-executions.ts'

export const PROJECT_ACTIONS = [
  { id: 'open', label: 'Open folder' },
  { id: 'remote', label: 'Open remote folder' },
  { id: 'clone', label: 'Clone repo' },
  { id: 'scratch', label: 'Start from scratch' },
] as const

export interface SidebarSession {
  sessionId: string
  label: string
  description?: string
  projectId?: string
  isDirectChat: boolean
  isCurrent: boolean
  parentSessionId: string | null
  contextParentSessionId?: string | null
  depth: number
  mode?: 'session' | 'task' | 'call'
  agentType?: string
  executionStatus?: ExecutionStatus
  waitingForCall?: boolean
  parentToolCallId?: string
  config?: {
    model?: string
    thinking?: { type: 'enabled' | 'disabled' }
    reasoningEffort?: ReasoningEffort
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Context-only forks belong in navigation, never in delegation ownership. */
export function sessionNavigationParent(session: SidebarSession | undefined): string | null {
  if (!session) return null
  return session.parentSessionId
    ?? (session.mode !== 'task' && session.mode !== 'call' ? session.contextParentSessionId : null)
    ?? null
}

function flattenSessions(sessions: SidebarSession[]): SidebarSession[] {
  const ids = new Set(sessions.map(s => s.sessionId))
  const children = new Map<string, SidebarSession[]>()
  for (const session of sessions) {
    const parent = sessionNavigationParent(session)
    if (parent && ids.has(parent)) {
      const siblings = children.get(parent) ?? []
      siblings.push(session)
      children.set(parent, siblings)
    }
  }
  const visited = new Set<string>()
  const result: SidebarSession[] = []
  function walk(session: SidebarSession, depth: number) {
    if (visited.has(session.sessionId)) return
    visited.add(session.sessionId)
    result.push({ ...session, depth })
    for (const child of children.get(session.sessionId) ?? []) walk(child, depth + 1)
  }
  for (const session of sessions) {
    const parent = sessionNavigationParent(session)
    if (!parent || !ids.has(parent)) walk(session, 0)
  }
  // A malformed lineage must not hide conversations or recurse forever.
  for (const session of sessions) walk(session, 0)
  return result
}

export function parseSessionGraph(value: unknown, organizationId?: string): SidebarSession[] {
  const invalid = () => new Error('Cannot read conversations from Main. Refresh to retry.')
  if (!isRecord(value) || !Array.isArray(value.sessions) || !Array.isArray(value.nodes)) throw invalid()
  const physicalToLogical = new Map<string, string>()
  for (const node of value.nodes) {
    if (!isRecord(node) || typeof node.physicalId !== 'string' || typeof node.logicalId !== 'string'
      || (node.parentPhysicalId != null && typeof node.parentPhysicalId !== 'string')) throw invalid()
    physicalToLogical.set(node.physicalId, node.logicalId)
  }
  const parents = new Map<string, string>()
  for (const node of value.nodes) {
    const parent = physicalToLogical.get(node.parentPhysicalId)
    if (parent && parent !== node.logicalId) parents.set(node.logicalId, parent)
  }
  const sessionIds = new Set<string>()
  return flattenSessions(value.sessions.map((session: unknown) => {
    if (!isRecord(session) || typeof session.sessionId !== 'string' || !session.sessionId.trim() || sessionIds.has(session.sessionId)
      || (organizationId !== undefined && session.organizationId !== undefined && session.organizationId !== organizationId)
      || (organizationId !== undefined && session.parentOrganizationId !== undefined && session.parentOrganizationId !== organizationId)
      || (session.projectId !== undefined && typeof session.projectId !== 'string')
      || (session.title !== undefined && typeof session.title !== 'string')
      || (session.mode !== undefined && session.mode !== 'session' && session.mode !== 'task' && session.mode !== 'call')
      || (session.agentType !== undefined && (typeof session.agentType !== 'string' || !session.agentType))
      || (session.parentSessionId !== undefined && session.parentSessionId !== null && (typeof session.parentSessionId !== 'string' || !session.parentSessionId))
      || (session.executionStatus !== undefined && !isExecutionStatus(session.executionStatus))
      || (session.waitingForCall !== undefined && typeof session.waitingForCall !== 'boolean')
      || (session.parentToolCallId !== undefined && (typeof session.parentToolCallId !== 'string' || !session.parentToolCallId))
      || (session.description !== undefined && typeof session.description !== 'string')) throw invalid()
    sessionIds.add(session.sessionId)
    const direct = session.sessionId.startsWith('web:chat-') && session.mode !== 'task' && session.mode !== 'call'
    const config = isRecord(session.config) ? session.config : undefined
    return {
      sessionId: session.sessionId,
      label: typeof session.title === 'string' && session.title ? session.title : (direct ? session.sessionId.replace('web:', '') : session.sessionId),
      description: session.description as string | undefined,
      projectId: session.projectId as string | undefined,
      isDirectChat: direct,
      isCurrent: !!session.current,
      parentSessionId: session.parentSessionId !== undefined ? session.parentSessionId as string | null : parents.get(session.sessionId) ?? null,
      contextParentSessionId: session.parentSessionId === null && session.mode !== 'task' && session.mode !== 'call'
        ? parents.get(session.sessionId) ?? null : undefined,
      depth: 0,
      mode: session.mode as SidebarSession['mode'],
      agentType: session.agentType as string | undefined,
      executionStatus: session.executionStatus as ExecutionStatus | undefined,
      waitingForCall: session.waitingForCall as boolean | undefined,
      parentToolCallId: session.parentToolCallId as string | undefined,
      config: config ? {
        model: typeof config.model === 'string' ? config.model : undefined,
        thinking: isRecord(config.thinking) && (config.thinking.type === 'enabled' || config.thinking.type === 'disabled')
          ? { type: config.thinking.type } : undefined,
        reasoningEffort: isReasoningEffort(config.reasoningEffort) ? config.reasoningEffort : undefined,
      } : undefined,
    }
  }))
}

export function groupProjectSessions(projects: ProjectRecord[], sessions: SidebarSession[]) {
  sessions = persistentConversations(sessions)
  const projectIds = new Set(projects.map(project => project.id))
  const children = new Map<string, string[]>()
  const pending: string[] = []
  for (const session of sessions) {
    if (isSelfReflectionId(session.sessionId)) pending.push(session.sessionId)
    const parent = sessionNavigationParent(session)
    if (parent) {
      const siblings = children.get(parent) ?? []
      siblings.push(session.sessionId)
      children.set(parent, siblings)
      if (isSelfReflectionId(parent)) pending.push(parent)
    }
  }
  const reflectionIds = new Set<string>()
  for (let index = 0; index < pending.length; index++) {
    const id = pending[index]
    if (reflectionIds.has(id)) continue
    reflectionIds.add(id)
    pending.push(...(children.get(id) ?? []))
  }
  const regular = sessions.filter(session => !reflectionIds.has(session.sessionId))
  return {
    projects: projects.map(project => ({
      project,
      sessions: flattenSessions(regular.filter(session => session.projectId === project.id)),
    })),
    chats: flattenSessions(regular.filter(session => !session.projectId || !projectIds.has(session.projectId))),
    reflections: flattenSessions(sessions.filter(session => reflectionIds.has(session.sessionId))),
  }
}

export function visibleSessions(sessions: SidebarSession[], collapsed: ReadonlySet<string>): SidebarSession[] {
  const byId = new Map(sessions.map(session => [session.sessionId, session]))
  return sessions.filter(session => {
    // A root chosen while flattening a cycle must remain available to expand it.
    if (session.depth === 0) return true
    const visited = new Set([session.sessionId])
    let parent = sessionNavigationParent(session)
    while (parent && byId.has(parent) && !visited.has(parent)) {
      if (collapsed.has(parent)) return false
      visited.add(parent)
      parent = sessionNavigationParent(byId.get(parent))
    }
    return true
  })
}

export function suggestCloneDirectory(url: string): string {
  const path = url.trim().split(/[?#]/)[0].replace(/\/+$/, '')
  const name = path.split(/[/:]/).at(-1)?.replace(/\.git$/i, '') ?? ''
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/[. ]+$/, '')
}

export function isAbsoluteProjectPath(path: string): boolean {
  return /^(?:[a-zA-Z]:[\\/]|\\\\[^\\]+\\[^\\]+|\/)/.test(path.trim())
}
