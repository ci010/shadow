import type { ProjectRecord } from '../../src/projects/contracts.ts'

export const PROJECT_ACTIONS = [
  { id: 'open', label: 'Open folder' },
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
  depth: number
  config?: {
    model?: string
    thinking?: { type: 'enabled' | 'disabled' }
    reasoningEffort?: 'high' | 'max'
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function flattenSessions(sessions: SidebarSession[]): SidebarSession[] {
  const ids = new Set(sessions.map(s => s.sessionId))
  const children = new Map<string, SidebarSession[]>()
  for (const session of sessions) {
    if (session.parentSessionId && ids.has(session.parentSessionId)) {
      const siblings = children.get(session.parentSessionId) ?? []
      siblings.push(session)
      children.set(session.parentSessionId, siblings)
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
    if (!session.parentSessionId || !ids.has(session.parentSessionId)) walk(session, 0)
  }
  // A malformed lineage must not hide conversations or recurse forever.
  for (const session of sessions) walk(session, 0)
  return result
}

export function parseSessionGraph(value: unknown): SidebarSession[] {
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
  return flattenSessions(value.sessions.map((session: unknown) => {
    if (!isRecord(session) || typeof session.sessionId !== 'string' || !session.sessionId
      || (session.projectId !== undefined && typeof session.projectId !== 'string')
      || (session.title !== undefined && typeof session.title !== 'string')
      || (session.description !== undefined && typeof session.description !== 'string')) throw invalid()
    const direct = session.sessionId.startsWith('web:chat-')
    const config = isRecord(session.config) ? session.config : undefined
    return {
      sessionId: session.sessionId,
      label: typeof session.title === 'string' && session.title ? session.title : (direct ? session.sessionId.replace('web:', '') : session.sessionId),
      description: session.description as string | undefined,
      projectId: session.projectId as string | undefined,
      isDirectChat: direct,
      isCurrent: !!session.current,
      parentSessionId: parents.get(session.sessionId) ?? null,
      depth: 0,
      config: config ? {
        model: typeof config.model === 'string' ? config.model : undefined,
        thinking: isRecord(config.thinking) && (config.thinking.type === 'enabled' || config.thinking.type === 'disabled')
          ? { type: config.thinking.type } : undefined,
        reasoningEffort: config.reasoningEffort === 'high' || config.reasoningEffort === 'max' ? config.reasoningEffort : undefined,
      } : undefined,
    }
  }))
}

export function groupProjectSessions(projects: ProjectRecord[], sessions: SidebarSession[]) {
  const projectIds = new Set(projects.map(project => project.id))
  return {
    projects: projects.map(project => ({
      project,
      sessions: flattenSessions(sessions.filter(session => session.projectId === project.id)),
    })),
    chats: flattenSessions(sessions.filter(session => !session.projectId || !projectIds.has(session.projectId))),
  }
}

export function visibleSessions(sessions: SidebarSession[], collapsed: ReadonlySet<string>): SidebarSession[] {
  const byId = new Map(sessions.map(session => [session.sessionId, session]))
  return sessions.filter(session => {
    const visited = new Set([session.sessionId])
    let parent = session.parentSessionId
    while (parent && byId.has(parent) && !visited.has(parent)) {
      if (collapsed.has(parent)) return false
      visited.add(parent)
      parent = byId.get(parent)!.parentSessionId
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
