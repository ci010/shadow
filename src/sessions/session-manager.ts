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
import type { OrganizationScope } from '../otel/scope.ts'
import { channelAddressFromSessionId, deriveSessionId, type InboundMessage } from '../bus/events.ts'
import type { HandoffManager } from '../handoff/manager.ts'
import type { ChatMessage, LLMProvider, LLMResponseUsage } from '../providers/provider.ts'
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
import { LOCAL_NODE_ID, resolveSessionLocations, type WorkdirCapabilityLookup, type WorkdirRefV1 } from './locality.ts'
import type { NodeInventoryResponse } from '../cluster/node-inventory.ts'
import { isConfigObject, type SessionConfigPatch } from './config-patch.ts'
import type { Executor } from '../execution/executor.ts'
import type {
  SessionConfig,
  SessionParent,
  SessionStartEvent,
  SessionState,
  SessionStore,
} from './session-store.ts'
import { Session } from './session.ts'
import { YieldError, YieldManager } from './yield.ts'
import { parseYieldPolicy, type YieldPolicy, type YieldRequest } from './yield-contract.ts'
import { allowedSubagentModes, isExecutionMode, type ExecutionMode } from './execution-mode.ts'
import { delegationOwner, MAX_CALL_TIMEOUT_MS } from './execution-scope.ts'
import { CallTools } from './call-tools.ts'
import type { ExecutionContext } from '../agent/agent.ts'
import type { ToolBridgeFactory } from '../eval/bridge.ts'
import {
  channelMessageInput,
  inputContext,
  type DeliveryReceipt,
  type SessionInput,
  type SessionTurnFact,
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
  organizationId?: string
  scope?: OrganizationScope
  evalBridge?: ToolBridgeFactory
  ownsProject?: (projectId: string) => boolean
  ownsWorkdir?: (workdir: WorkdirRefV1) => boolean
  assertSessionProject?: (state: SessionState) => void
  acquireProjectAccess?: () => () => void
  /** Host/test deadline override: integer 1–120000 ms; default 120000 ms. */
  callTimeoutMs?: number
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
  getNodeInventory?: () => NodeInventoryResponse
  remoteExecutor?: Executor
  getLlmRuntimeConfig?: () => LlmRuntimeConfig
  getYieldPolicy?: () => YieldPolicy
  deliverYield?: (message: import('../bus/events.ts').OutboundMessage) => Promise<void>
  getKnownContextWindow?: (model: string) => number | null
  /** Called when a session stops (idle timeout, crash, or explicit stop). */
  onSessionStopped?: (sessionId: string) => void
  sleep?: SleepConfig
}

export interface StartSessionOptions {
  signal?: AbortSignal
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

interface BlockingCallFrame {
  callerId: string
  tools: CallTools
  input?: SessionInput
  session?: EphemeralSession
  blockedReason?: string
  cancelled: boolean
}

export class SessionManager {
  readonly yields: YieldManager
  /** Registry of active per-session event loops. */
  private sessions: Record<string, Session | EphemeralSession> = {}
  private preparations = new Map<string, Promise<unknown>>()
  private acceptedInputs = new Set<string>()
  private stopped = false
  private stopPromise?: Promise<void>
  private reportSubscription?: string
  private sessionStates: Record<string, SessionState> = {}
  private readonly sleepInactivityMs: number
  private readonly executionAdmissions = new Map<string, Promise<string>>()
  private readonly reporting = new Map<string, Promise<void>>()
  private readonly completionEvents = new Map<string, { sourceId: string; targetId: string }>()
  private readonly deleting = new Set<string>()
  private readonly calls = new Map<string, BlockingCallFrame>()

  acquireProjectAccess(): () => void {
    return this.deps.acquireProjectAccess?.() ?? (() => {})
  }

  assertProjectAccess(sessionId: string): void {
    const visited = new Set<string>()
    const check = (id: string) => {
      if (visited.has(id)) return
      visited.add(id)
      const state = this.sessionStates[id]
      if (!state) return
      this.deps.assertSessionProject?.(state)
      for (const parent of [state.parent?.id, state.parentSessionId, state.workspaceRoot]) {
        if (parent) check(parent)
      }
    }
    check(sessionId)
  }

  get hasProjectWork(): boolean {
    return this.preparations.size > 0 || this.executionAdmissions.size > 0 ||
      this.reporting.size > 0 || this.calls.size > 0 ||
      Object.values(this.sessions).some(session => !(session instanceof Session) || !session.quiescent)
  }

  invalidateProjectSessions(): void {
    for (const [id, session] of Object.entries(this.sessions)) {
      try { this.assertProjectAccess(id) } catch { session.stop() }
    }
  }

  projectDependentSessions(projectId: string, workdirs: readonly WorkdirRefV1[]): string[] {
    const affected = new Set<string>()
    for (const [id, state] of Object.entries(this.sessionStates)) {
      if (state.projectId === projectId || state.workdir && workdirs.some(ref =>
        ref.nodeId === state.workdir!.nodeId && ref.capabilityId === state.workdir!.capabilityId)) affected.add(id)
    }
    let previous = -1
    while (previous !== affected.size) {
      previous = affected.size
      for (const [id, state] of Object.entries(this.sessionStates)) {
        if ([state.parent?.id, state.parentSessionId, state.workspaceRoot].some(parent => parent && affected.has(parent))) affected.add(id)
      }
    }
    return [...affected]
  }

  isWaitingForCall(sessionId: string): boolean {
    return [...this.calls.values()].some(frame => frame.callerId === sessionId)
  }

  getDelegationOwner(sessionId: string): string | undefined {
    return delegationOwner(this.sessionStates[sessionId])
  }

  getAllowedSubagentModes(sessionId: string): readonly ExecutionMode[] {
    const state = this.sessionStates[sessionId]
    return allowedSubagentModes(state?.mode ?? 'session', !!delegationOwner(state))
  }

  assertCanCreateChild(sessionId: string, mode: ExecutionMode): void {
    this.assertProjectAccess(sessionId)
    const state = this.sessionStates[sessionId]
    if (!state) throw new Error('Delegation requires an existing owner session.')
    if (state.mode === 'call') this.blockCall(sessionId, 'Leaf calls cannot create subagents.')
    if (state.mode === 'task' && ['completed', 'failed', 'cancelled'].includes(state.executionStatus ?? '')) {
      throw new Error('A terminal task cannot create more work.')
    }
    if (this.deleting.has(sessionId)) throw new Error('Delegation owner is being deleted.')
    if (!this.getAllowedSubagentModes(sessionId).includes(mode)) throw new Error(`Execution mode "${mode}" is not allowed from this session.`)
    const role = this.resolveAgentTypeTools(state.agentType)
    if (role.allowedTools?.length ? !role.allowedTools.includes('subagent') : role.blockedTools?.includes('subagent')) {
      throw new Error('The owner role does not permit subagent creation.')
    }
    const seen = new Set<string>()
    let current: string | undefined = sessionId
    while (current) {
      if (seen.has(current) || seen.size >= 32) throw new Error('Cyclic or excessively deep delegation lineage.')
      seen.add(current)
      current = delegationOwner(this.sessionStates[current])
    }
  }

  private blockCall(sessionId: string, reason: string): never {
    const frame = this.calls.get(sessionId)
    if (frame) {
      frame.blockedReason = reason
      this.sessions[sessionId]?.cancel()
    }
    throw new Error(`Blocked: ${reason} Partial work and side effects are not rolled back.`)
  }

  async startCall(sessionId: string, task: string, context: ExecutionContext): Promise<string> {
    if (this.deps.organizationId && context.organizationId !== this.deps.organizationId) throw new Error('Call context belongs to another organization')
    const state = this.sessionStates[sessionId]
    if (!state || state.mode !== 'call' || delegationOwner(state) !== context.sessionId) throw new Error('Call admission requires its actual owner.')
    try {
      this.assertCanCreateChild(context.sessionId, 'call')
      if (context.toolCallName && context.toolCallName !== 'subagent') {
        throw new Error('Blocking calls require native subagent invocation; a script bridge cannot guarantee the caller remains attached.')
      }
      context.signal.throwIfAborted()
    } catch (error) {
      state.executionStatus = context.signal.aborted ? 'cancelled' : 'failed'
      await this.saveState(sessionId, state)
      throw error
    }
    const role = this.resolveAgentTypeTools(state.agentType)
    const tools = new CallTools(context.tools, this.workspace, role.allowedTools, role.blockedTools)
    const frame: BlockingCallFrame = {
      callerId: context.sessionId, tools, cancelled: false,
    }
    this.calls.set(sessionId, frame)
    tools.setExecutionScope('call', [], reason => {
      frame.blockedReason = reason
      this.sessions[sessionId]?.cancel()
    })
    const cancel = () => { frame.cancelled = true; this.sessions[sessionId]?.cancel() }
    context.signal.addEventListener('abort', cancel, { once: true })
    const timer = setTimeout(() => {
      frame.blockedReason = 'Leaf call deadline exceeded; inspect its partial work before retrying.'
      cancel()
    }, this.deps.callTimeoutMs ?? MAX_CALL_TIMEOUT_MS)
    let snapshotLength = 0
    try {
      const history = this.getActiveSession(context.sessionId)?.history ?? (await this.getHistory(context.sessionId)).messages
      const snapshot = structuredClone(sanitizeToolPairs(sanitizeToolPairs(history))).filter(message => message.role !== 'system')
      snapshotLength = snapshot.length
      await this.store.appendMessages(SessionManager.currentPhysicalId(state),
        snapshot.map(message => ({ ...message, timestamp: message.timestamp ?? new Date().toISOString() })))
      context.signal.throwIfAborted()
      if (frame.cancelled) throw new Error(frame.blockedReason ?? 'Call cancelled before admission.')
      frame.input = {
        kind: 'message', id: crypto.randomUUID(), timestamp: new Date().toISOString(), policy: 'queue', content: task,
        source: { kind: 'session', sessionId: context.sessionId, inputId: context.messageId, senderName: context.senderName },
      }
      await this.deliver(sessionId, frame.input)
      const child = frame.session
      if (!child) throw new Error('Call session was not admitted.')
      if (context.signal.aborted || frame.cancelled) child.cancel()
      await child.completion
      const fact = child.result
      const ownHistory = child.history.slice(snapshotLength + 1)
      let declaredBlocked: { reason?: string; partialWork?: string } | undefined
      let declaredFailure: string | undefined
      try {
        const value = JSON.parse(fact?.content ?? '')
        if (value && value.status === 'blocked') declaredBlocked = {
          reason: typeof value.reason === 'string' ? value.reason : 'Caller input or permission is required.',
          partialWork: typeof value.partialWork === 'string' ? value.partialWork : undefined,
        }
        if (value && value.status === 'failed') declaredFailure = typeof value.error === 'string'
          ? value.error : 'Leaf call reported a failure.'
      } catch { /* Ordinary final text is valid. */ }
      if (!declaredBlocked && /^(?:\s|[#*])*(?:status:\s*)?(?:blocked\b|无法继续|受阻)/i.test(fact?.content ?? '')) {
        declaredBlocked = { reason: fact!.content.trim().split('\n')[0] }
      }
      if (!declaredFailure && /^(?:\s|[#*])*(?:status:\s*)?(?:failed\b|失败)/i.test(fact?.content ?? '')) {
        declaredFailure = fact!.content.trim().split('\n')[0]
      }
      const blockedReason = frame.blockedReason ?? declaredBlocked?.reason
      const status = frame.blockedReason || declaredBlocked ? 'blocked' : declaredFailure ? 'failed' : fact?.status ?? 'cancelled'
      const receipt = {
        sessionId, executionId: sessionId, mode: 'call', status,
        result: fact?.content ?? '',
        ...(blockedReason ? { blockedReason } : {}),
        ...(fact?.error || declaredFailure ? { error: fact?.error ?? declaredFailure } : {}),
        partialWork: status === 'completed' ? '' : declaredBlocked?.partialWork ?? ownHistory
          .filter(message => message.role === 'assistant' && typeof message.content === 'string')
          .at(-1)?.content ?? '',
        sideEffectsMayHaveOccurred: ownHistory.some(message => message.role === 'tool'),
      }
      state.executionStatus = status === 'blocked' ? 'failed' : status
      await this.store.appendRawEvents(SessionManager.currentPhysicalId(state), [{ call_result: receipt }])
      await this.saveState(sessionId, state)
      return JSON.stringify(receipt)
    } catch (error) {
      frame.session?.cancel()
      await frame.session?.completion
      const status = context.signal.aborted ? 'cancelled' : frame.blockedReason ? 'blocked' : 'failed'
      state.executionStatus = status === 'blocked' ? 'failed' : status
      const receipt = { sessionId, executionId: sessionId, mode: 'call', status,
        result: '', error: errMsg(error), partialWork: '', blockedReason: frame.blockedReason,
        sideEffectsMayHaveOccurred: !!frame.session }
      await this.store.appendRawEvents(SessionManager.currentPhysicalId(state), [{ call_result: receipt }])
      await this.saveState(sessionId, state)
      return JSON.stringify(receipt)
    } finally {
      clearTimeout(timer)
      context.signal.removeEventListener('abort', cancel)
      this.calls.delete(sessionId)
      tools.resetDynamic()
    }
  }

  executeOnce(key: string, operation: () => Promise<string>): Promise<string> {
    const existing = this.executionAdmissions.get(key)
    if (existing) return existing
    const work = Promise.resolve().then(async () => {
      const state = Object.values(this.sessionStates).find(state => state.executionKey === key)
      if (state) return this.executionReceipt(state.sessionId)
      return operation()
    })
    this.executionAdmissions.set(key, work)
    const cleanup = () => {
      if (this.executionAdmissions.get(key) === work) this.executionAdmissions.delete(key)
    }
    void work.then(cleanup, cleanup)
    return work
  }

  private async executionReceipt(sessionId: string): Promise<string> {
    const state = this.sessionStates[sessionId]
    if (state.mode === 'call') {
      let result: unknown
      for await (const record of this.store.readSessionLog(SessionManager.currentPhysicalId(state))) {
        if (record.call_result) result = record.call_result
      }
      return JSON.stringify(result ?? {
        sessionId, executionId: sessionId, mode: 'call', status: 'cancelled', result: '',
        error: 'Previous call interrupted; it will not be replayed.', sideEffectsMayHaveOccurred: true,
      })
    }
    return JSON.stringify({
      sessionId, executionId: state.executionId, mode: state.mode,
      status: state.executionStatus,
      message: 'Execution admitted. Its final result is delivered asynchronously.',
    })
  }

  canSendSessionMessage(sourceId: string, targetId: string): boolean {
    if (this.deps.organizationId && (!this.sessionStates[sourceId] || !this.sessionStates[targetId])) return false
    if (this.sessionStates[sourceId]?.mode === 'call') {
      try { this.blockCall(sourceId, 'Leaf calls cannot send messages.') } catch { return false }
    }
    return this.canReceiveSessionMessage(targetId)
  }

  async startChild(sessionId: string, task: string, context: ExecutionContext): Promise<DeliveryReceipt> {
    if (this.deps.organizationId && context.organizationId !== this.deps.organizationId) throw new Error('Child context belongs to another organization')
    const state = this.sessionStates[sessionId]
    if (delegationOwner(state) !== context.sessionId || !state) throw new Error('Child admission requires its actual owner.')
    this.assertCanCreateChild(context.sessionId, state.mode ?? 'session')
    if (state.mode === 'call') throw new Error('Leaf calls must use blocking admission.')
    const initialInput: SessionInput = {
      kind: 'message', id: crypto.randomUUID(), timestamp: new Date().toISOString(),
      source: { kind: 'session', sessionId: context.sessionId, inputId: context.messageId, senderName: context.senderName },
      policy: 'queue', content: task,
    }
    return this.deliver(sessionId, initialInput)
  }

  /** Derive the current physical session ID from state. */
  static currentPhysicalId(state: SessionState): string {
    return newPhysicalSessionId(state.sessionId, state.segmentIndex)
  }

  constructor(
    private readonly deps: SessionManagerDeps,
  ) {
    if (deps.scope && deps.scope.organizationId !== deps.organizationId) {
      throw new Error('Session manager organization scope mismatch')
    }
    if (deps.callTimeoutMs !== undefined && (!Number.isInteger(deps.callTimeoutMs)
      || deps.callTimeoutMs < 1 || deps.callTimeoutMs > MAX_CALL_TIMEOUT_MS)) {
      throw new RangeError(`callTimeoutMs must be between 1 and ${MAX_CALL_TIMEOUT_MS}.`)
    }
    this.sleepInactivityMs = deps.sleep?.inactivityMs ?? 15 * 60 * 1_000
    this.yields = new YieldManager({
      assertCanYield: id => {
        if (this.sessionStates[id]?.mode === 'call') this.blockCall(id, 'Leaf calls cannot yield; the caller must decide and issue a new call.')
      },
      getState: id => this.getSessionState(id),
      getPolicy: id => this.getYieldPolicy(id),
      notifyUser: request => this.notifyYieldUser(request),
      notifyParent: request => this.notifyYieldParent(request),
    })
  }

  getYieldPolicy(sessionId: string): YieldPolicy {
    return parseYieldPolicy(this.getSessionConfig(sessionId).yield ?? this.deps.getYieldPolicy?.() ?? { timeoutMs: null })
  }

  private async notifyYieldUser(request: YieldRequest): Promise<void> {
    const separator = request.sessionId.indexOf(':')
    if (separator < 1 || request.sessionId.startsWith('web:')) return
    const channelAddress = channelAddressFromSessionId(request.sessionId)
    if (channelAddress && channelAddress.organizationId !== this.deps.organizationId) {
      throw new YieldError('forbidden', 'The question belongs to another organization.')
    }
    const message: import('../bus/events.ts').OutboundMessage = {
      event: 'response',
      channel: channelAddress?.platform ?? request.sessionId.slice(0, separator),
      chatId: channelAddress?.conversationId ?? request.sessionId.slice(separator + 1),
      ...(channelAddress ? { channelAddress } : {}),
      content: [
        request.question,
        ...request.options.map((option, index) => `${index + 1}. ${option}${option === request.defaultOption ? ' (default)' : ''}`),
        `Reply with /yield ${request.id} <1|2|3|cancel>.`,
        request.deadline ? `At ${request.deadline}, the default will be used if unanswered.` : 'Waiting for your answer; no automatic default.',
      ].join('\n'),
      done: true,
      yieldRequest: request,
    }
    if (this.deps.deliverYield) await this.deps.deliverYield(message)
    else this.deps.bus.emit('message.outbound', message)
  }

  private async notifyYieldParent(request: YieldRequest): Promise<void> {
    const parentId = request.recipient.sessionId
    const parent = this.getSessionState(parentId)
    if (!parent) throw new YieldError('unavailable', 'The parent session no longer exists.')
    const definitions = this.getToolDefinitions(parentId,
      this.getActiveSession(parentId) ? undefined : this.resolveAgentTypeTools(parent.agentType))
    if (!definitions.some(tool => tool.name === 'yield')) {
      throw new YieldError('unavailable', 'The parent must have the yield tool enabled to answer.')
    }
    await this.deliver(parentId, {
      kind: 'message', id: request.id, timestamp: new Date().toISOString(),
      source: { kind: 'session', sessionId: request.sessionId, senderName: 'Subagent' },
      policy: 'steering',
      content: [
        'Your subagent is paused awaiting your decision.',
        JSON.stringify(request),
        'Answer using the yield tool with action="answer", request_id set to the id above, and option set to one exact option.',
        'Do not merely send a message to the child; that does not resolve this request.',
        'After answering, continue your original task.',
      ].join('\n'),
    })
  }

  get workspace(): string {
    return this.deps.workspace
  }
  get organizationId(): string | undefined {
    return this.deps.organizationId
  }
  get workdirCapabilityLookup(): WorkdirCapabilityLookup | undefined {
    return this.deps.workdirCapabilityLookup
  }
  getNodeInventory(): NodeInventoryResponse | undefined {
    return this.deps.getNodeInventory?.()
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

  /** Compatibility query: execution mode, never role, determines reusability. */
  isEphemeralSession(sessionId: string): boolean {
    const state = this.sessionStates[sessionId]
    return !!state && state.mode !== 'session'
  }

  /** Task inputs are admitted atomically by their creator, never by MessageTool. */
  canReceiveSessionMessage(sessionId: string): boolean {
    if (this.deps.organizationId && !this.sessionStates[sessionId]) return false
    return !this.isEphemeralSession(sessionId)
  }

  // ── Lifecycle (start / stop / dispatch / recovery) ──────────────────

  async start(): Promise<void> {
    if (this.stopPromise) await this.stopPromise
    this.stopPromise = undefined
    this.stopped = false
    this.yields.start()
    // Load all session states into memory cache
    this.sessionStates = await this.store.listAllStates()
    for (const state of Object.values(this.sessionStates)) {
      if (this.deps.organizationId) {
        const address = channelAddressFromSessionId(state.sessionId)
        if (address && address.organizationId !== this.deps.organizationId) throw new Error('Bot session organization mismatch')
        if (state.organizationId && state.organizationId !== this.deps.organizationId) throw new Error('Session organization mismatch')
        state.organizationId = this.deps.organizationId
      }
      if (!isExecutionMode(state.mode)) {
        // Built-in historical lifetimes are fixed, even when the current role was edited.
        const historical = ['verify', 'reflector', 'soul-reflector', 'encapsulator'].includes(state.agentType ?? '')
          ? 'task' : ['general', 'sub', 'explore', 'plan'].includes(state.agentType ?? 'general')
          ? 'session' : this.deps.agentTypes.resolve(state.agentType ?? 'general')?.defaultMode ?? 'session'
        state.mode = historical
      }
      if (state.mode !== 'session' && ['running', 'waiting', 'pending'].includes(state.executionStatus ?? '')) {
        state.executionStatus = 'cancelled'
      }
      if (state.mode !== 'session') state.executionId ??= state.sessionId
      await this.store.saveState(state.sessionId, state)
    }
    // Legacy one-shot records remain closed even when they predate lifecycle status.
    for (const state of Object.values(this.sessionStates)) {
      if (!this.isEphemeralSession(state.sessionId)) continue
      if (state.lastActivityAt || state.segmentIndex > 0) this.acceptedInputs.add(state.sessionId)
      let finalResponse = false
      for await (const record of this.store.readSessionLog(SessionManager.currentPhysicalId(state))) {
        if ((typeof record.role === 'string' && record.role !== 'system') || record.session_recovered) {
          this.acceptedInputs.add(state.sessionId)
          finalResponse = record.role === 'assistant' && !(Array.isArray(record.tool_calls) && record.tool_calls.length)
        }
      }
      if (!state.executionStatus) {
        state.executionStatus = this.acceptedInputs.has(state.sessionId) ? finalResponse ? 'completed' : 'cancelled' : 'pending'
        await this.store.saveState(state.sessionId, state)
      }
    }

    if (this.reportSubscription) this.deps.bus.off(this.reportSubscription)
    const report = (fact: SessionTurnFact) => this.reportCompletion(fact)
    this.reportSubscription = this.deps.bus.on('session.turn.finished', this.deps.scope?.bind(report) ?? report)
    for (const state of Object.values(this.sessionStates)) {
      if (state.mode !== 'task' || state.completionReported || !state.lastActivityAt) continue
      let fact: SessionTurnFact | undefined
      for await (const record of this.store.readSessionLog(SessionManager.currentPhysicalId(state))) {
        if (record.execution_receipt) fact = record.execution_receipt as SessionTurnFact
      }
      if (!fact && state.executionStatus === 'cancelled') {
        fact = {
          sessionId: state.sessionId, turnId: state.executionId ?? state.sessionId,
          inputId: state.executionKey ?? state.sessionId,
          source: { kind: 'session', sessionId: state.parentSessionId ?? state.parent?.id ?? state.sessionId },
          status: 'cancelled', content: '', error: 'Execution interrupted by process restart.',
        }
      }
      if (fact) await this.reportCompletion(fact)
    }
  }

  private reportCompletion(fact: SessionTurnFact): Promise<void> {
    const state = this.sessionStates[fact.sessionId]
    if (!state || state.mode === 'call') return Promise.resolve()
    const oneShot = state.mode !== 'session'
    const targetId = state.reportTo
    if (!targetId || targetId === fact.sessionId || this.deleting.has(targetId)
      || (oneShot && targetId === (state.parentSessionId ?? state.parent?.id) && !this.sessionStates[targetId])
      || (oneShot && state.completionReported)
      || (!oneShot && fact.status === 'cancelled')) return Promise.resolve()
    const key = oneShot ? fact.sessionId : `${fact.sessionId}:${fact.turnId}`
    const pending = this.reporting.get(key)
    if (pending) return pending
    const report = Promise.resolve().then(async () => {
      const content = (fact.status === 'failed' ? fact.error : fact.content)?.trim()
      if (!oneShot && !content && fact.status === 'completed') return
      const eventId = oneShot ? `subagent-completion:${fact.sessionId}` : crypto.randomUUID()
      this.completionEvents.set(eventId, { sourceId: fact.sessionId, targetId })
      try {
        await this.deps.events.emit({
          id: eventId,
          type: fact.status === 'failed' ? 'subagent-failed' : fact.status === 'cancelled' ? 'subagent-cancelled' : 'subagent-complete',
          source: 'subagent', targetSessionId: targetId, senderName: 'Subagent',
          content: content || (fact.status === 'cancelled' ? fact.error ?? 'Subagent execution cancelled.' : fact.status === 'failed' ? 'Subagent request failed' : 'Subagent completed.'),
          origin: { sessionId: fact.sessionId, inputId: fact.inputId, source: { kind: 'session', sessionId: fact.sessionId } },
          meta: {
            kind: 'subagent', sourceSessionId: fact.sessionId, agentType: state.agentType,
            ...(oneShot ? { mode: state.mode, executionId: state.executionId, executionStatus: fact.status } : {}),
          },
        })
        if (oneShot) {
          state.completionReported = true
          await this.saveState(state.sessionId, state)
        }
      } finally {
        this.completionEvents.delete(eventId)
      }
    })
    this.reporting.set(key, report)
    const cleanup = () => { if (this.reporting.get(key) === report) this.reporting.delete(key) }
    void report.then(cleanup, cleanup)
    return report
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
      await Promise.allSettled(this.reporting.values())
      if (errors.length) throw new AggregateError(errors, 'Session shutdown failed')
    })
    for (const session of sessions) stopSession(session)
    this.yields.stop()
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
      this.assertProjectAccess(sessionId)
      const state = this.sessionStates[sessionId]
      const ownerId = delegationOwner(state)
      const sourceSessionId = input.source.kind === 'session' ? input.source.sessionId
        : input.source.kind === 'event' ? input.source.origin?.sessionId : undefined
      if (this.deps.organizationId) {
        const address = input.source.kind === 'user' ? input.source.sender.channelAddress : input.replyTo?.channelAddress
        if (address && address.organizationId !== this.deps.organizationId) throw new Error('Input belongs to another organization')
        if (sourceSessionId && (!this.sessionStates[sourceSessionId] || !state)) {
          throw new Error('Session input references must belong to this organization')
        }
      }
      const completion = input.source.kind === 'event' ? this.completionEvents.get(input.source.eventId) : undefined
      const trustedCompletion = completion?.sourceId === sourceSessionId && completion?.targetId === sessionId
      if (sourceSessionId && this.sessionStates[sourceSessionId]?.mode === 'call') {
        this.blockCall(sourceSessionId, 'Leaf calls cannot deliver messages or deferred events.')
      }
      if (state?.mode !== undefined && state.mode !== 'session') {
        if (state.mode === 'call' && this.calls.get(sessionId)?.input !== input
          && !(input.kind === 'control' && input.command.type === 'cancel')) {
          throw new Error('Call input is private to its blocking admission.')
        }
        if (this.acceptedInputs.has(sessionId) || state.executionStatus && state.executionStatus !== 'pending') {
          if (input.kind === 'control' && input.command.type === 'cancel') {
            this.sessions[sessionId]?.cancel()
            return { status: 'accepted', sessionId, inputId: input.id }
          }
          throw new Error(`Execution "${sessionId}" does not accept subsequent inputs; create a new ${state.mode}.`)
        }
      }
      const config = llm ?? this.deps.getLlmRuntimeConfig?.()
      if (!config) throw new Error('Session delivery requires LLM runtime configuration')
      const deliveryInput = input
      let session: Session | EphemeralSession | undefined = this.sessions[sessionId]
      if (session && !session.accepting) {
        await session.completion
        session = undefined
      }
      const created = !session
      if (!session) session = await this.createActiveSession(sessionId, deliveryInput)
      this.assertProjectAccess(sessionId)
      if (!trustedCompletion && state?.mode !== 'session' && ownerId && (this.deleting.has(ownerId) || !this.sessionStates[ownerId])) {
        session.stop()
        throw new DOMException('Execution owner was deleted before admission.', 'AbortError')
      }
      if (this.stopped) {
        session.stop()
        throw new Error('Session manager stopped')
      }
      if (this.calls.get(sessionId)?.cancelled) {
        session.stop()
        throw new DOMException('Call cancelled before admission.', 'AbortError')
      }
      try {
        session.dispatch(deliveryInput, config)
      } catch (error) {
        if (created) session.stop()
        throw error
      }
      this.acceptedInputs.add(sessionId)
      this.deps.bus.emit('session.input.accepted', { sessionId, input: deliveryInput })
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
      if (ctx.state.mode !== 'session') this.yields.cancelSession(id, 'The one-shot parent finished before answering.')
      this.deps.bus.emit('session.ended', { sessionId: id, agentType: ctx.state.agentType })
      this.deps.onSessionStopped?.(id)
    }

    if (ctx.state.mode !== 'session') {
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
        this.deps.evalBridge,
      )
      sess.onStopped = onStopped
      const frame = this.calls.get(sessionId)
      if (frame) frame.session = sess
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
        this.deps.evalBridge,
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
      if (state.mode !== 'session') continue
      if (state.executionStatus && ['completed', 'failed', 'cancelled'].includes(state.executionStatus)) continue
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
      mode?: ExecutionMode
      parentSessionId?: string | null
      executionKey?: string
      parentToolCallId?: string
      config?: SessionConfig
    },
  ): Promise<void> {
    const release = this.acquireProjectAccess()
    try { await this.buildSessionWithAccess(sessionId, parent, stateFields) }
    finally { release() }
  }

  private async buildSessionWithAccess(...[sessionId, parent, stateFields]: Parameters<SessionManager['buildSession']>): Promise<void> {
    this.deps.assertSessionProject?.({ sessionId, segmentIndex: 0, projectId: stateFields?.projectId, workdir: stateFields?.workdir })
    const existing = this.sessionStates[sessionId]
    if (existing) {
      throw new TypeError(
        `[session-manager] buildSession called for existing session "${sessionId}"`,
      )
    }

    if (this.deps.organizationId) {
      const address = channelAddressFromSessionId(sessionId)
      if (address && address.organizationId !== this.deps.organizationId) throw new Error('Bot session organization mismatch')
      for (const reference of [parent?.id, stateFields?.workspaceRoot, stateFields?.reportTo, stateFields?.parentSessionId]) {
        if (reference && !this.sessionStates[reference]) throw new Error('Session reference does not belong to this organization')
        if (reference) this.assertProjectAccess(reference)
      }
      if (stateFields?.projectId && !this.deps.ownsProject?.(stateFields.projectId)) throw new Error('Project does not belong to this organization')
      if (stateFields?.workdir && !this.deps.ownsWorkdir?.(stateFields.workdir)) throw new Error('Workdir does not belong to this organization')
      const inherited = parent ? this.sessionStates[parent.id] : undefined
      if (inherited?.projectId && stateFields?.projectId && stateFields.projectId !== inherited.projectId) {
        throw new Error('Child sessions cannot switch projects')
      }
    }
    const agent = this.deps.agentTypes.resolve(
      stateFields?.agentType ?? 'general',
    )
    if (!agent) {
      throw new TypeError(
        `[session-manager] buildSession: unknown agent type "${stateFields?.agentType}"`,
      )
    }
    if (stateFields?.mode !== undefined && !isExecutionMode(stateFields.mode)) throw new TypeError('Invalid execution mode.')
    const mode = stateFields?.mode ?? agent.defaultMode
    const ownerId = stateFields?.parentSessionId === null ? undefined
      : stateFields?.parentSessionId ?? (parent?.index === undefined && stateFields !== undefined ? parent?.id : undefined)
    if (ownerId) this.assertCanCreateChild(ownerId, mode)
    if (mode === 'call' && (!ownerId || stateFields?.reportTo !== undefined)) {
      throw new Error('Calls require a permitted structural owner and cannot use report_to.')
    }

    const ts = new Date().toISOString()
    const physicalSessionId = newPhysicalSessionId(sessionId, 0)

    const startEvent: SessionStartEvent = {
      organizationId: this.deps.organizationId,
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
      ...stateFields?.config,
      ...(stateFields?.model ? { model: stateFields.model } : {}),
    }

    const parentState = parent ? this.sessionStates[parent.id] : undefined
    const parentWorkdir = parentState?.workdir
    const inheritedWorkdir = parentWorkdir &&
        !(parentWorkdir.nodeId === LOCAL_NODE_ID &&
          parentWorkdir.capabilityId.startsWith('managed-session-v1:'))
      ? parentWorkdir
      : undefined
    const state: SessionState = {
      organizationId: this.deps.organizationId,
      mode: stateFields?.mode ?? agent.defaultMode ?? 'session',
      executionStatus: 'pending',
      parentSessionId: ownerId ?? null,
      executionKey: stateFields?.executionKey,
      parentToolCallId: stateFields?.parentToolCallId,
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
    if (state.mode !== 'session') state.executionId = sessionId

    await this.saveState(sessionId, state)
  }

  /**
   * Start a standalone session with a specific agent type.
   * Fire-and-forget — no parent tracking or completion callbacks.
   * @returns sessionId, or null if the agent type is unknown.
   */
  async startSession(opts: StartSessionOptions): Promise<string | null> {
    opts.signal?.throwIfAborted()
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
    if (opts.signal?.aborted) {
      const state = this.sessionStates[sessionId]
      state.executionStatus = 'cancelled'
      await this.saveState(sessionId, state)
      opts.signal.throwIfAborted()
    }

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
   * Only reusable child sessions belong in this managed list.
   */
  async addChild(
    parentSessionId: string,
    childSessionId: string,
  ): Promise<void> {
    if (this.deps.organizationId && (!this.sessionStates[parentSessionId] || !this.sessionStates[childSessionId])) {
      throw new Error('Child and parent must belong to this organization')
    }
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
      if (!childState || childState.mode !== 'session') continue
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

  async applySessionConfigPatch(
    sessionId: string,
    patch: SessionConfigPatch,
    create = false,
  ): Promise<void> {
    const state = this.sessionStates[sessionId] ??
      (create ? await this.getOrCreateState(sessionId) : null)
    if (!state) throw new Error('session_not_found')
    const config = { ...state.config, ...patch.set }
    for (const key of patch.unset) delete config[key]
    const next = Object.keys(config).length ? config : undefined
    // Keep the active session's state reference, but only publish durable changes.
    await this.store.saveState(sessionId, { ...state, config: next })
    state.config = next
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

  private async stopOwnedChildren(ownerId: string, seen = new Set<string>()): Promise<void> {
    if (seen.has(ownerId)) return
    seen.add(ownerId)
    for (const child of Object.values(this.sessionStates)) {
      if (delegationOwner(child) !== ownerId || seen.has(child.sessionId)) continue
      const marked = !this.deleting.has(child.sessionId)
      if (marked) this.deleting.add(child.sessionId)
      try {
        this.yields.cancelSession(child.sessionId, 'Owner session deleted.')
        const execution = this.sessions[child.sessionId]
        execution?.stop()
        await execution?.completion
        await this.stopOwnedChildren(child.sessionId, seen)
      } finally {
        if (marked) this.deleting.delete(child.sessionId)
      }
    }
  }

  private async _deleteSessionRecursive(
    sessionId: string,
    deleted: string[],
  ): Promise<void> {
    const state = this.sessionStates[sessionId]
    if (!state || this.deleting.has(sessionId)) return
    this.deleting.add(sessionId)

    // Cascade: delete children first
    if (state.children?.length) {
      for (const childId of [...state.children]) {
        await this._deleteSessionRecursive(childId, deleted)
      }
    }
    await this.stopOwnedChildren(sessionId)

    // Ephemeral children may not be in state.children, but cannot keep waiting
    // or resume a provider call after their decision recipient is deleted.
    for (const [id, child] of Object.entries(this.sessions)) {
      const request = this.yields.get(id)
      if (request?.recipient.kind === 'parent' && request.recipient.sessionId === sessionId) child.cancel()
    }

    // Stop active session if running
    const active = this.sessions[sessionId]
    if (active) {
      active.stop()
      await active.completion
      delete this.sessions[sessionId]
    }
    this.yields.cancelSession(sessionId, 'Session deleted.')

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
    this.deleting.delete(sessionId)
  }

  // ── Queries (state, history, tools, context) ───────────────────────

  getSessionState(sessionId: string): SessionState | null {
    return this.sessionStates[sessionId] ?? null
  }

  async getSessionDetails(sessionId: string, physicalId?: string) {
    const state = this.getSessionState(sessionId)
    if (!state) return null
    const segments = Array.from({ length: state.segmentIndex + 1 }, (_, index) =>
      newPhysicalSessionId(sessionId, index))
    if (physicalId !== undefined && !segments.includes(physicalId)) return null
    const selected = physicalId ?? segments[segments.length - 1]!
    let usage: LLMResponseUsage | null = null
    let usedTokens: number | null = null
    // Legacy assistant records can repeat the last response's usage. They cannot
    // support reliable cumulative accounting, so expose only the latest known call.
    for (const segment of physicalId === undefined ? segments : [selected]) {
      for await (const record of this.store.readSessionLog(segment)) {
        if (record.role !== 'assistant') continue
        const value = record.usage
        if (!isConfigObject(value)) continue
        const { promptTokens, completionTokens, totalTokens } = value
        if (typeof promptTokens !== 'number' || typeof completionTokens !== 'number' || typeof totalTokens !== 'number' ||
          ![promptTokens, completionTokens, totalTokens].every(token => Number.isSafeInteger(token) && token >= 0)) continue
        usage = { promptTokens, completionTokens, totalTokens }
        if (segment === selected) usedTokens = usage.promptTokens
      }
    }
    let workdir = resolveSessionLocations(
      this.workspace, state, undefined, this.workdirCapabilityLookup,
    ).workdir
    try { this.assertProjectAccess(sessionId) }
    catch { workdir = { available: false, workdir: workdir.workdir, reason: 'capability-revoked' } }
    const remote = workdir.workdir.nodeId !== LOCAL_NODE_ID
    const node = this.getNodeInventory()?.nodes.find(node =>
      remote ? node.nodeId === workdir.workdir.nodeId : node.role === 'main')
    const capability = node?.capabilities.find(capability =>
      capability.capabilityId === workdir.workdir.capabilityId && capability.kind === 'workdir')
    const model = state.config?.model ?? this.deps.getLlmRuntimeConfig?.().model
    const window = model ? this.deps.getKnownContextWindow?.(model) : null
    return {
      ...(state.organizationId ? { organizationId: state.organizationId } : {}),
      sessionId,
      name: await this.getFirstUserMessage(sessionId),
      workdir: {
        kind: remote ? 'remote' as const : 'local' as const,
        displayPath: remote
          ? capability?.displayPath ?? null
          : workdir.available && workdir.locality === 'local' ? workdir.path : null,
        nodeId: node?.nodeId ?? workdir.workdir.nodeId,
        ...(node ? { nodeName: node.displayName } : {}),
        ...(capability ? { displayName: capability.displayName } : {}),
        available: workdir.available,
        availability: workdir.available ? 'available' as const : workdir.reason,
      },
      usage,
      usageScope: 'latest-call' as const,
      context: {
        usedTokens,
        windowTokens: typeof window === 'number' && Number.isSafeInteger(window) && window > 0 ? window : null,
      },
    }
  }

  getActiveSession(sessionId: string): Session | EphemeralSession | undefined {
    return this.sessions[sessionId]
  }

  requestCompact(sessionId: string, llm: LlmRuntimeConfig): boolean {
    this.assertProjectAccess(sessionId)
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
    { organizationId?: string; sessionId: string; segmentIndex: number; lastActivityAt?: string; projectId?: string }
  > {
    return Object.values(this.sessionStates).map((s) => ({
      ...(s.organizationId ? { organizationId: s.organizationId } : {}),
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
    const policy = behaviorOverride ?? (sessionId && this.sessionStates[sessionId]
      ? this.resolveAgentTypeTools(this.sessionStates[sessionId].agentType) : {})
    const scoped = new SessionTools(this.deps.tools, this.workspace, policy.allowedTools, policy.blockedTools)
    if (sessionId) scoped.setExecutionScope(this.sessionStates[sessionId]?.mode ?? 'session', this.getAllowedSubagentModes(sessionId))
    const allDefs = scoped.getDefinitions()
    const filtered = allDefs.filter((d) =>
      isToolAllowed(policy, d.function.name, d.optIn)
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
    if (opts.sessionId) this.assertProjectAccess(opts.sessionId)
    let sessionId: string
    let channel: string
    let chatId: string
    if (opts.sessionId) {
      sessionId = opts.sessionId
      const channelAddress = channelAddressFromSessionId(sessionId)
      const colonIdx = sessionId.indexOf(':')
      channel = channelAddress?.platform ?? (colonIdx >= 0 ? sessionId.slice(0, colonIdx) : sessionId)
      chatId = channelAddress?.conversationId ?? (colonIdx >= 0 ? sessionId.slice(colonIdx + 1) : 'direct')
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
      organizationId: this.deps.organizationId,
      behavior,
      channel,
      chatId,
      channelAddress: channelAddressFromSessionId(sessionId),
      sessionId,
      defaultExecShell: behavior.defaultShell ?? this.deps.defaultExecShell,
      agent: agentType,
      mode: state?.mode ?? agentType.defaultMode,
      parentSessionId: delegationOwner(state),
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
    if (this.deps.organizationId) {
      if (state.organizationId && state.organizationId !== this.deps.organizationId) throw new Error('Session organization mismatch')
      state.organizationId = this.deps.organizationId
    }
    this.sessionStates[sessionId] = state
    await this.store.saveState(sessionId, state)
  }

  private async getOrCreateState(
    sessionId: string,
  ): Promise<SessionState> {
    const address = channelAddressFromSessionId(sessionId)
    if (this.deps.organizationId && address && address.organizationId !== this.deps.organizationId) throw new Error('Bot session organization mismatch')
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
      mode: 'session',
      executionStatus: 'pending',
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
      organizationId: this.deps.organizationId,
      behavior,
      channel: msg.channel,
      chatId: msg.chatId,
      channelAddress: msg.channelAddress ?? channelAddressFromSessionId(sessionId),
      sessionId,
      chatName: msg.chatName,
      senderId: msg.senderId,
      senderName: msg.senderName ?? msg.senderId,
      inputSource: input.source.kind,
      isGroup: msg.isGroup,
      admin: msg.admin,
      defaultExecShell: behavior.defaultShell ?? this.deps.defaultExecShell,
      agent: resolvedAgentType,
      mode: state.mode,
      parentSessionId: delegationOwner(state),
      projectName: state.projectName,
      ...sessionPromptLocality(state),
    }
    const systemPrompt = await this.deps.context.buildSystemPrompt(promptCtx)

    const { messages: history } = await this.getHistory(sessionId)

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...history,
    ]

    const sessionTools = this.calls.get(sessionId)?.tools ?? new SessionTools(
      this.deps.tools,
      this.deps.workspace,
      allowedTools,
      blockedTools,
    )
    if (!this.calls.has(sessionId)) sessionTools.setExecutionScope(state.mode ?? 'session', this.getAllowedSubagentModes(sessionId))

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
