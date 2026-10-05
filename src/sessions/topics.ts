import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { SessionManager } from './session-manager.ts'
import type { SessionState } from './session-store.ts'
import { localFolderWorkdirRef } from './locality.ts'
import { absoluteDirectoryPath, type FolderRegistry } from '../folders/registry.ts'
import type { InputSource } from './input.ts'
import { parseSessionName } from './session-name.ts'
import { workBindingSchema } from './work-policy.ts'

export const ORCHESTRATOR_SESSION_ID = 'web:orchestrator'
const briefFields = {
  title: z.string().transform(parseSessionName),
  description: z.string().trim().max(4000).optional(),
}
const createRequest = z.object({
  ...briefFields,
  requestId: z.string().uuid().transform(value => value.toLowerCase()).optional(),
  folderId: z.string().uuid().optional(),
  agentType: z.string().trim().min(1).max(100).default('general'),
  initiativeId: z.string().trim().min(1).max(600).optional(),
  initialMessage: z.string().trim().min(1).max(32_000).optional(),
  work: workBindingSchema.optional(),
}).strict()
const discoveryRequest = z.object({
  query: z.string().trim().max(500).default(''),
  limit: z.number().int().min(1).max(20).default(5),
  offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
}).strict()
const updateRequest = z.object({ sessionId: z.string().min(1).max(512), ...briefFields }).strict()

export class TopicError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409 = 400) {
    super(message)
    this.name = 'TopicError'
  }
}

export interface TopicSummary {
  sessionId: string
  conversationUrl: string
  chatId?: string
  title: string
  description: string
  folderId?: string
  initiativeId?: string
  createdBySessionId?: string
  status: string
  lastActivityAt?: string
  metadataSource: 'explicit' | 'description' | 'first_message' | 'identifier'
}

export interface TopicServiceOptions {
  projectId: string
  sessions: Pick<SessionManager, 'getSessionState' | 'buildSession' | 'assertFolderAccess' |
    'assertInitiativeAccess' | 'updateConversationMetadata' | 'deliver' | 'alignment'>
  listStates: () => Promise<SessionState[]>
  firstMessage?: (sessionId: string) => Promise<string | null>
  folders: Pick<FolderRegistry, 'register' | 'requireAvailable' | 'acquireAccess'>
  resolveAgent: (name: string) => { defaultMode: string } | undefined
  changed: (sessionId?: string) => void
}

function topicSummary(projectId: string, state: SessionState, firstMessage?: string | null): TopicSummary {
  return {
    sessionId: state.sessionId,
    conversationUrl: `/projects/${encodeURIComponent(projectId)}/chat/${encodeURIComponent(state.sessionId)}`,
    ...(state.sessionId.startsWith('web:') ? { chatId: state.sessionId.slice(4) } : {}),
    title: state.name ?? state.topic?.title ?? (state.description || firstMessage)?.split('\n')[0]?.slice(0, 160) ?? state.sessionId,
    description: state.description || (state.topic ? [state.topic.goal, state.topic.scope, state.topic.nonGoals].filter(Boolean).join('\n') : firstMessage) || '',
    folderId: state.folderId,
    initiativeId: state.initiativeId,
    createdBySessionId: state.createdBySessionId,
    status: state.recovery ? 'needs_attention' : state.executionStatus ?? 'idle',
    lastActivityAt: state.lastActivityAt,
    metadataSource: state.name || state.topic ? 'explicit' : state.description ? 'description' : firstMessage ? 'first_message' : 'identifier',
  }
}

export class TopicService {
  private coordinator?: Promise<{ projectId: string; sessionId: string; chatId: string }>
  private requests = new Map<string, Promise<TopicSummary & {
    initialMessageStatus: 'not_requested' | 'accepted' | 'not_replayed'
  }>>()

  constructor(private readonly options: TopicServiceOptions) {}

  assertActor(projectId: string | undefined, sessionId: string, mutation = false): SessionState {
    if (projectId !== this.options.projectId) throw new TopicError('Session access requires the owning Project.', 403)
    const state = this.options.sessions.getSessionState(sessionId)
    if (!state) throw new TopicError('The acting session does not belong to this Project.', 403)
    this.options.sessions.assertFolderAccess(sessionId)
    if (mutation && state.mode && state.mode !== 'session') {
      throw new TopicError('Temporary tasks/calls cannot create or manage durable sessions or register folders.', 403)
    }
    return state
  }

  async ensureOrchestrator() {
    if (this.coordinator) return this.coordinator
    this.coordinator = (async () => {
      const existing = this.options.sessions.getSessionState(ORCHESTRATOR_SESSION_ID)
      if (existing && (existing.sessionKind !== 'orchestrator' || existing.agentType !== 'orchestrator')) {
        throw new TopicError('The coordinator session ID is already occupied by another conversation.', 409)
      }
      if (!existing) {
        await this.options.sessions.buildSession(ORCHESTRATOR_SESSION_ID, undefined, {
          sessionKind: 'orchestrator', agentType: 'orchestrator', mode: 'session', parentSessionId: null,
          name: 'Project coordination',
        })
        this.options.changed(ORCHESTRATOR_SESSION_ID)
      }
      return { projectId: this.options.projectId, sessionId: ORCHESTRATOR_SESSION_ID, chatId: 'orchestrator' }
    })()
    try { return await this.coordinator }
    finally { this.coordinator = undefined }
  }

  async search(request: unknown = {}) {
    const { query, limit, offset } = discoveryRequest.parse(request)
    const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean)
    const entries = (await this.summaries())
      .filter(topic => {
        const text = [topic.sessionId, topic.title, topic.description,
          topic.folderId, topic.initiativeId].join('\n').toLocaleLowerCase()
        return terms.every(term => text.includes(term))
      })
    const sessions = entries.slice(offset, offset + limit)
    const hasMore = offset + sessions.length < entries.length
    return { sessions, totalMatches: entries.length, hasMore, nextOffset: hasMore ? offset + sessions.length : null }
  }

  async summaries(): Promise<TopicSummary[]> {
    const states = (await this.options.listStates())
      .filter(state => (state.mode ?? 'session') === 'session' &&
        state.sessionKind !== 'orchestrator' && state.sessionId !== ORCHESTRATOR_SESSION_ID &&
        !state.automation && (state.topicRequestHash || state.sessionKind === 'topic' ||
          !['reflector', 'soul-reflector', 'encapsulator'].includes(state.agentType ?? '')))
    const summaries: TopicSummary[] = []
    for (const state of states) {
      const firstMessage = !state.topic && !state.description ? await this.options.firstMessage?.(state.sessionId) : undefined
      summaries.push(topicSummary(this.options.projectId, state, firstMessage))
    }
    return summaries
      .sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? '') || a.sessionId.localeCompare(b.sessionId))
  }

  async create(request: unknown, createdBySessionId?: string, signal?: AbortSignal) {
    const parsed = createRequest.parse(request)
    if (createdBySessionId) this.assertActor(this.options.projectId, createdBySessionId, true)
    if (parsed.agentType === 'orchestrator') throw new TopicError('Use the existing Project coordinator; a peer session cannot be another orchestrator.')
    const agent = this.options.resolveAgent(parsed.agentType)
    if (!agent) throw new TopicError(`Unknown agent type "${parsed.agentType}".`)
    const requestId = parsed.requestId ?? randomUUID()
    const sessionId = `web:chat-${requestId}`
    const topicRequestHash = createHash('sha256').update(JSON.stringify({ ...parsed, requestId, createdBySessionId })).digest('hex')
    const inFlight = this.requests.get(sessionId)
    if (inFlight) {
      await inFlight
      return this.existing(sessionId, topicRequestHash, parsed.initialMessage !== undefined)
    }
    const promise = (async () => {
      signal?.throwIfAborted()
      const release = this.options.folders.acquireAccess()
      try {
        if (this.options.sessions.getSessionState(sessionId)) {
          return this.existing(sessionId, topicRequestHash, parsed.initialMessage !== undefined)
        }
        if (parsed.initiativeId) this.options.sessions.assertInitiativeAccess(parsed.initiativeId)
        const folder = parsed.folderId ? await this.options.folders.requireAvailable(parsed.folderId, signal) : undefined
        signal?.throwIfAborted()
        const alignment = this.options.sessions.alignment
        if (parsed.work && (!createdBySessionId || !alignment)) throw new TopicError('Managed creation requires a Project session controller and Work service.')
        const workPolicy = createdBySessionId && alignment
          ? alignment.prepareDelegation(createdBySessionId, parsed.work, 'session') : { mode: 'optional' as const }
        const { title, description } = parsed
        await this.options.sessions.buildSession(sessionId, undefined, {
          name: title,
          topicRequestHash, createdBySessionId, mode: 'session', parentSessionId: null,
          agentType: parsed.agentType, initiativeId: parsed.initiativeId,
          folderId: folder?.id,
          workdir: folder ? folder.kind === 'remote' ? folder.workdir : localFolderWorkdirRef(folder.id) : undefined,
          description,
          workPolicy,
        })
        if (parsed.work) await alignment!.bindDelegation(sessionId, createdBySessionId!, parsed.work, signal)
        this.options.changed(sessionId)
        if (parsed.initialMessage) {
          const inputId = randomUUID()
          const source: InputSource = createdBySessionId
            ? { kind: 'session', sessionId: createdBySessionId }
            : { kind: 'user', sender: { channel: 'web', chatId: sessionId.slice(4), senderId: 'web-user', messageId: inputId } }
          try {
            signal?.throwIfAborted()
            await this.options.sessions.deliver(sessionId, {
              id: inputId, kind: 'message', timestamp: new Date().toISOString(), source,
              policy: 'queue', content: parsed.initialMessage,
            })
          } catch (error) {
            throw new TopicError(`Session ${sessionId} was created, but its initial message was not confirmed accepted: ${error instanceof Error ? error.message : String(error)}. Inspect the session before sending it again.`, 409)
          }
        }
        return { ...this.requireSummary(sessionId), initialMessageStatus: parsed.initialMessage ? 'accepted' as const : 'not_requested' as const }
      } finally { release() }
    })()
    this.requests.set(sessionId, promise)
    try { return await promise }
    finally { this.requests.delete(sessionId) }
  }

  async update(request: unknown, actorSessionId?: string) {
    const { sessionId, ...topic } = updateRequest.parse(request)
    const state = this.options.sessions.getSessionState(sessionId)
    if (!state) throw new TopicError('Session not found in this Project.', 404)
    if (actorSessionId) {
      const actor = this.assertActor(this.options.projectId, actorSessionId, true)
      if (actorSessionId !== sessionId && actor.sessionKind !== 'orchestrator') {
        throw new TopicError('Only this session or the Project coordinator can change its metadata.', 403)
      }
    }
    if (state.sessionKind === 'orchestrator' || state.automation || (state.mode ?? 'session') !== 'session') {
      throw new TopicError('Only ordinary durable session metadata can be updated.')
    }
    await this.options.sessions.updateConversationMetadata(sessionId, topic)
    this.options.changed(sessionId)
    return this.requireSummary(sessionId)
  }

  async registerFolder(path: unknown, signal?: AbortSignal) {
    const folder = await this.options.folders.register(absoluteDirectoryPath(path), signal)
    this.options.changed()
    return { folder }
  }

  private requireSummary(sessionId: string) {
    const state = this.options.sessions.getSessionState(sessionId)
    if (!state) throw new TopicError('Session no longer exists.', 404)
    return topicSummary(this.options.projectId, state)
  }

  private existing(sessionId: string, hash: string, hasInitialMessage: boolean) {
    const state = this.options.sessions.getSessionState(sessionId)
    if (!state || state.topicRequestHash !== hash) throw new TopicError('requestId is already used by another session creation request.', 409)
    this.options.sessions.assertFolderAccess(sessionId)
    if (state.workPolicy?.mode === 'required') {
      const alignment = this.options.sessions.alignment
      if (!alignment || state.workPolicy.keys.some(key => alignment.store.workAuthority(alignment.get(key).subject).executor !== sessionId)) {
        throw new TopicError('Managed session creation is incomplete: inspect and finish its Work assignment before sending a kickoff. Initial messages are not replayed.', 409)
      }
    }
    return { ...topicSummary(this.options.projectId, state), initialMessageStatus: hasInitialMessage ? 'not_replayed' as const : 'not_requested' as const }
  }
}
