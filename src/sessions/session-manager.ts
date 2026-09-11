import { trace } from '@opentelemetry/api'
import type { Hono } from 'hono'
import type { AgentTypesManager } from '../agent/agent-types/manager.ts'
import type { AgentTypeDefinition } from '../agent/agent-types/types.ts'
import type { BackgroundTaskManager } from '../agent/background-task.ts'
import type {
  ContextBuilder,
  SessionPromptContext,
} from '../agent/context/builder.ts'
import type { EventService } from '../events/service.ts'
import type { IdentityManager } from '../agent/identity.ts'
import type { LlmRuntimeConfig } from '../agent/llm-config.ts'
import type { Bus } from '../bus/bus.ts'
import { deriveSessionId, type InboundMessage } from '../bus/events.ts'
import type { HandoffManager } from '../handoff/manager.ts'
import type { ChatMessage, LLMProvider } from '../providers/provider.ts'
import { ImportTool } from '../tools/load-tool.ts'
import { SessionTools, type Tools } from '../tools/registry.ts'
import type { ExecShell } from '../tools/shell.ts'
import {
  sanitizeToolPairs,
  truncatePreservingToolPairs,
} from '../utils/messages.ts'
import { Span } from '../utils/otel.ts'
import { newPhysicalSessionId } from '../utils/paths.ts'
import { isToolAllowed } from '../utils/tool-allow.ts'
import { errMsg } from '../utils/truncate.ts'
import { EphemeralSession } from './ephemeral-session.ts'
import { LOCAL_NODE_ID, type WorkdirCapabilityLookup, type WorkdirRefV1 } from './locality.ts'
import type { Executor } from '../execution/executor.ts'
import type {
  SessionConfig,
  SessionParent,
  SessionStartEvent,
  SessionState,
  SessionStore,
} from './session-store.ts'
import { Session } from './session.ts'
import {
  channelMessageInput,
  inputContext,
  type DeliveryReceipt,
  type SessionInput,
} from './input.ts'

export type { SessionState, SessionStore } from './session-store.ts'

/**
 * Strip the leading `<sender .../>` or `<event .../>` metadata tag that is
 * prepended to every inbound user message, returning just the human text.
 */
function stripMetaTag(text: string): string {
  return text.replace(/^\s*<(?:sender|event)\b[^>]*\/>\s*/, '').trim()
}

export interface HistoryQuery {
  /** Query a specific physical session segment (bypasses logical chain). */
  physicalId?: string
  /** Pagination offset. */
  offset?: number
  /** Page size. */
  pageSize?: number
  /** Cap on messages returned (default: 2000). */
  maxMessages?: number
  /** Skip parent/fork chain — return only the current physical segment. */
  shallow?: boolean
}

export interface HistoryResult {
  messages: ChatMessage[]
  /** Total count before pagination. */
  total: number
}

/**
 * Hard upper-bound on messages loaded per session (effectively unlimited).
 * Compaction (sleep/handoff) keeps real-world sessions well below this.
 */
const MAX_HISTORY = 2000

export interface SleepConfig {
  inactivityMs?: number
}

export interface SessionManagerDeps {
  workspace: string
  store: SessionStore
  handoffManager: HandoffManager
  // ── Active session deps ──
  bus: Bus
  provider: LLMProvider
  tools: Tools
  identity: IdentityManager
  context: ContextBuilder
  quickModel?: string
  defaultExecShell?: ExecShell
  honoApp?: Hono
  backgroundTasks: BackgroundTaskManager
  agentTypes: AgentTypesManager
  events: EventService
  workdirCapabilityLookup?: WorkdirCapabilityLookup
  remoteExecutor?: Executor
  getLlmRuntimeConfig?: () => LlmRuntimeConfig
  /** Called when a session stops (idle timeout, crash, or explicit stop). */
  onSessionStopped?: (sessionId: string) => void
  sleep?: SleepConfig
}

export interface StartSessionOptions {
  /** Agent type name (e.g. 'reflector', 'general'). Required. */
  agentType: string
  /** The task/message content to send to the session. */
  task: string
  /** Channel name. Defaults to 'heartbeat'. */
  channel?: string
  /** Chat ID. Auto-generated if omitted. */
  chatId?: string
  /** Model override for this session. */
  model?: string
  /** Additional context appended to the task. */
  context?: string
}

/**
 * Session + handoff persistence manager.
 *
 * Delegates all storage I/O to a {@link SessionStore} implementation (JSONL,
 * SQLite, etc.), while owning caching, tool-pair sanitization, handoff
 * orchestration, and the registry of active {@link Session} instances.
 */
/** Extract the system prompt string from the first message in a history. */
function extractSystemPrompt(msg: ChatMessage | undefined): string {
  if (msg?.role !== 'system') return ''
  return typeof msg.content === 'string' ? msg.content : ''
}

export function sessionPromptLocality(
  state: Pick<SessionState, 'workspaceRoot' | 'workdir'> | undefined,
): Pick<SessionPromptContext, 'workspaceRoot' | 'workdir'> {
  return {
    workspaceRoot: state?.workspaceRoot,
    workdir: state?.workdir,
  }
}

export class SessionManager {
  /** Registry of active per-session event loops. */
  private sessions: Record<string, Session | EphemeralSession> = {}
  private preparations = new Map<string, Promise<unknown>>()
  private acceptedInputs = new Set<string>()
  private stopped = false
  private stopPromise?: Promise<void>
  private reportSubscription?: string
  private sessionStates: Record<string, SessionState> = {}
  private readonly sleepInactivityMs: number

  /** Derive the current physical session ID from state. */
  static currentPhysicalId(state: SessionState): string {
    return newPhysicalSessionId(state.sessionId, state.segmentIndex)
  }

  constructor(
    private readonly deps: SessionManagerDeps,
  ) {
    this.sleepInactivityMs = deps.sleep?.inactivityMs ?? 15 * 60 * 1_000
  }

  get workspace(): string {
    return this.deps.workspace
  }
  get workdirCapabilityLookup(): WorkdirCapabilityLookup | undefined {
    return this.deps.workdirCapabilityLookup
  }
  get remoteExecutor(): Executor | undefined {
    return this.deps.remoteExecutor
  }
  private get store(): SessionStore {
    return this.deps.store
  }

  /**
   * Hot-swap the LLM provider and defaults at runtime (e.g. after config PATCH).
   * Provider changes affect new sessions; LLM defaults are supplied per
   * message, so active sessions use the latest defaults on their next turn.
   */
  updateProvider(provider: LLMProvider, quickModel?: string): void {
    this.deps.provider = provider
    this.deps.quickModel = quickModel
    console.info('[session-manager] Provider hot-swapped')
  }

  /**
   * Returns true if the given session's agent type is ephemeral.
   * Used by MessageTool to block follow-up messages to ephemeral sessions.
   */
  isEphemeralSession(sessionId: string): boolean {
    const state = this.sessionStates[sessionId]
    if (!state?.agentType) return false
    const agentType = this.deps.agentTypes.resolve(state.agentType)
    return agentType?.ephemeral ?? false
  }

  /**
   * Message-tool follow-ups are disallowed for ephemeral sessions, but their
   * fresh prototypes still need an initial task. Call synchronously immediately
   * before deliver; its preparation barrier reserves a pending first admission.
   * This restriction does not apply to direct event delivery.
   */
  canReceiveSessionMessage(sessionId: string): boolean {
    if (!this.isEphemeralSession(sessionId)) return true
    const state = this.sessionStates[sessionId]
    return !this.acceptedInputs.has(sessionId) &&
      !this.preparations.has(sessionId) &&
      !state?.lastActivityAt &&
      !(state?.segmentIndex > 0)
  }

  // ── Lifecycle (start / stop / dispatch / recovery) ──────────────────

  async start(): Promise<void> {
    if (this.stopPromise) await this.stopPromise
    this.stopPromise = undefined
    this.stopped = false
    // Load all session states into memory cache
    this.sessionStates = await this.store.listAllStates()
    // Older states may omit activity timestamps. Their own stored messages
    // distinguish an already-used ephemeral session from a fresh prototype.
    for (const state of Object.values(this.sessionStates)) {
      if (!this.isEphemeralSession(state.sessionId) || state.lastActivityAt || state.segmentIndex > 0) continue
      for await (const record of this.store.readSessionLog(SessionManager.currentPhysicalId(state))) {
        if ((typeof record.role === 'string' && record.role !== 'system') || record.session_recovered) {
          this.acceptedInputs.add(state.sessionId)
          break
        }
      }
    }

    if (this.reportSubscription) this.deps.bus.off(this.reportSubscription)
    this.reportSubscription = this.deps.bus.on('session.turn.finished', async (fact) => {
      if (fact.status === 'cancelled') return
      const state = this.sessionStates[fact.sessionId]
      if (!state?.reportTo || state.reportTo === fact.sessionId) return
      const content = (fact.status === 'failed' ? fact.error : fact.content)?.trim()
      if (!content && fact.status === 'completed') return

      await this.deps.events.emit({
        type: fact.status === 'failed' ? 'subagent-failed' : 'subagent-complete',
        source: 'subagent',
        targetSessionId: state.reportTo,
        senderName: 'Subagent',
        content: content ?? 'Subagent request failed',
        origin: {
          sessionId: fact.sessionId,
          inputId: fact.inputId,
          source: { kind: 'session', sessionId: fact.sessionId },
        },
        meta: {
          kind: 'subagent',
          sourceSessionId: fact.sessionId,
          agentType: state.agentType,
        },
      })
    })
  }

  /** Stops admissions immediately; resolves after active work and preparation quiesce. */
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    this.stopped = true
    if (this.reportSubscription) this.deps.bus.off(this.reportSubscription)
    this.reportSubscription = undefined
    const sessions = new Set(Object.values(this.sessions))
    const errors: unknown[] = []
    const stopSession = (session: Session | EphemeralSession) => {
      try { session.stop() } catch (error) { errors.push(error) }
    }
    this.stopPromise = Promise.resolve().then(async () => {
      // Admission errors belong to their deliver callers. Wait for them rather
      // than allowing an in-flight preparation to outlive shutdown.
      await Promise.allSettled(this.preparations.values())
      for (const session of Object.values(this.sessions)) {
        if (sessions.has(session)) continue
        sessions.add(session)
        stopSession(session)
      }
      const completed = await Promise.allSettled([...sessions].map((session) => session.completion))
      for (const result of completed) {
        if (result.status === 'rejected') errors.push(result.reason)
      }
      if (errors.length) throw new AggregateError(errors, 'Session shutdown failed')
    })
    for (const session of sessions) stopSession(session)
    return this.stopPromise
  }

  /**
   * Legacy channel adapter. Directed internal producers use deliver instead.
   */
  async dispatch(msg: InboundMessage, llm: LlmRuntimeConfig): Promise<void> {
    await this.deliver(deriveSessionId(msg), channelMessageInput(msg), llm)
  }

  /** Resolves after preparation and admission, never after model completion. */
  deliver(sessionId: string, input: SessionInput, llm?: LlmRuntimeConfig): Promise<DeliveryReceipt> {
    if (this.stopped) return Promise.reject(new Error('Session manager stopped'))
    const previous = this.preparations.get(sessionId) ?? Promise.resolve()
    const admission = previous.catch(() => {}).then(async (): Promise<DeliveryReceipt> => {
      if (this.stopped) throw new Error('Session manager stopped')
      const config = llm ?? this.deps.getLlmRuntimeConfig?.()
      if (!config) throw new Error('Session delivery requires LLM runtime configuration')
      let session: Session | EphemeralSession | undefined = this.sessions[sessionId]
      if (session && !session.accepting) {
        await session.completion
        session = undefined
      }
      const created = !session
      if (!session) session = await this.createActiveSession(sessionId, input)
      if (this.stopped) {
        session.stop()
        throw new Error('Session manager stopped')
      }
      try {
        session.dispatch(input, config)
      } catch (error) {
        if (created) session.stop()
        throw error
      }
      this.acceptedInputs.add(sessionId)
      this.deps.bus.emit('session.input.accepted', { sessionId, input })
      return { status: 'accepted', sessionId, inputId: input.id }
    })
    this.preparations.set(sessionId, admission)
    const clean = () => {
      if (this.preparations.get(sessionId) === admission) this.preparations.delete(sessionId)
    }
    void admission.then(clean, clean)
    return admission
  }

  private async createActiveSession(sessionId: string, input: SessionInput): Promise<Session | EphemeralSession> {
    const ctx = await this.prepareSessionContext(input, sessionId)
    if (this.stopped) throw new Error('Session manager stopped')
    const onStopped = (id: string) => {
      delete this.sessions[id]
      this.deps.bus.emit('session.ended', { sessionId: id, agentType: ctx.state.agentType })
      this.deps.onSessionStopped?.(id)
    }

    if (ctx.resolvedAgentType.ephemeral) {
      const sess = new EphemeralSession(
        this.deps.workspace,
        sessionId,
        ctx.state,
        ctx.messages,
        this.deps.provider,
        ctx.sessionTools,
        this.deps.bus,
        this.deps.store,
        this.deps.workdirCapabilityLookup,
        this.deps.remoteExecutor,
      )
      sess.onStopped = onStopped
      this.sessions[sessionId] = sess
      return sess
    } else {
      const sess = new Session(
        this.deps.workspace,
        sessionId,
        ctx.state,
        ctx.messages,
        this.deps.provider,
        ctx.sessionTools,
        this.deps.bus,
        this.deps.store,
        this.deps.handoffManager,
        onStopped,
        () => this.deps.context.buildSystemPrompt(ctx.promptCtx),
        this.deps.quickModel,
        this.sleepInactivityMs,
        this.deps.workdirCapabilityLookup,
        this.deps.remoteExecutor,
      )
      this.sessions[sessionId] = sess
      return sess
    }
  }

  /**
   * Recover sessions that were interrupted by a process restart.
   *
   * Scans all persisted sessions. For each whose last stored record
   * indicates an incomplete turn (user message without response, or
   * mid-tool-cycle), delivers a recovery event so the session resumes processing.
   *
   * Subagent sessions (those with `report_to` in their start event) are
   * reported through the domain turn-finished listener registered by start().
   *
   * @param maxAgeMs  Only recover sessions active within this window
   *                  (default: 30 minutes). Older sessions are considered
   *                  stale and skipped.
   */
  async recoverIncompleteSessions(maxAgeMs = 30 * 60_000): Promise<void> {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString()

    const allStates = Object.values(this.sessionStates)

    let recovered = 0
    for (const state of allStates) {
      // Skip stale sessions
      if (!state.lastActivityAt || state.lastActivityAt < cutoff) continue

      try {
        // Iterate the log to find the last record's role and detect prior recovery
        let lastRole: string | undefined
        let lastHasToolCalls = false
        let alreadyRecovered = false
        for await (
          const record of this.store.readSessionLog(
            SessionManager.currentPhysicalId(state),
          )
        ) {
          if (record.session_recovered) {
            alreadyRecovered = true
            break
          }
          if (typeof record.role === 'string') {
            lastRole = record.role as string
            lastHasToolCalls = Array.isArray(record.tool_calls) &&
              (record.tool_calls as unknown[]).length > 0
          }
        }

        if (alreadyRecovered) continue

        // A session is "complete" if its last record is an assistant message
        // with no tool calls (i.e. a final response).
        const isComplete = lastRole === 'assistant' && !lastHasToolCalls
        if (isComplete) continue

        // Session was interrupted — resume it.
        // report_to routing is handled persistently by the bus listener
        // in start(), so no re-registration needed on recovery.

        console.info(
          `[recovery] Resuming interrupted session ${state.sessionId}`,
        )
        // Legacy records do not retain input IDs; do not invent an origin for
        // the interrupted turn. The new recovery event receives its own ID.
        await this.deps.events.emit({
          type: 'session-recovery',
          source: 'system',
          targetSessionId: state.sessionId,
          senderName: 'System',
          content:
            'The previous request was interrupted by a system restart. Continue from where you left off.',
          meta: { reason: 'process-restart' },
        })
        await this.store.appendRawEvents(
          SessionManager.currentPhysicalId(state),
          [{
            session_recovered: true,
            timestamp: new Date().toISOString(),
          }],
        )
        recovered++
      } catch (err) {
        console.warn(
          `[recovery] Error recovering session ${state.sessionId}:`,
          errMsg(err),
        )
      }
    }

    if (recovered > 0) {
      console.info(`[recovery] Resumed ${recovered} interrupted session(s)`)
    }
  }

  // ── Session creation ───────────────────────────────────────────────

  /**
   * Create a new SessionState with the given prototype data.
   * Throws if the session already exists — callers must check first.
   */
  async buildSession(
    sessionId: string,
    parent?: SessionParent,
    stateFields?: {
      model?: string
      agentType?: string
      projectName?: string
      projectId?: string
      reportTo?: string
      originUser?: string
      description?: string
      preloadTools?: Record<string, string[]>
      workspaceRoot?: string
      workdir?: WorkdirRefV1
    },
  ): Promise<void> {
    const existing = this.sessionStates[sessionId]
    if (existing) {
      throw new TypeError(
        `[session-manager] buildSession called for existing session "${sessionId}"`,
      )
    }

    const agent = this.deps.agentTypes.resolve(
      stateFields?.agentType ?? 'general',
    )
    if (!agent) {
      throw new TypeError(
        `[session-manager] buildSession: unknown agent type "${stateFields?.agentType}"`,
      )
    }

    const ts = new Date().toISOString()
    const physicalSessionId = newPhysicalSessionId(sessionId, 0)

    const startEvent: SessionStartEvent = {
      previous_physical_id: null,
      timestamp: ts,
    }

    await this.store.createSessionLog(physicalSessionId, [startEvent])

    const config: SessionConfig = {
      model: agent?.model,
      temperature: agent?.temperature,
      maxTokens: agent?.maxTokens,
      thinking: agent?.thinking,
      reasoningEffort: agent?.reasoningEffort,
    }

    const parentState = parent ? this.sessionStates[parent.id] : undefined
    const parentWorkdir = parentState?.workdir
    const inheritedWorkdir = parentWorkdir &&
        !(parentWorkdir.nodeId === LOCAL_NODE_ID &&
          parentWorkdir.capabilityId.startsWith('managed-session-v1:'))
      ? parentWorkdir
      : undefined
    const state: SessionState = {
      sessionId,
      segmentIndex: 0,
      config,
      parent,
      workspaceRoot: stateFields?.workspaceRoot,
      workdir: stateFields?.workdir ?? inheritedWorkdir,
      agentType: stateFields?.agentType,
      projectName: stateFields?.projectName,
      projectId: stateFields?.projectId ?? parentState?.projectId,
      reportTo: stateFields?.reportTo,
      originUser: stateFields?.originUser,
      description: stateFields?.description,
      preloadTools: stateFields?.preloadTools,
    }

    await this.saveState(sessionId, state)
  }

  /**
   * Start a standalone session with a specific agent type.
   * Fire-and-forget — no parent tracking or completion callbacks.
   * @returns sessionId, or null if the agent type is unknown.
   */
  async startSession(opts: StartSessionOptions): Promise<string | null> {
    if (this.stopped) throw new Error('Session manager stopped')
    const agentType = this.deps.agentTypes.resolve(opts.agentType)
    if (!agentType) {
      console.error(`[session-manager] Unknown agent type "${opts.agentType}"`)
      return null
    }

    const channel = opts.channel ?? 'heartbeat'
    const chatId = opts.chatId ??
      `${opts.agentType}-${Date.now()}`
    const sessionId = `${channel}:${chatId}`

    // Create prototype and state so dispatch() picks up the agent type
    await this.buildSession(
      sessionId,
      undefined,
      { agentType: opts.agentType, model: opts.model },
    )

    // Build message content
    const content = opts.context
      ? `${opts.task}\n\nAdditional context:\n${opts.context}`
      : opts.task

    const eventId = crypto.randomUUID()
    await this.deliver(sessionId, {
      id: eventId,
      kind: 'message',
      source: {
        kind: 'event',
        eventId,
        type: 'agent-start',
        source: 'system',
        origin: {
          sessionId,
          inputId: eventId,
          source: { kind: 'session', sessionId },
        },
      },
      policy: 'queue',
      replyTo: { channel, chatId },
      content,
      timestamp: new Date().toISOString(),
    })

    console.info(
      `[session-manager] Started session ${sessionId} (${opts.agentType})`,
    )
    return sessionId
  }

  // ── Child session tracking (persisted on parent state) ─────────────

  /**
   * Record a child session ID on the parent session state.
   * Only call for non-ephemeral parents — ephemeral sessions skip persistence.
   */
  async addChild(
    parentSessionId: string,
    childSessionId: string,
  ): Promise<void> {
    const state = this.sessionStates[parentSessionId]
    if (!state) return
    const children = state.children ?? []
    if (!children.includes(childSessionId)) {
      children.push(childSessionId)
      state.children = children
      await this.saveState(parentSessionId, state)
    }
  }

  /**
   * Get child session info for a parent session, resolving details
   * from each child's persisted state. Works even when parent is sleeping.
   */
  async getChildren(parentSessionId: string): Promise<
    Array<{
      sessionId: string
      agentType: string
      description: string
    }>
  > {
    const state = this.sessionStates[parentSessionId]
    if (!state?.children?.length) return []

    const results: Array<
      { sessionId: string; agentType: string; description: string }
    > = []
    for (const childId of state.children) {
      const childState = this.sessionStates[childId]
      if (!childState) continue
      results.push({
        sessionId: childId,
        agentType: childState.agentType ?? 'sub',
        description: childState.description ?? '',
      })
    }
    return results
  }

  // ── Session config ─────────────────────────────────────────────────

  getSessionConfig(sessionId: string): SessionConfig {
    const state = this.sessionStates[sessionId]
    return state?.config ?? {}
  }

  async setSessionConfig(
    sessionId: string,
    patch: Partial<SessionConfig>,
  ): Promise<void> {
    const state = this.sessionStates[sessionId]
    if (!state) return
    state.config = { ...state.config, ...patch }
    await this.saveState(sessionId, state)
  }

  async unsetSessionConfig(
    sessionId: string,
    key: keyof SessionConfig,
  ): Promise<void> {
    const state = this.sessionStates[sessionId]
    if (!state?.config) return
    const next = { ...state.config }
    delete next[key]
    state.config = Object.keys(next).length > 0 ? next : undefined
    await this.saveState(sessionId, state)
  }

  async resetSessionConfig(sessionId: string): Promise<void> {
    const state = this.sessionStates[sessionId]
    if (!state?.config) return
    state.config = undefined
    await this.saveState(sessionId, state)
  }

  // ── Deletion ──────────────────────────────────────────────────────

  /**
   * Delete a session: stop it if active, remove all physical segment logs,
   * delete its state, and cascade-delete all child sessions.
   *
   * @returns The list of session IDs that were deleted.
   */
  async deleteSession(sessionId: string): Promise<string[]> {
    const deleted: string[] = []
    await this._deleteSessionRecursive(sessionId, deleted)
    return deleted
  }

  private async _deleteSessionRecursive(
    sessionId: string,
    deleted: string[],
  ): Promise<void> {
    const state = this.sessionStates[sessionId]
    if (!state) return

    // Cascade: delete children first
    if (state.children?.length) {
      for (const childId of [...state.children]) {
        await this._deleteSessionRecursive(childId, deleted)
      }
    }

    // Stop active session if running
    const active = this.sessions[sessionId]
    if (active) {
      active.stop()
      delete this.sessions[sessionId]
    }

    // Delete all physical segment logs (segment 0 through segmentIndex)
    for (let i = 0; i <= state.segmentIndex; i++) {
      try {
        await this.store.deleteSessionLog(newPhysicalSessionId(sessionId, i))
      } catch { /* segment may not exist */ }
    }

    // Delete persisted state
    try {
      await this.store.deleteState(sessionId)
    } catch { /* ignore */ }

    // Remove from in-memory cache
    delete this.sessionStates[sessionId]
    this.acceptedInputs.delete(sessionId)

    deleted.push(sessionId)
  }

  // ── Queries (state, history, tools, context) ───────────────────────

  getSessionState(sessionId: string): SessionState | null {
    return this.sessionStates[sessionId] ?? null
  }

  getActiveSession(sessionId: string): Session | EphemeralSession | undefined {
    return this.sessions[sessionId]
  }

  requestCompact(sessionId: string, llm: LlmRuntimeConfig): boolean {
    const sess = this.sessions[sessionId]
    if (!(sess instanceof Session) || !sess.accepting) return false
    sess.dispatch({
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      source: { kind: 'session', sessionId },
      kind: 'control',
      command: { type: 'compact' },
    }, llm)
    return true
  }

  /** Read the first record of a physical session log (e.g. the start event). */
  readFirstRecord(physicalId: string): Promise<Record<string, unknown> | null> {
    return this.store.readFirstRecord(physicalId)
  }

  listSessions(): Array<
    { sessionId: string; segmentIndex: number; lastActivityAt?: string; projectId?: string }
  > {
    return Object.values(this.sessionStates).map((s) => ({
      sessionId: s.sessionId,
      segmentIndex: s.segmentIndex,
      lastActivityAt: s.lastActivityAt,
      projectId: s.projectId,
    }))
  }

  /** Get the first user message content for a session (used as title). */
  async getFirstUserMessage(sessionId: string): Promise<string | null> {
    const state = this.sessionStates[sessionId]
    if (!state) return null
    const physicalId = newPhysicalSessionId(sessionId, 0)
    for await (const parsed of this.store.readSessionLog(physicalId)) {
      if (parsed.role === 'user' && parsed.name !== '__compaction_summary__') {
        const content = parsed.content
        if (typeof content === 'string') {
          const text = stripMetaTag(content)
          return text || null
        }
        if (Array.isArray(content)) {
          for (const p of content as Array<{ type: string; text?: string }>) {
            if (p.type !== 'text' || !p.text) continue
            const text = stripMetaTag(p.text)
            if (text) return text
          }
        }
        return null
      }
    }
    return null
  }

  listActiveSessions(): Array<{ sessionId: string; lastActivityAt?: string }> {
    return Object.keys(this.sessions).sort().map((sessionId) => ({
      sessionId,
      lastActivityAt: this.getSessionState(sessionId)?.lastActivityAt,
    }))
  }

  /**
   * Get conversation history for a session.
   *
   * Covers logical sessions (full handoff chain), physical segments,
   * shallow (current segment only), and pagination — all via options.
   */
  @Span('session.getHistory')
  async getHistory(
    sessionId: string,
    query?: HistoryQuery,
  ): Promise<HistoryResult> {
    trace.getActiveSpan()?.setAttributes({ sessionId })

    const { physicalId, offset, pageSize, maxMessages = MAX_HISTORY, shallow } =
      query ?? {}
    let messages: ChatMessage[]

    if (physicalId) {
      // Physical segment — parse that single segment, no chain traversal
      const raw = await this.parseSessionLog(physicalId)
      messages = sanitizeToolPairs(raw)
    } else if (shallow) {
      // Shallow — current physical segment only (no parent/fork chain)
      const state = this.sessionStates[sessionId]
      if (!state) return { messages: [], total: 0 }
      const raw = await this.parseSessionLog(
        SessionManager.currentPhysicalId(state),
      )
      messages = sanitizeToolPairs(raw)
    } else {
      // Full logical chain (with active session fast path)
      const sess = this.getActiveSession(sessionId)
      if (sess) {
        messages = truncatePreservingToolPairs(sess.history, maxMessages)
      } else {
        const state = this.sessionStates[sessionId]
        if (!state) return { messages: [], total: 0 }
        const forkInfo = state.parent?.physicalId && state.parent.index
          ? {
            parentPhysicalId: state.parent.physicalId,
            forkAt: state.parent.index,
          }
          : undefined
        const raw = await this.parseSessionLog(
          SessionManager.currentPhysicalId(state),
          undefined,
          forkInfo,
        )
        const sanitized = sanitizeToolPairs(raw)
        messages = truncatePreservingToolPairs(sanitized, maxMessages)
      }
    }

    const total = messages.length
    if (offset != null && pageSize != null) {
      const start = offset < 0 ? Math.max(0, total + offset) : offset
      return { messages: messages.slice(start, start + pageSize), total }
    }
    return { messages, total }
  }

  /** Return tool metadata (name, description, parameters) for a session. */
  getToolDefinitions(
    sessionId?: string,
    behaviorOverride?: { allowedTools?: string[]; blockedTools?: string[] },
  ): Array<{ name: string; description: string; parameters: unknown }> {
    if (sessionId) {
      const sess = this.sessions[sessionId]
      if (sess && !behaviorOverride) {
        return sess.getTools().sort((a, b) =>
          a.function.name.localeCompare(b.function.name)
        )
          .map((tool) => tool.function)
      }
    }

    // For inactive / historical sessions, filter using behavior
    const allDefs = this.deps.tools.getDefinitions()
    const filtered = allDefs.filter((d) =>
      isToolAllowed(behaviorOverride ?? {}, d.function.name, d.optIn)
    )

    return filtered.map((d) => ({
      name: d.function.name,
      description: d.function.description,
      parameters: d.function.parameters,
    }))
  }

  async getContext(
    opts: {
      sessionId?: string
      agentType?: string
      channel?: string
      chatId?: string
    },
  ): Promise<{
    systemPrompt: string
    tools: Array<{ name: string; description: string; parameters: unknown }>
  }> {
    let sessionId: string
    let channel: string
    let chatId: string
    if (opts.sessionId) {
      sessionId = opts.sessionId
      const colonIdx = sessionId.indexOf(':')
      channel = colonIdx >= 0 ? sessionId.slice(0, colonIdx) : sessionId
      chatId = colonIdx >= 0 ? sessionId.slice(colonIdx + 1) : 'direct'
    } else {
      channel = opts.channel ?? 'heartbeat'
      chatId = opts.chatId ?? 'heartbeat'
      sessionId = `${channel}:${chatId}`
    }

    const active = this.getActiveSession(sessionId)
    if (active) {
      return {
        systemPrompt: extractSystemPrompt(active.history[0]),
        tools: this.getToolDefinitions(sessionId),
      }
    }

    const state = this.sessionStates[sessionId]
    const behavior = state?.config ?? {}
    const agentTypeName = opts.agentType ?? state?.agentType ?? 'general'
    const agentType = this.deps.agentTypes.resolve(agentTypeName)
    if (!agentType) {
      throw new TypeError(
        `[session-manager] getContext: unknown agent type "${agentTypeName}"`,
      )
    }

    const promptCtx: SessionPromptContext = {
      behavior,
      channel,
      chatId,
      sessionId,
      defaultExecShell: behavior.defaultShell ?? this.deps.defaultExecShell,
      agent: agentType,
      projectName: state?.projectName,
      ...sessionPromptLocality(state),
    }

    const systemPrompt = await this.deps.context.buildSystemPrompt(promptCtx)
    const { allowedTools, blockedTools } = this.resolveAgentTypeTools(
      agentTypeName,
    )
    const tools = this.getToolDefinitions(sessionId, {
      allowedTools,
      blockedTools,
    })

    return { systemPrompt, tools }
  }

  // ── Private helpers ────────────────────────────────────────────────

  private resolveAgentTypeTools(agentTypeName?: string): {
    agentType: AgentTypeDefinition
    allowedTools?: string[]
    blockedTools?: string[]
  } {
    const name = agentTypeName ?? 'general'
    const resolved = this.deps.agentTypes.resolve(name) ??
      this.deps.agentTypes.resolve('general')!

    if (resolved.allowedTools?.length) {
      return { agentType: resolved, allowedTools: resolved.allowedTools }
    }

    let blockedTools: string[] | undefined
    if (resolved.blockedTools?.length) {
      blockedTools = [...resolved.blockedTools]
    }
    return {
      agentType: resolved,
      blockedTools: blockedTools?.length ? blockedTools : undefined,
    }
  }

  private async saveState(
    sessionId: string,
    state: SessionState,
  ): Promise<void> {
    this.sessionStates[sessionId] = state
    await this.store.saveState(sessionId, state)
  }

  private async getOrCreateState(
    sessionId: string,
  ): Promise<SessionState> {
    const existing = this.sessionStates[sessionId]
    if (existing) return existing

    const ts = new Date().toISOString()
    const physicalSessionId = newPhysicalSessionId(sessionId, 0)
    const startEvent: SessionStartEvent = {
      previous_physical_id: null,
      timestamp: ts,
    }

    await this.store.createSessionLog(physicalSessionId, [startEvent])

    const state: SessionState = {
      sessionId,
      segmentIndex: 0,
    }
    await this.saveState(sessionId, state)

    return state
  }

  private async prepareSessionContext(input: SessionInput, sessionId: string) {
    const msg = inputContext(sessionId, input)
    const state = this.sessionStates[sessionId] ??
      await this.getOrCreateState(sessionId)
    const behavior = state.config ?? {}

    const { agentType: resolvedAgentType, allowedTools, blockedTools } = this
      .resolveAgentTypeTools(state.agentType)

    const promptCtx: SessionPromptContext = {
      behavior,
      channel: msg.channel,
      chatId: msg.chatId,
      sessionId,
      chatName: msg.chatName,
      senderId: msg.senderId,
      senderName: msg.senderName ?? msg.senderId,
      inputSource: input.source.kind,
      isGroup: msg.isGroup,
      admin: msg.admin,
      defaultExecShell: behavior.defaultShell ?? this.deps.defaultExecShell,
      agent: resolvedAgentType,
      projectName: state.projectName,
      ...sessionPromptLocality(state),
    }
    const systemPrompt = await this.deps.context.buildSystemPrompt(promptCtx)

    const { messages: history } = await this.getHistory(sessionId)

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...history,
    ]

    const sessionTools = new SessionTools(
      this.deps.tools,
      this.deps.workspace,
      allowedTools,
      blockedTools,
    )

    // Import tools specified by parent (e.g., subagent preload_tools param)
    if (state.preloadTools && Object.keys(state.preloadTools).length > 0) {
      for (const [toolName, toolArgs] of Object.entries(state.preloadTools)) {
        try {
          const importTool = sessionTools.get('import_tool') as ImportTool
          if (importTool) {
            await importTool.importSource({
              source: `v:tools/${toolName}`,
              args: toolArgs,
            }, sessionTools)
            console.info(
              `[session-manager] Preloaded tool "${toolName}" for session ${sessionId}`,
            )
          }
        } catch (err) {
          console.warn(
            `[session-manager] Failed to preload tool "${toolName}" for session ${sessionId}:`,
            errMsg(err),
          )
        }
      }
    }

    return {
      behavior,
      state,
      messages,
      sessionTools,
      resolvedAgentType,
      allowedTools,
      blockedTools,
      promptCtx,
    }
  }

  /**
   * Parse raw session log records into ChatMessages.
   *
   * When `forkInfo` is provided (from SessionState.parent), the method
   * recursively reads the parent session log up to the fork index and
   * prepends those messages — giving the forked session full inherited
   * context without duplicating it in storage.
   *
   * @param maxRecords  Optional upper-bound on raw records to read from this
   *                    session log (used internally during recursive parent reads).
   * @param forkInfo    Fork metadata from SessionState.parent. When provided,
   *                    parent context is prepended to this session's messages.
   */
  private async parseSessionLog(
    physicalSessionId: string,
    maxRecords?: number,
    forkInfo?: { parentPhysicalId: string; forkAt: number },
  ): Promise<ChatMessage[]> {
    const messages: ChatMessage[] = []
    let recordIndex = 0

    for await (const parsed of this.store.readSessionLog(physicalSessionId)) {
      if (maxRecords != null && recordIndex >= maxRecords) break
      recordIndex++

      try {
        const isMessage = typeof parsed.role === 'string'
        // Detect init context: summary_context on a start event (compacted session)
        const isSessionInit = typeof parsed.summary_context === 'string' &&
          typeof parsed.next_session_id !== 'string'

        if (isSessionInit) {
          messages.push({
            role: 'user',
            content: String(parsed.summary_context ?? ''),
            name: '__compaction_summary__',
          })
          continue
        }

        if (isMessage) {
          const event = parsed as unknown as ChatMessage
          const msg: ChatMessage = {
            role: event.role,
            content: event.content,
            reasoning_content: event.reasoning_content,
            reasoning_text: event.reasoning_text,
            provider_state: event.role === 'assistant'
              ? event.provider_state
              : undefined,
            tool_calls: event.tool_calls as ChatMessage['tool_calls'],
            tool_call_id: event.tool_call_id,
            name: event.name,
          }
          if (event.role === 'assistant' && (parsed as any).usage) {
            msg.usage = (parsed as any).usage
          }
          if ((parsed as any).timestamp) {
            msg.timestamp = (parsed as any).timestamp
          }
          messages.push(msg)
          continue
        }
      } catch { /* skip malformed */ }
    }

    // Fork: recursively load ancestor context up to the fork point
    if (forkInfo) {
      try {
        const parentLimit = forkInfo.forkAt != null
          ? forkInfo.forkAt + 1
          : undefined
        const parentMessages = await this.parseSessionLog(
          forkInfo.parentPhysicalId,
          parentLimit,
        )
        return [...parentMessages, ...messages]
      } catch {
        // Parent session may have been deleted — continue with local messages only
      }
    }

    return messages
  }
}
