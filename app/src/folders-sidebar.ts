import { t } from './i18n.ts'
import { sessionActivity } from './session-activity.ts'
import type { FolderRecord } from '../../src/folders/contracts.ts'
import { isReasoningEffort, type ReasoningEffort } from '../../src/agent/llm-config.ts'
import { parseAutomationSessionRef, type AutomationSessionRef } from '../../src/cron/contracts.ts'
import { isExecutionStatus, persistentConversations, type ExecutionStatus } from './subagent-executions.ts'
import { isDirectConversation, ORCHESTRATOR_SESSION_ID, parseTopicMetadata, type TopicMetadata } from './project-coordination.ts'
import { channelAddressFromSessionId, type ChannelAddress } from '../../src/bus/events.ts'

export const FOLDER_ACTIONS = [
  { id: 'open', get label() { return t('Open folder') } },
  { id: 'clone', get label() { return t('Clone repository') } },
  { id: 'scratch', get label() { return t('Start from scratch') } },
] as const

export interface SidebarSession {
  automation?: AutomationSessionRef
  sessionId: string
  projectId?: string
  channelAddress?: ChannelAddress
  sessionKind?: 'topic' | 'orchestrator'
  topic?: TopicMetadata
  createdBySessionId?: string
  label: string
  /** Human title shared by sidebar and references; never an identifier fallback. */
  title?: string
  lastActivityAt?: string
  description?: string
  folderId?: string
  isDirectChat: boolean
  isCurrent: boolean
  parentSessionId: string | null
  contextParentSessionId?: string | null
  depth: number
  mode?: 'session' | 'task' | 'call'
  agentType?: string
  completed?: boolean
  hasCron?: boolean
  executionStatus?: ExecutionStatus
  waitingForCall?: boolean
  parentToolCallId?: string
  config?: {
    model?: string
    thinking?: { type: 'enabled' | 'disabled' }
    contextWindow?: number
    reasoningEffort?: ReasoningEffort
  }
  inferenceDefaults?: {
    model: string
    thinking?: { type: 'enabled' | 'disabled' }
    contextWindow?: number
    reasoningEffort?: ReasoningEffort
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Only temporary executions nest; historical lineage does not own a conversation. */
export function sessionNavigationParent(session: SidebarSession | undefined): string | null {
  return session?.mode === 'task' || session?.mode === 'call' ? session.parentSessionId : null
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

/** Graph name, coordination and topic titles have the same priority everywhere. */
export function sessionDisplayTitle(session: { name?: unknown; sessionId?: unknown; title?: unknown }, topic?: TopicMetadata): string {
  if (typeof session.name === 'string' && session.name.trim()) return session.name
  if (session.sessionId === ORCHESTRATOR_SESSION_ID) return t('Project coordination')
  if (topic?.title?.trim()) return topic.title
  if (typeof session.title === 'string' && session.title.trim()) return session.title
  return t('New conversation')
}

export function parseSessionGraph(value: unknown, projectId?: string): SidebarSession[] {
  const invalid = () => new Error(t('Cannot read conversations from Main. Refresh to retry.'))
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
      || (session.projectId !== undefined && (typeof session.projectId !== 'string' || !session.projectId))
      || (projectId !== undefined && session.projectId !== undefined && session.projectId !== projectId)
      || (projectId !== undefined && session.parentProjectId !== undefined && session.parentProjectId !== projectId)
      || (session.folderId !== undefined && typeof session.folderId !== 'string')
      || (session.title !== undefined && typeof session.title !== 'string')
      || (session.name !== undefined && (typeof session.name !== 'string' || !session.name.trim()))
      || (session.sessionKind !== undefined && session.sessionKind !== 'topic' && session.sessionKind !== 'orchestrator')
      || (session.createdBySessionId !== undefined && typeof session.createdBySessionId !== 'string')
      || (session.mode !== undefined && session.mode !== 'session' && session.mode !== 'task' && session.mode !== 'call')
      || (session.agentType !== undefined && (typeof session.agentType !== 'string' || !session.agentType))
      || (session.parentSessionId !== undefined && session.parentSessionId !== null && (typeof session.parentSessionId !== 'string' || !session.parentSessionId))
      || (session.executionStatus !== undefined && !isExecutionStatus(session.executionStatus))
      || (session.hasCron !== undefined && typeof session.hasCron !== 'boolean')
      || (session.waitingForCall !== undefined && typeof session.waitingForCall !== 'boolean')
      || (session.parentToolCallId !== undefined && (typeof session.parentToolCallId !== 'string' || !session.parentToolCallId))
      || (session.description !== undefined && typeof session.description !== 'string')) throw invalid()
    let channelAddress: ChannelAddress | undefined
    try { channelAddress = channelAddressFromSessionId(session.sessionId) }
    catch { throw invalid() }
    if (channelAddress && (projectId !== undefined && channelAddress.projectId !== projectId
      || session.projectId !== undefined && channelAddress.projectId !== session.projectId)) throw invalid()
    let automation: AutomationSessionRef | undefined
    if (session.automation !== undefined) {
      const value = session.automation
      if (!isRecord(value) || value.contextMode !== 'fresh'
        || typeof value.jobId !== 'string' || !value.jobId.trim()
        || typeof value.name !== 'string' || !value.name.trim()
        || typeof value.runId !== 'string' || !value.runId.trim()
        || typeof value.startedAt !== 'string' || !Number.isFinite(Date.parse(value.startedAt))) throw invalid()
      try { automation = parseAutomationSessionRef(value) }
      catch { throw invalid() }
    }
    sessionIds.add(session.sessionId)
    const direct = isDirectConversation(session.sessionId, session.mode as string | undefined)
    const topic = parseTopicMetadata(session.topic)
    const config = isRecord(session.config) ? session.config : undefined
    const defaults = session.inferenceDefaults
    if (defaults != null && (!isRecord(defaults) || typeof defaults.model !== 'string' || !defaults.model.trim()
      || (defaults.thinking !== undefined && (!isRecord(defaults.thinking) || (defaults.thinking.type !== 'enabled' && defaults.thinking.type !== 'disabled')))
      || (defaults.reasoningEffort !== undefined && !isReasoningEffort(defaults.reasoningEffort)))) throw invalid()
    return {
      sessionId: session.sessionId,
      projectId: session.projectId as string | undefined,
      channelAddress,
      inferenceDefaults: isRecord(defaults) && typeof defaults.model === 'string' ? {
        model: defaults.model,
        ...(typeof defaults.contextWindow === "number" ? { contextWindow: defaults.contextWindow } : {}),
        thinking: isRecord(defaults.thinking) ? { type: defaults.thinking.type === 'enabled' ? 'enabled' : 'disabled' } : undefined,
        reasoningEffort: isReasoningEffort(defaults.reasoningEffort) ? defaults.reasoningEffort : undefined,
      } : undefined,
      sessionKind: session.sessionKind as SidebarSession['sessionKind'],
      topic,
      createdBySessionId: session.createdBySessionId as string | undefined,
      automation,
      title: sessionDisplayTitle(session, topic),
      label: sessionDisplayTitle(session, topic),
      lastActivityAt: typeof session.lastActivityAt === 'string' && Number.isFinite(Date.parse(session.lastActivityAt)) ? session.lastActivityAt : undefined,
      description: session.description as string | undefined,
      folderId: session.folderId as string | undefined,
      isDirectChat: direct,
      isCurrent: !!session.current,
      parentSessionId: session.parentSessionId !== undefined ? session.parentSessionId as string | null : parents.get(session.sessionId) ?? null,
      contextParentSessionId: session.parentSessionId === null && session.mode !== 'task' && session.mode !== 'call'
        ? parents.get(session.sessionId) ?? null : undefined,
      depth: 0,
      mode: session.mode as SidebarSession['mode'],
      agentType: session.agentType as string | undefined,
      completed: session.completed === true,
      hasCron: session.hasCron === true,
      executionStatus: session.executionStatus as ExecutionStatus | undefined,
      waitingForCall: session.waitingForCall as boolean | undefined,
      parentToolCallId: session.parentToolCallId as string | undefined,
      config: config ? {
        ...(typeof config.contextWindow === "number" ? { contextWindow: config.contextWindow } : {}),
        model: typeof config.model === 'string' ? config.model : undefined,
        thinking: isRecord(config.thinking) && (config.thinking.type === 'enabled' || config.thinking.type === 'disabled')
          ? { type: config.thinking.type } : undefined,
        reasoningEffort: isReasoningEffort(config.reasoningEffort) ? config.reasoningEffort : undefined,
      } : undefined,
    }
  }))
}

export function automationSessionOwners(sessions: SidebarSession[]): Map<string, AutomationSessionRef> {
  const owners = new Map<string, AutomationSessionRef>()
  const children = new Map<string, string[]>()
  for (const session of sessions) {
    if (session.automation) owners.set(session.sessionId, session.automation)
    const parent = sessionNavigationParent(session)
    if (parent) {
      const siblings = children.get(parent) ?? []
      siblings.push(session.sessionId)
      children.set(parent, siblings)
    }
  }
  const pending = [...owners.keys()]
  for (let index = 0; index < pending.length; index++) {
    const id = pending[index]
    for (const child of children.get(id) ?? []) {
      if (owners.has(child)) continue
      owners.set(child, owners.get(id)!)
      pending.push(child)
    }
  }
  return owners
}

export function groupFolderSessions(folders: FolderRecord[], sessions: SidebarSession[]) {
  const owners = automationSessionOwners(sessions)
  const regular = persistentConversations(sessions).filter(session => !owners.has(session.sessionId)
    && session.sessionKind !== 'orchestrator' && session.sessionId !== ORCHESTRATOR_SESSION_ID)
  const folderIds = new Set(folders.map(folder => folder.id))
  const automations = new Map<string, { id: string; name: string; sessions: SidebarSession[] }>()
  for (const session of sessions) {
    const owner = owners.get(session.sessionId)
    if (!owner) continue
    const group = automations.get(owner.jobId) ?? { id: owner.jobId, name: owner.name, sessions: [] }
    group.sessions.push(session)
    automations.set(owner.jobId, group)
  }
  return {
    unified: flattenSessions(regular),
    folders: folders.map(folder => ({
      folder,
      sessions: flattenSessions(regular.filter(session => session.folderId === folder.id)),
    })),
    chats: flattenSessions(regular.filter(session => !session.folderId || !folderIds.has(session.folderId))),
    automations: [...automations.values()].map(group => ({ ...group, sessions: flattenSessions(group.sessions) })),
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

export function isAbsoluteFolderPath(path: string): boolean {
  return /^(?:[a-zA-Z]:[\\/]|\\\\[^\\]+\\[^\\]+|\/)/.test(path.trim())
}

/** Sidebar-only completion presentation; live and execution outcomes remain authoritative.
 * Missing activity is the sidebar's inactive fallback, not a persisted status change.
 * SessionActivity still promotes delegated work over these non-working stages.
 */
export function sidebarSessionIconStage(stage: string | undefined, completed: boolean | undefined): string {
  const displayStage = stage ?? 'inactive'
  const activity = sessionActivity(displayStage)
  return activity.kind === 'idle' || activity.kind === 'inactive'
    ? completed ? 'completed' : 'inactive'
    : displayStage
}

export type ChatListSort = 'time' | 'folder'
export interface ChatListPreferences { folderGrouped: boolean; sort: ChatListSort }
const chatListKey = (apiBase: string, projectId?: string) => 'shadow:chat-list:' + JSON.stringify([apiBase, projectId ?? ''])
export function restoreChatListPreferences(storage: Pick<Storage, 'getItem'>, apiBase: string, projectId?: string): ChatListPreferences {
  try {
    const value = JSON.parse(storage.getItem(chatListKey(apiBase, projectId)) ?? 'null')
    return { folderGrouped: value?.folderGrouped === true, sort: value?.sort === 'folder' ? 'folder' : 'time' }
  } catch { return { folderGrouped: false, sort: 'time' } }
}
export function saveChatListPreferences(storage: Pick<Storage, 'setItem'>, apiBase: string, projectId: string | undefined, value: ChatListPreferences) {
  try { storage.setItem(chatListKey(apiBase, projectId), JSON.stringify(value)) } catch { /* Storage is optional. */ }
}
/** lastActivityAt is set when messages are persisted, not when a chat is merely opened. */
export function sortSidebarChats(sessions: SidebarSession[], folders: ReadonlyMap<string, string>, sort: ChatListSort): SidebarSession[] {
  const timestamp = (session: SidebarSession) => {
    const time = Date.parse(session.lastActivityAt ?? '')
    return Number.isFinite(time) ? time : 0
  }
  return [...sessions].sort((a, b) => {
    if (sort === 'folder') {
      const folderKey = (session: SidebarSession) => session.folderId ? folders.get(session.folderId) ?? session.folderId : ''
      const folderOrder = folderKey(a).localeCompare(folderKey(b)) || (a.folderId ?? '').localeCompare(b.folderId ?? '')
      if (folderOrder) return folderOrder
    }
    return timestamp(b) - timestamp(a) || a.sessionId.localeCompare(b.sessionId)
  })
}
