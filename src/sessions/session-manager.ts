import { trace } from '@opentelemetry/api'
import { parseSessionName } from './session-name.ts'
import { mkdir } from 'node:fs/promises'
import { isCommandReceipt, type CommandReceipt } from '../slash-commands/receipt.ts'
import { parseAutomationSessionRef, resolveAutomationSession, type AutomationSessionRef } from '../cron/contracts.ts'
import { parseInitiativeId } from './initiative-metadata.ts'
import type { Hono } from 'hono'
import type { AgentTypesManager } from '../agent/types/manager.ts'
import type { AgentTypeDefinition } from '../agent/types/types.ts'
import type { ConversationPolicies } from '../agent-authoring/service.ts'
import type { BackgroundTaskManager } from '../agent/background-task.ts'
import type {
  ContextBuilder,
  SessionPromptContext,
} from '../agent/context/builder.ts'
import type { EventService } from '../events/service.ts'
import type { IdentityManager } from '../agent/identity.ts'
import type { LlmRuntimeConfig } from '../agent/llm-config.ts'
import type { Bus } from '../bus/bus.ts'
import type { ProjectScope } from '../projects/scope.ts'
import { channelAddressFromSessionId, deriveSessionId, type InboundMessage } from '../bus/events.ts'
import type { HandoffManager } from './handoff/manager.ts'
import type { ChatMessage, LLMProvider, LLMResponseUsage } from '../providers/provider.ts'
import { ImportTool } from '../tools/load-tool.ts'
import { SessionTools, type Tools } from '../tools/registry.ts'
import type { ExecShell } from '../tools/shell.ts'
import {
  sanitizeToolPairs,
  truncatePreservingToolPairs,
} from '../utils/messages.ts'
import { Span } from '../otel/tracing.ts'
import { newPhysicalSessionId } from '../utils/paths.ts'
import { hasTruncatedLegacyHistory, physicalSessionId, SessionIdentityError } from './session-identity.ts'
import { isToolAllowed } from '../utils/tool-allow.ts'
import { errMsg } from '../utils/truncate.ts'
import { EphemeralSession } from './ephemeral-session.ts'
import { evaluateAuthoringScenario } from './authoring-evaluation.ts'
import { LOCAL_NODE_ID, normalizeSessionLocality, resolveSessionLocations, type WorkdirCapabilityLookup, type WorkdirRefV1 } from './locality.ts'
import { parseTopicMetadata, parseTopicSessionFields, type TopicMetadata } from './topic-contract.ts'
import type { NodeInventoryResponse } from '../cluster/node-inventory.ts'
import { isConfigObject, type SessionConfigPatch } from './config-patch.ts'
import type { Executor } from '../execution/executor.ts'
import type {
  SessionConfig,
  SessionParent,
  SessionStartEvent,
  SessionState,
  SessionRecovery,
  SessionStore,
} from './session-store.ts'
import { Session } from './session.ts'
import { YieldError, YieldManager } from './yield.ts'
import { parseYieldPolicy, type YieldPolicy, type YieldRequest } from './yield-contract.ts'
import { allowedSubagentModes, isExecutionMode, type ExecutionMode } from './execution-mode.ts'
import { delegationOwner, MAX_CALL_TIMEOUT_MS } from './execution-scope.ts'
import { CallTools } from './call-tools.ts'
import { prepareSessionRecovery, SessionResumeError } from './recovery.ts'
import type { ExecutionContext } from '../tools/context.ts'
import type { ToolBridgeFactory } from '../script-runtime/bridge.ts'
import {
  channelMessageInput,
  inputContext,
  sessionReplyAddress,
  type DeliveryReceipt,
  type SessionInput,
  type SessionTurnFact,
} from './input.ts'

export type { SessionState, SessionStore } from './session-store.ts'

export class ConversationContextsBusyError extends Error {}

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
  conversationPolicies?: ConversationPolicies
  promptCaptures?: import('./prompt-capture.ts').PromptCaptureStore
  projectId?: string
  hasInitiative?: (initiativeId: string) => boolean
  scope?: ProjectScope
  evalBridge?: ToolBridgeFactory
  ownsFolder?: (folderId: string) => boolean
  ownsWorkdir?: (workdir: WorkdirRefV1) => boolean
  assertSessionFolder?: (state: SessionState) => void
  acquireFolderAccess?: () => () => void
  /** Host/test deadline override: integer 1–120000 ms; default 120000 ms. */
  callTimeoutMs?: number
  workspace: string
  store: SessionStore
  handoffManager: HandoffManager
  // ── Active session deps ──
  bus: Bus
  provider: LLMProvider
  tools: Tools
  toolLoader?: Pick<ImportTool, 'importSource'>
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
  automation?: AutomationSessionRef
  locality?: Pick<SessionState, 'workspaceRoot' | 'workdir' | 'folderId' | 'initiativeId'>
  mode?: ExecutionMode
  waitForCompletion?: boolean
  onAccepted?: (sessionId: string) => void
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
  state: Pick<SessionState, 'workspaceRoot' | 'workdir' | 'folderId'> | undefined,
): Pick<SessionPromptContext, 'workspaceRoot' | 'workdir' | 'folderId'> {
  return {
    workspaceRoot: state?.workspaceRoot,
    workdir: state?.workdir,
    folderId: state?.folderId,
  }
}

interface BlockingCallFrame {
  callerId: string
  tools: CallTools
  input?: SessionInput
  session?: EphemeralSession
  blockedReason?: string
  cancelled: boolean
  settled: Promise<void>
}

export class SessionManager {
  readonly yields: YieldManager
  /** Registry of active per-session event loops. */
  private sessions: Record<string, Session | EphemeralSession> = {}
  private preparations = new Map<string, Promise<unknown>>()
  private acceptedInputs = new Set<string>()
  private promptRevision = 0
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
  private readonly topicUpdates = new Map<string, Promise<void>>()
  private readonly stateCreations = new Map<string, Promise<unknown>>()
  private readonly ownedCreations = new Map<string, Set<Promise<void>>>()

  acquireFolderAccess(): () => void {
    return this.deps.acquireFolderAccess?.() ?? (() => {})
  }

  assertFolderAccess(sessionId: string): void {
    const visited = new Set<string>()
    const check = (id: string) => {
      if (visited.has(id)) return
      visited.add(id)
      const state = this.sessionStates[id]
      if (!state) return
      this.deps.assertSessionFolder?.(state)
      for (const parent of [delegationOwner(state)]) {
        if (parent) check(parent)
      }
    }
    check(sessionId)
  }

  get hasFolderWork(): boolean {
    return this.preparations.size > 0 || this.executionAdmissions.size > 0 || this.topicUpdates.size > 0 || this.stateCreations.size > 0 ||
      this.reporting.size > 0 || this.calls.size > 0 ||
      Object.values(this.sessions).some(session => !(session instanceof Session) || !session.quiescent)
  }

  invalidateFolderSessions(): void {
    for (const [id, session] of Object.entries(this.sessions)) {
      try { this.assertFolderAccess(id) } catch { session.stop() }
    }
  }

  folderDependentSessions(folderId: string, workdirs: readonly WorkdirRefV1[]): string[] {
    const affected = new Set<string>()
    for (const [id, state] of Object.entries(this.sessionStates)) {
      if (state.folderId === folderId || state.workdir && workdirs.some(ref =>
        ref.nodeId === state.workdir!.nodeId && ref.capabilityId === state.workdir!.capabilityId)) affected.add(id)
    }
    let previous = -1
    while (previous !== affected.size) {
      previous = affected.size
      for (const [id, state] of Object.entries(this.sessionStates)) {
        const owner = delegationOwner(state)
        if (owner && affected.has(owner)) affected.add(id)
      }
    }
    return [...affected]
  }

  isWaitingForCall(sessionId: string): boolean {
    return [...this.calls.values()].some(frame => frame.callerId === sessionId)
  }

  async evaluateAuthoringScenario(input: {
    prompt: string; tools: SessionTools; input: string; signal: AbortSignal
    llmOverrides?: Partial<Pick<LlmRuntimeConfig, 'model' | 'temperature' | 'maxTokens' | 'thinking' | 'reasoningEffort'>>
  }) {
    if (this.stopped || !this.deps.projectId) throw new Error('Authoring evaluation requires a running Project session manager.')
    const llm = this.deps.getLlmRuntimeConfig?.()
    if (!llm) throw new Error('Authoring evaluation requires the configured LLM runtime.')
    return evaluateAuthoringScenario({
      ...input, workspace: this.workspace, projectId: this.deps.projectId,
      provider: this.deps.provider, llm: { ...llm, ...input.llmOverrides },
    })
  }

  getDelegationOwner(sessionId: string): string | undefined {
    return delegationOwner(this.sessionStates[sessionId])
  }

  getAllowedSubagentModes(sessionId: string): readonly ExecutionMode[] {
    if (this.isManagedConversation(sessionId)) return []
    const state = this.sessionStates[sessionId]
    return allowedSubagentModes(state?.mode ?? 'session', !!delegationOwner(state))
  }

  assertCanCreateChild(sessionId: string, mode: ExecutionMode): void {
    this.assertFolderAccess(sessionId)
    const state = this.sessionStates[sessionId]
    if (!state) throw new Error('Delegation requires an existing owner session.')
    if (state.mode === 'call') this.blockCall(sessionId, 'Leaf calls cannot create subagents.')
    if (state.mode === 'task' && ['completed', 'failed', 'cancelled'].includes(state.executionStatus ?? '')) {
      throw new Error('A terminal task cannot create more work.')
    }
    if (this.deleting.has(sessionId)) throw new Error('Delegation owner is being deleted.')
    if (!this.getAllowedSubagentModes(sessionId).includes(mode)) throw new Error(`Execution mode "${mode}" is not allowed from this session.`)
    const role = this.resolveAgentTypeTools(state.agentType, state.sessionKind)
    if (role.allowedTools !== undefined ? !role.allowedTools.includes('subagent') : role.blockedTools?.includes('subagent')) {
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
    if (this.deps.projectId && context.projectId !== this.deps.projectId) throw new Error('Call context belongs to another project')
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
    const role = this.resolveAgentTypeTools(state.agentType, state.sessionKind)
    const tools = new CallTools(context.tools, this.workspace, role.allowedTools, role.blockedTools, role.agentType.allowedModules)
    const settled = Promise.withResolvers<void>()
    const frame: BlockingCallFrame = {
      callerId: context.sessionId, tools, cancelled: false, settled: settled.promise,
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
      settled.resolve()
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
    if (this.deps.projectId && (!this.sessionStates[sourceId] || !this.sessionStates[targetId])) return false
    if (this.sessionStates[sourceId]?.mode === 'call') {
      try { this.blockCall(sourceId, 'Leaf calls cannot send messages.') } catch { return false }
    }
    return this.canReceiveSessionMessage(targetId)
  }

  async startChild(sessionId: string, task: string, context: ExecutionContext): Promise<DeliveryReceipt> {
    if (this.deps.projectId && context.projectId !== this.deps.projectId) throw new Error('Child context belongs to another project')
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
    return physicalSessionId(state)
  }

  private historyConflict(sessionId: string, seen = new Set<string>()): string | undefined {
    if (seen.has(sessionId)) return
    seen.add(sessionId)
    const state = this.sessionStates[sessionId]
    if (!state) return
    if (hasTruncatedLegacyHistory(state)) return sessionId
    if (state.parent?.index !== undefined) {
      const parent = state.parent
      if (hasTruncatedLegacyHistory({ sessionId: parent.id })
        && parent.physicalId?.replace(/-\d+$/, '-0') === newPhysicalSessionId(parent.id, 0, 1)) return parent.id
      return this.historyConflict(parent.id, seen)
    }
  }

  private assertHistoryWritable(sessionId: string): void {
    if (this.historyConflict(sessionId)) {
      throw new SessionIdentityError('Legacy session history uses a truncated ID and may contain another conversation. Repair the history or delete this conversation before starting fresh. Shared legacy logs are preserved.')
    }
  }

  constructor(
    private readonly deps: SessionManagerDeps,
  ) {
    if (deps.scope && deps.scope.projectId !== deps.projectId) {
      throw new Error('Session manager project scope mismatch')
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
      notifyUser: (request, replyTo) => this.notifyYieldUser(request, replyTo),
      notifyParent: request => this.notifyYieldParent(request),
    })
  }

  getYieldPolicy(sessionId: string): YieldPolicy {
    return parseYieldPolicy(this.getSessionConfig(sessionId).yield ?? this.deps.getYieldPolicy?.() ?? { timeoutMs: null })
  }

  private async notifyYieldUser(request: YieldRequest, replyTo?: string): Promise<void> {
    const separator = request.sessionId.indexOf(':')
    if (separator < 1 || request.sessionId.startsWith('web:')) return
    const channelAddress = channelAddressFromSessionId(request.sessionId)
    if (channelAddress && channelAddress.projectId !== this.deps.projectId) {
      throw new YieldError('forbidden', 'The question belongs to another project.')
    }
    const message: import('../bus/events.ts').OutboundMessage = {
      event: 'response',
      channel: channelAddress?.platform ?? request.sessionId.slice(0, separator),
      chatId: channelAddress?.conversationId ?? request.sessionId.slice(separator + 1),
      ...(channelAddress ? { channelAddress } : {}),
      ...(replyTo ? { replyTo } : {}),
      content: [
        request.question,
        ...request.options.map((option, index) => `${index + 1}. ${option}${option === request.defaultOption ? ' (default)' : ''}`),
        `Reply with /yield ${request.id} <${request.options.map((_, index) => index + 1).join('|')}|cancel>.`,
        `Or write your own response: /yield ${request.id} text <your response>.`,
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
      this.getActiveSession(parentId) ? undefined : this.resolveAgentTypeTools(parent.agentType, parent.sessionKind))
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
  get projectId(): string | undefined {
    return this.deps.projectId
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
  getPromptCaptures(sessionId: string) {
    this.assertFolderAccess(sessionId)
    return this.deps.promptCaptures?.list(sessionId)
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
    if (this.deps.projectId && !this.sessionStates[sessionId]) return false
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
      if (this.historyConflict(state.sessionId)) {
        console.error(`[session-manager] Session ${state.sessionId} has potentially shared legacy history; automatic continuation is blocked pending explicit repair.`)
      }
    }
    for (const state of Object.values(this.sessionStates)) {
      state.automation ??= resolveAutomationSession(state)
      state.automationVersion = 1
      if (this.deps.projectId) {
        const address = channelAddressFromSessionId(state.sessionId)
        if (address && address.projectId !== this.deps.projectId) throw new Error('Bot session project mismatch')
        if (state.projectId && state.projectId !== this.deps.projectId) throw new Error('Session project mismatch')
        state.projectId = this.deps.projectId
      }
      if (!isExecutionMode(state.mode)) {
        // Built-in historical lifetimes are fixed, even when the current role was edited.
        const historical = ['verify', 'reflector', 'soul-reflector', 'encapsulator'].includes(state.agentType ?? '')
          ? 'task' : ['general', 'sub', 'explore', 'plan'].includes(state.agentType ?? 'general')
          ? 'session' : this.deps.agentTypes.resolve(state.agentType ?? 'general')?.defaultMode ?? 'session'
        state.mode = historical
      }
      if (state.mode === 'session') {
        const formerOwner = state.parentSessionId ?? (state.parent?.index === undefined
          && (state.workspaceRoot || state.reportTo || state.description || state.parent?.physicalId) ? state.parent?.id : undefined)
        if (formerOwner || state.workspaceRoot) {
          // Keep workspaceRoot as a data-location compatibility key, not an owner:
          // managed-session capabilities and sessionDataDir must not change.
          state.workdir = normalizeSessionLocality(state).workdir
        }
        if (formerOwner && formerOwner !== state.sessionId) state.createdBySessionId ??= formerOwner
        state.parentSessionId = null
        delete state.reportTo
        state.sessionKind ??= state.sessionId === 'web:orchestrator' && state.agentType === 'orchestrator'
          ? 'orchestrator' : state.automation ? undefined : 'topic'
      }
      if (state.mode !== 'session' && ['running', 'waiting', 'pending'].includes(state.executionStatus ?? '')) {
        state.executionStatus = 'cancelled'
      }
      if (state.mode !== 'session') state.executionId ??= state.sessionId
      await this.store.saveState(state.sessionId, state)
    }
    for (const state of Object.values(this.sessionStates)) {
      if (!state.children) continue
      state.children = state.children.filter(id => delegationOwner(this.sessionStates[id]) === state.sessionId)
      await this.store.saveState(state.sessionId, state)
    }
    // Legacy one-shot records remain closed even when they predate lifecycle status.
    for (const state of Object.values(this.sessionStates)) {
      if (!this.isEphemeralSession(state.sessionId)) continue
      if (this.historyConflict(state.sessionId)) continue
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
      if (this.historyConflict(state.sessionId)) continue
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
    await this.recoverIncompleteSessions()
  }

  private reportCompletion(fact: SessionTurnFact): Promise<void> {
    const state = this.sessionStates[fact.sessionId]
    if (!state || state.mode !== 'task' || this.deleting.has(fact.sessionId)) return Promise.resolve()
    const targetId = state.reportTo
    if (!targetId || targetId === fact.sessionId || this.deleting.has(targetId)
      || (targetId === (state.parentSessionId ?? state.parent?.id) && !this.sessionStates[targetId])
      || state.completionReported) return Promise.resolve()
    const key = fact.sessionId
    const pending = this.reporting.get(key)
    if (pending) return pending
    const report = Promise.resolve().then(async () => {
      const content = (fact.status === 'failed' ? fact.error : fact.content)?.trim()
      const eventId = `subagent-completion:${fact.sessionId}`
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
            mode: state.mode, executionId: state.executionId, executionStatus: fact.status,
          },
        })
        state.completionReported = true
        await this.saveState(state.sessionId, state)
      } finally {
        this.completionEvents.delete(eventId)
      }
    })
    this.reporting.set(key, report)
    const cleanup = () => { if (this.reporting.get(key) === report) this.reporting.delete(key) }
    void report.then(cleanup, cleanup)
    return report
  }

  invalidateSystemPrompts(): void {
    this.promptRevision++
    for (const session of Object.values(this.sessions)) {
      if (session instanceof Session) session.invalidateSystemPrompt()
    }
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
      await Promise.allSettled(this.topicUpdates.values())
      await Promise.allSettled(this.stateCreations.values())
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
      this.deps.promptCaptures?.clear()
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
    return this.withSessionPreparation(sessionId, async (): Promise<DeliveryReceipt> => {
      this.deps.conversationPolicies?.authorize(sessionId, input)
      this.assertFolderAccess(sessionId)
      this.assertHistoryWritable(sessionId)
      const state = this.sessionStates[sessionId]
      const resume = input.kind === 'control' && input.command.type === 'resume' ? input.command : undefined
      if (resume && (state?.mode !== 'session' || state.recovery?.id !== resume.recoveryId)) {
        throw new SessionResumeError('This recovery is no longer current. Refresh the conversation.')
      }
      const ownerId = delegationOwner(state)
      const sourceSessionId = input.source.kind === 'session' ? input.source.sessionId
        : input.source.kind === 'event' ? input.source.origin?.sessionId : undefined
      if (this.deps.projectId) {
        const address = input.source.kind === 'user' ? input.source.sender.channelAddress : input.replyTo?.channelAddress
        if (address && address.projectId !== this.deps.projectId) throw new Error('Input belongs to another project')
        if (sourceSessionId && (!this.sessionStates[sourceSessionId] || !state)) {
          throw new Error('Session input references must belong to this project')
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
      const deliveryInput = this.isManagedConversation(sessionId) && input.kind === 'message'
        ? {
          ...input, policy: input.policy === 'silent' ? 'silent' as const : 'queue' as const,
          source: input.source.kind === 'user'
            ? { kind: 'user' as const, sender: { ...input.source.sender, admin: false } }
            : input.source,
        }
        : input
      let session: Session | EphemeralSession | undefined = this.sessions[sessionId]
      if (resume && session && (!('quiescent' in session) || !session.quiescent)) {
        throw new SessionResumeError('The conversation has active or queued work. Wait before continuing.')
      }
      if (session && !session.accepting) {
        await session.completion
        session = undefined
      }
      const created = !session
      if (!session) session = await this.createActiveSession(sessionId, deliveryInput)
      if (this.deleting.has(sessionId)) {
        session.stop()
        throw new DOMException('Session was deleted before admission.', 'AbortError')
      }
      this.assertFolderAccess(sessionId)
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
      const recovery = resume ? state!.recovery : undefined
      const previousStatus = state?.executionStatus
      if (resume) {
        if (state!.recovery?.id !== resume.recoveryId) throw new SessionResumeError('This recovery is no longer current.')
        delete state!.recovery
        state!.executionStatus = 'running'
        try { await this.store.saveState(sessionId, state!) }
        catch (error) {
          state!.recovery = recovery
          state!.executionStatus = previousStatus
          if (created) session.stop()
          throw error
        }
      }
      try {
        this.deps.conversationPolicies?.authorize(sessionId, input)
        session.dispatch(deliveryInput, config)
      } catch (error) {
        if (resume) {
          state!.recovery = recovery
          state!.executionStatus = previousStatus
          await this.store.saveState(sessionId, state!)
        }
        if (created) session.stop()
        throw error
      }
      this.acceptedInputs.add(sessionId)
      this.deps.bus.emit('session.input.accepted', { sessionId, input: deliveryInput })
      return { status: 'accepted', sessionId, inputId: input.id }
    })
  }

  private withSessionPreparation<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new Error('Session manager stopped'))
    const previous = this.preparations.get(sessionId) ?? Promise.resolve()
    const admission = previous.catch(() => {}).then(() => {
      if (this.stopped) throw new Error('Session manager stopped')
      if (this.deleting.has(sessionId)) throw new Error('Session is being deleted')
      return operation()
    })
    this.preparations.set(sessionId, admission)
    const clean = () => {
      if (this.preparations.get(sessionId) === admission) this.preparations.delete(sessionId)
    }
    void admission.then(clean, clean)
    return admission
  }

  isManagedConversation(sessionId: string): boolean {
    return this.deps.conversationPolicies?.managed(sessionId) ?? false
  }

  authorizeConversationInput(sessionId: string, input: SessionInput): void {
    this.deps.conversationPolicies?.authorize(sessionId, input)
  }

  async retireIdleConversationContexts(matches: (sessionId: string) => boolean): Promise<void> {
    if ([...this.preparations.keys()].some(matches)) throw new ConversationContextsBusyError('A channel input is being admitted. Publication can continue after admission finishes.')
    const active = Object.entries(this.sessions).filter(([id]) => matches(id))
    if (active.some(([, session]) => !(session instanceof Session) || !session.quiescent)) {
      throw new ConversationContextsBusyError('Channel conversations still have active or queued work. Publication can continue when that work finishes.')
    }
    for (const [, session] of active) session.stop()
    await Promise.all(active.map(([, session]) => session.completion))
  }

  private async createActiveSession(sessionId: string, input: SessionInput): Promise<Session | EphemeralSession> {
    const promptRevision = this.promptRevision
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
        this.deps.promptCaptures,
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
        () => ctx.conversationPolicy
          ? Promise.resolve(this.deps.conversationPolicies!.prompt(ctx.conversationPolicy, sessionId).systemPrompt)
          : this.deps.context.buildSystemPrompt(ctx.promptCtx),
        this.deps.quickModel,
        this.sleepInactivityMs,
        this.deps.workdirCapabilityLookup,
        this.deps.remoteExecutor,
        this.deps.evalBridge,
        this.deps.promptCaptures,
      )
      if (promptRevision !== this.promptRevision) sess.invalidateSystemPrompt()
      this.sessions[sessionId] = sess
      return sess
    }
  }

  /** Mark interrupted histories for explicit continuation; startup never resumes them. */
  async recoverIncompleteSessions(): Promise<void> {
    for (const state of Object.values(this.sessionStates)) {
      if (this.sessions[state.sessionId] || this.preparations.has(state.sessionId)) continue
      if (this.historyConflict(state.sessionId)) continue
      await prepareSessionRecovery(this.store, state)
    }
  }

  getSessionRecovery(sessionId: string): SessionRecovery | undefined {
    const session = this.sessions[sessionId]
    if (this.preparations.has(sessionId) || (session && (!('quiescent' in session) || !session.quiescent))) return
    return this.sessionStates[sessionId]?.mode === 'session' ? this.sessionStates[sessionId]?.recovery : undefined
  }

  resumeSession(sessionId: string, recoveryId: string): Promise<DeliveryReceipt> {
    const id = crypto.randomUUID()
    return this.deliver(sessionId, {
      id, kind: 'control', command: { type: 'resume', recoveryId }, timestamp: new Date().toISOString(),
      source: { kind: 'event', eventId: id, type: 'session-resume', source: 'user' },
      replyTo: sessionReplyAddress(sessionId),
    })
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
      initiativeId?: string
      folderId?: string
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
      automation?: AutomationSessionRef
      sessionKind?: 'topic' | 'orchestrator'
      topic?: TopicMetadata
      createdBySessionId?: string
      topicRequestHash?: string
    },
  ): Promise<void> {
    const release = this.acquireFolderAccess()
    try { await this.withStateCreation(sessionId, () => this.buildSessionWithAccess(sessionId, parent, stateFields)) }
    finally { release() }
  }

  private async buildSessionWithAccess(...[sessionId, parent, stateFields]: Parameters<SessionManager['buildSession']>): Promise<void> {
    if (parent?.index !== undefined) this.assertHistoryWritable(parent.id)
    const topicFields = parseTopicSessionFields(stateFields ?? {})
    const coordinator = sessionId === 'web:orchestrator' || stateFields?.agentType === 'orchestrator'
      || topicFields.sessionKind === 'orchestrator'
    if (coordinator && (sessionId !== 'web:orchestrator' || stateFields?.agentType !== 'orchestrator'
      || topicFields.sessionKind !== 'orchestrator' || (stateFields?.mode !== undefined && stateFields.mode !== 'session'))) {
      throw new Error('The Project orchestrator must use web:orchestrator, agentType orchestrator, and sessionKind orchestrator.')
    }
    if (topicFields.createdBySessionId) {
      const creator = this.sessionStates[topicFields.createdBySessionId]
      if (!creator || (this.deps.projectId && creator.projectId !== this.deps.projectId)) {
        throw new Error('Topic creator must belong to this project')
      }
      this.assertFolderAccess(topicFields.createdBySessionId)
    }
    const automation = parseAutomationSessionRef(stateFields?.automation)
    const initiativeId = parseInitiativeId({
      initiativeId: stateFields?.initiativeId ?? (parent ? this.sessionStates[parent.id]?.initiativeId : undefined),
    })
    if (initiativeId) this.assertInitiativeAccess(initiativeId)
    this.deps.assertSessionFolder?.({ sessionId, segmentIndex: 0, folderId: stateFields?.folderId, workdir: stateFields?.workdir })
    const existing = this.sessionStates[sessionId]
    if (existing) {
      throw new TypeError(
        `[session-manager] buildSession called for existing session "${sessionId}"`,
      )
    }

    if (this.deps.projectId) {
      const address = channelAddressFromSessionId(sessionId)
      if (address && address.projectId !== this.deps.projectId) throw new Error('Bot session project mismatch')
      for (const reference of [parent?.id, stateFields?.workspaceRoot, stateFields?.reportTo, stateFields?.parentSessionId]) {
        if (reference && !this.sessionStates[reference]) throw new Error('Session reference does not belong to this project')
        if (reference) this.assertFolderAccess(reference)
      }
      if (stateFields?.folderId && !this.deps.ownsFolder?.(stateFields.folderId)) throw new Error('Folder does not belong to this project')
      if (stateFields?.workdir && !this.deps.ownsWorkdir?.(stateFields.workdir)) throw new Error('Workdir does not belong to this project')
      const inherited = stateFields?.parentSessionId ? this.sessionStates[stateFields.parentSessionId] : undefined
      if (inherited?.folderId && stateFields?.folderId && stateFields.folderId !== inherited.folderId) {
        throw new Error('Child sessions cannot switch folders')
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
    const mode = stateFields?.mode ?? agent.defaultMode ?? 'session'
    if (mode !== 'session' && (topicFields.topic || topicFields.sessionKind)) throw new Error('Topic metadata requires mode=session')
    if (mode === 'session' && stateFields?.parentSessionId) {
      throw new Error('Long-lived session ownership is not allowed; use independent topic creation instead.')
    }
    const ownerId = mode === 'session' || stateFields?.parentSessionId === null ? undefined
      : stateFields?.parentSessionId ?? (parent?.index === undefined && stateFields !== undefined ? parent?.id : undefined)
    if (ownerId) this.assertCanCreateChild(ownerId, mode)
    if (mode === 'call' && (!ownerId || stateFields?.reportTo !== undefined)) {
      throw new Error('Calls require a permitted structural owner and cannot use report_to.')
    }

    const ts = new Date().toISOString()
    const physicalSessionId = newPhysicalSessionId(sessionId, 0, 2)

    const startEvent: SessionStartEvent = {
      sessionId,
      physicalIdVersion: 2,
      projectId: this.deps.projectId,
      ...topicFields,
      sessionKind: topicFields.sessionKind ?? (mode === 'session' && !automation ? 'topic' : undefined),
      previous_physical_id: null,
      timestamp: ts,
    }

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
      ownershipVersion: 2,
      physicalIdVersion: 2,
      projectId: this.deps.projectId,
      ...topicFields,
      sessionKind: topicFields.sessionKind ?? (mode === 'session' && !automation ? 'topic' : undefined),
      mode: stateFields?.mode ?? agent.defaultMode ?? 'session',
      automation,
      automationVersion: 1,
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
      initiativeId,
      folderId: stateFields?.folderId ?? parentState?.folderId,
      reportTo: mode === 'session' ? undefined : stateFields?.reportTo,
      originUser: stateFields?.originUser,
      description: stateFields?.description,
      preloadTools: stateFields?.preloadTools,
    }
    if (state.mode !== 'session') state.executionId = sessionId

    const settled = Promise.withResolvers<void>()
    const pending = ownerId ? this.ownedCreations.get(ownerId) ?? new Set<Promise<void>>() : undefined
    if (ownerId && pending) {
      pending.add(settled.promise)
      this.ownedCreations.set(ownerId, pending)
    }
    try {
      await this.ensureSessionDataDirectory(state)
      await this.store.createSessionLog(physicalSessionId, [startEvent])
      await this.store.saveState(sessionId, state)
      this.sessionStates[sessionId] = state
    } finally {
      settled.resolve()
      pending?.delete(settled.promise)
      if (ownerId && pending?.size === 0) this.ownedCreations.delete(ownerId)
    }
  }

  /**
   * Start a standalone session with a specific agent type.
   * Admission-only by default; one-shot callers can await terminal execution and
   * propagate cancellation with waitForCompletion. No transcript is inherited.
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
      { ...opts.locality, agentType: opts.agentType, model: opts.model, automation: opts.automation, mode: opts.mode },
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
    try {
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
    } catch (error) {
      const state = this.sessionStates[sessionId]
      state.executionStatus = opts.signal?.aborted ? 'cancelled' : 'failed'
      await this.saveState(sessionId, state)
      throw error
    }
    if (opts.waitForCompletion) {
      const session = this.sessions[sessionId]
      if (session) {
        const abort = () => session.cancel()
        opts.signal?.addEventListener('abort', abort, { once: true })
        if (opts.signal?.aborted) abort()
        try {
          opts.onAccepted?.(sessionId)
          await session.completion
        }
        finally { opts.signal?.removeEventListener('abort', abort) }
      } else opts.onAccepted?.(sessionId)
    } else opts.onAccepted?.(sessionId)

    console.info(
      `[session-manager] Started session ${sessionId} (${opts.agentType})`,
    )
    return sessionId
  }

  // ── Child session tracking (persisted on parent state) ─────────────

  /**
   * Record a child session ID on the parent session state.
   * Only temporary owned tasks/calls belong in this managed list.
   */
  async addChild(
    parentSessionId: string,
    childSessionId: string,
  ): Promise<void> {
    if (this.deps.projectId && (!this.sessionStates[parentSessionId] || !this.sessionStates[childSessionId])) {
      throw new Error('Child and parent must belong to this project')
    }
    const state = this.sessionStates[parentSessionId]
    if (!state) return
    if (delegationOwner(this.sessionStates[childSessionId]) !== parentSessionId) {
      throw new Error('Only owned temporary tasks/calls may be tracked as children')
    }
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
      if (!childState || delegationOwner(childState) !== parentSessionId) continue
      results.push({
        sessionId: childId,
        agentType: childState.agentType ?? 'sub',
        description: childState.description ?? '',
      })
    }
    return results
  }

  // ── Session config ─────────────────────────────────────────────────

  async updateTopicMetadata(sessionId: string, topic: TopicMetadata): Promise<void> {
    const next = parseTopicMetadata(topic)
    const previous = this.topicUpdates.get(sessionId) ?? Promise.resolve()
    const update = previous.catch(() => {}).then(() =>
      this.withStateCreation(sessionId, () => this.replaceTopicMetadata(sessionId, next)))
    this.topicUpdates.set(sessionId, update)
    try { await update }
    finally { if (this.topicUpdates.get(sessionId) === update) this.topicUpdates.delete(sessionId) }
  }

  private async replaceTopicMetadata(sessionId: string, next: TopicMetadata): Promise<void> {
    if (this.stopped) throw new Error('Session manager stopped')
    const release = this.acquireFolderAccess()
    try {
      const state = this.sessionStates[sessionId]
      if (!state) throw new Error('session_not_found')
      if (state.mode !== 'session' || state.sessionKind === 'orchestrator' || state.agentType === 'orchestrator'
        || state.sessionId === 'web:orchestrator' || state.automation) {
        throw new Error('Only independent topic sessions have editable topic metadata')
      }
      if (this.deleting.has(sessionId)) throw new Error('Session is being deleted')
      if (this.deps.projectId && state.projectId !== this.deps.projectId) throw new Error('Session project mismatch')
      this.assertFolderAccess(sessionId)
      await this.store.saveState(sessionId, { ...state, topic: next, sessionKind: 'topic' })
      state.topic = next
      state.sessionKind = 'topic'
      this.invalidateSystemPrompts()
    } finally { release() }
  }

  async renameSession(sessionId: string, value: string): Promise<string> {
    const name = parseSessionName(value)
    return this.withStateCreation(sessionId, async () => {
      const state = this.sessionStates[sessionId]
      if (!state) throw new Error('session_not_found')
      if (this.deps.projectId && state.projectId !== this.deps.projectId) throw new Error('Session project mismatch')
      await this.store.saveState(sessionId, { ...state, name })
      state.name = name
      this.deps.bus.emit('session.renamed', { sessionId })
      return name
    })
  }

  getSessionConfig(sessionId: string): SessionConfig {
    const state = this.sessionStates[sessionId]
    return state?.config ?? {}
  }

  async applySessionConfigPatch(
    sessionId: string,
    patch: SessionConfigPatch,
    create = false,
  ): Promise<void> {
    await this.withStateCreation(sessionId, async () => {
      const state = this.sessionStates[sessionId] ??
        (create ? await this.createMissingState(sessionId) : null)
      if (!state) throw new Error('session_not_found')
      const config = { ...state.config, ...patch.set }
      for (const key of patch.unset) delete config[key]
      const next = Object.keys(config).length ? config : undefined
      // Keep the active session's state reference, but only publish durable changes.
      await this.store.saveState(sessionId, { ...state, config: next })
      state.config = next
    })
  }

  async setSessionConfig(
    sessionId: string,
    patch: Partial<SessionConfig>,
  ): Promise<void> {
    if (!this.sessionStates[sessionId]) return
    await this.applySessionConfigPatch(sessionId, { set: patch, unset: [] })
  }

  async unsetSessionConfig(
    sessionId: string,
    key: keyof SessionConfig,
  ): Promise<void> {
    await this.withStateCreation(sessionId, async () => {
      const state = this.sessionStates[sessionId]
      if (!state?.config) return
      const config = { ...state.config }
      delete config[key]
      const next = Object.keys(config).length ? config : undefined
      await this.store.saveState(sessionId, { ...state, config: next })
      state.config = next
    })
  }

  async resetSessionConfig(sessionId: string): Promise<void> {
    await this.withStateCreation(sessionId, async () => {
      const state = this.sessionStates[sessionId]
      if (!state?.config) return
      await this.store.saveState(sessionId, { ...state, config: undefined })
      state.config = undefined
    })
  }

  // ── Deletion ──────────────────────────────────────────────────────

  /**
   * Delete a session and its owned children, retaining shared or ambiguous logs.
   *
   * @returns The list of session IDs that were deleted.
   */
  async deleteSession(sessionId: string): Promise<string[]> {
    await this.stateCreations.get(sessionId)?.catch(() => {})
    const deleted: string[] = []
    await this._deleteSessionRecursive(sessionId, deleted)
    return deleted
  }

  private async _deleteSessionRecursive(
    sessionId: string,
    deleted: string[],
  ): Promise<void> {
    const state = this.sessionStates[sessionId]
    if (!state || this.deleting.has(sessionId)) return
    this.deleting.add(sessionId)
    try {
      await this.deleteSessionState(sessionId, state, deleted)
    } finally {
      this.deleting.delete(sessionId)
    }
  }

  private async deleteSessionState(sessionId: string, state: SessionState, deleted: string[]): Promise<void> {
    await this.topicUpdates.get(sessionId)?.catch(() => {})
    this.yields.cancelSession(sessionId, 'Session deleted.')
    const call = this.calls.get(sessionId)
    if (call) {
      call.cancelled = true
      call.session?.cancel()
    }
    this.sessions[sessionId]?.stop()
    await this.preparations.get(sessionId)?.catch(() => {})
    const active = this.sessions[sessionId]
    active?.stop()
    await active?.completion
    await call?.settled
    await this.reporting.get(sessionId)?.catch(() => {})
    await Promise.all(this.ownedCreations.get(sessionId) ?? [])

    // The optional children index omits one-shot tasks/calls. Persisted ownership
    // is authoritative; drain creators and final receipts before removing traces.
    for (const child of Object.values(this.sessionStates)) {
      if (delegationOwner(child) === sessionId) await this._deleteSessionRecursive(child.sessionId, deleted)
    }

    // Ephemeral children may not be in state.children, but cannot keep waiting
    // or resume a provider call after their decision recipient is deleted.
    for (const [id, child] of Object.entries(this.sessions)) {
      const request = this.yields.get(id)
      if (delegationOwner(this.sessionStates[id]) && request?.recipient.kind === 'parent' && request.recipient.sessionId === sessionId) child.cancel()
    }

    delete this.sessions[sessionId]

    // Truncated legacy addresses cannot prove exclusive ownership, even after the last owner is removed.
    const retainedHistory = hasTruncatedLegacyHistory(state) || Object.values(this.sessionStates).some(other =>
      other.sessionId !== sessionId && (
        (other.parent?.id === sessionId && other.parent?.index !== undefined)
        || physicalSessionId(other, 0) === physicalSessionId(state, 0)))
    for (let i = 0; !retainedHistory && i <= state.segmentIndex; i++) {
      await this.store.deleteSessionLog(physicalSessionId(state, i))
    }

    await this.store.deleteState(sessionId)

    // Remove from in-memory cache
    delete this.sessionStates[sessionId]
    this.deps.promptCaptures?.deleteSession(sessionId)
    this.acceptedInputs.delete(sessionId)

    deleted.push(sessionId)
  }

  // ── Queries (state, history, tools, context) ───────────────────────

  getSessionState(sessionId: string): SessionState | null {
    return this.sessionStates[sessionId] ?? null
  }

  assertInitiativeAccess(initiativeId: string): void {
    parseInitiativeId({ initiativeId })
    if (this.deps.hasInitiative && !this.deps.hasInitiative(initiativeId)) {
      throw new Error('Initiative does not belong to this Project.')
    }
  }

  async getSessionDetails(sessionId: string, physicalId?: string) {
    const state = this.getSessionState(sessionId)
    if (!state) return null
    const segments = Array.from({ length: state.segmentIndex + 1 }, (_, index) =>
      physicalSessionId(state, index))
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
    try { this.assertFolderAccess(sessionId) }
    catch { workdir = { available: false, workdir: workdir.workdir, reason: 'capability-revoked' } }
    const remote = workdir.workdir.nodeId !== LOCAL_NODE_ID
    const node = this.getNodeInventory()?.nodes.find(node =>
      remote ? node.nodeId === workdir.workdir.nodeId : node.role === 'main')
    const capability = node?.capabilities.find(capability =>
      capability.capabilityId === workdir.workdir.capabilityId && capability.kind === 'workdir')
    const model = state.config?.model ?? this.deps.getLlmRuntimeConfig?.().model
    const window = model ? this.deps.getKnownContextWindow?.(model) : null
    return {
      ...(state.projectId ? { projectId: state.projectId } : {}),
      ...parseTopicSessionFields(state),
      sessionId,
      name: state.name ?? state.topic?.title ?? (state.sessionKind === 'orchestrator' ? 'Project coordination' : await this.getFirstUserMessage(sessionId)),
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

  /** Start a fresh context without summarizing, deleting history, or changing identity. */
  clearSessionContext(sessionId: string): Promise<'cleared' | 'busy' | 'unsupported'> {
    return this.withSessionPreparation(sessionId, () => this.withStateCreation(sessionId, async () => {
      this.assertFolderAccess(sessionId)
      this.assertHistoryWritable(sessionId)
      const state = this.sessionStates[sessionId]
      if (!state) throw new Error('Session not found')
      if (state.mode !== 'session' || this.isManagedConversation(sessionId)) return 'unsupported'
      const session = this.sessions[sessionId]
      if (session && (!(session instanceof Session) || !session.quiescent)) return 'busy'
      await this.deps.agentTypes.refresh(state.agentType ?? 'general')
      // A manual compaction/sleep may have started while the definition was read.
      if (session && (!(session instanceof Session) || !session.quiescent)) return 'busy'
      session?.stop()
      await session?.completion
      if (this.stopped || this.deleting.has(sessionId)) throw new Error('Session is stopping')
      this.assertFolderAccess(sessionId)
      const timestamp = new Date().toISOString()
      const next: SessionState = {
        ...state, segmentIndex: state.segmentIndex + 1, contextResetAt: timestamp,
        lastKnownTokens: 0, lastActivityAt: timestamp, executionStatus: 'pending',
        recovery: undefined, preloadTools: undefined,
      }
      await this.store.createSessionLog(physicalSessionId(next), [{
        sessionId, physicalIdVersion: next.physicalIdVersion,
        previous_physical_id: physicalSessionId(state), timestamp, context_reset: true,
      }])
      // Publish the new pointer only after persistence succeeds; failure keeps old history usable.
      try {
        await this.store.saveState(sessionId, next)
      } catch (error) {
        try { await this.store.deleteSessionLog(physicalSessionId(next)) }
        catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Failed to persist and clean up the cleared context') }
        throw error
      }
      Object.assign(state, next)
      this.acceptedInputs.delete(sessionId)
      return 'cleared'
    }))
  }

  requestCompact(sessionId: string, llm: LlmRuntimeConfig): boolean {
    this.assertFolderAccess(sessionId)
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
    Pick<SessionState, 'projectId' | 'sessionId' | 'name' | 'segmentIndex' | 'lastActivityAt' | 'folderId' | 'sessionKind' | 'topic' | 'createdBySessionId'
      | 'initiativeId' | 'automation' | 'agentType' | 'mode' | 'executionStatus'>
  > {
    return Object.values(this.sessionStates).map((s) => ({
      ...(s.projectId ? { projectId: s.projectId } : {}),
      sessionId: s.sessionId,
      ...(s.name !== undefined ? { name: s.name } : {}),
      segmentIndex: s.segmentIndex,
      lastActivityAt: s.lastActivityAt,
      folderId: s.folderId,
      initiativeId: s.initiativeId,
      automation: s.automation,
      agentType: s.agentType,
      mode: s.mode,
      executionStatus: s.executionStatus,
      ...parseTopicSessionFields(s),
    }))
  }

  /** Get the first user message content for a session (used as title). */
  async getFirstUserMessage(sessionId: string): Promise<string | null> {
    const state = this.sessionStates[sessionId]
    if (!state) return null
    const physicalId = physicalSessionId(state, 0)
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
        const forkInfo = state.segmentIndex === 0 && state.parent?.physicalId && state.parent.index
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
    const conversationPolicy = sessionId ? this.deps.conversationPolicies?.resolve(sessionId) : undefined
    if (conversationPolicy && sessionId) {
      return this.deps.conversationPolicies!.tools(conversationPolicy, sessionId).getDefinitions().map(tool => tool.function)
    }
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
    const state = sessionId ? this.sessionStates[sessionId] : undefined
    const coordinator = state?.sessionKind === 'orchestrator' || state?.agentType === 'orchestrator'
    const policy = coordinator
      ? this.resolveAgentTypeTools(state?.agentType, state?.sessionKind)
      : behaviorOverride ?? (state ? this.resolveAgentTypeTools(state.agentType, state.sessionKind) : {})
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
      preview?: boolean
    },
  ): Promise<{
    systemPrompt: string
    source: 'active-history' | 'preview'
    sections?: import('../agent/context/builder.ts').SystemPromptSection[]
    tools: Array<{ name: string; description: string; parameters: unknown }>
  }> {
    if (opts.sessionId) this.assertFolderAccess(opts.sessionId)
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
    const conversationPolicy = this.deps.conversationPolicies?.resolve(sessionId)
    if (active && !opts.preview) {
      return {
        source: 'active-history',
        systemPrompt: extractSystemPrompt(active.history[0]),
        tools: this.getToolDefinitions(sessionId),
      }
    }

    if (conversationPolicy) {
      return {
        source: 'preview', ...this.deps.conversationPolicies!.prompt(conversationPolicy, sessionId),
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
      projectId: this.deps.projectId,
      behavior,
      channel,
      chatId,
      channelAddress: channelAddressFromSessionId(sessionId),
      sessionId,
      defaultExecShell: behavior.defaultShell ?? this.deps.defaultExecShell,
      agent: agentType,
      mode: state?.mode ?? agentType.defaultMode,
      parentSessionId: delegationOwner(state),
      initiativeId: state?.initiativeId,
      contextResetAt: state?.contextResetAt,
      ...sessionPromptLocality(state),
    }

    const { systemPrompt, sections } = await this.deps.context.buildSystemPromptDetails(promptCtx)
    const { allowedTools, blockedTools } = this.resolveAgentTypeTools(
      agentTypeName,
      state?.sessionKind,
    )
    const tools = this.getToolDefinitions(sessionId, {
      allowedTools,
      blockedTools,
    })

    return { source: 'preview', systemPrompt, sections, tools }
  }

  // ── Private helpers ────────────────────────────────────────────────

  private resolveAgentTypeTools(agentTypeName?: string, sessionKind?: SessionState['sessionKind']): {
    agentType: AgentTypeDefinition
    allowedTools?: string[]
    blockedTools?: string[]
  } {
    const name = agentTypeName ?? 'general'
    const resolved = this.deps.agentTypes.resolve(name) ??
      this.deps.agentTypes.resolve('general')!

    if (name === 'orchestrator' || sessionKind === 'orchestrator') {
      const allowedTools = ['read', 'search', 'topic', 'message', 'initiative', 'project_config', 'authoring_change']
      return {
        agentType: { ...resolved, allowedTools, blockedTools: undefined },
        allowedTools,
      }
    }

    if (resolved.allowedTools !== undefined) {
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
    if (this.deps.projectId) {
      if (state.projectId && state.projectId !== this.deps.projectId) throw new Error('Session project mismatch')
      state.projectId = this.deps.projectId
    }
    this.sessionStates[sessionId] = state
    await this.store.saveState(sessionId, state)
  }

  private async getOrCreateState(
    sessionId: string,
  ): Promise<SessionState> {
    return this.withStateCreation(sessionId, () => this.createMissingState(sessionId))
  }

  /** Commands need durable identity and local session data, but no model loop. */
  async prepareCommandSession(sessionId: string): Promise<void> {
    this.assertHistoryWritable(sessionId)
    await this.withStateCreation(sessionId, async () => {
      const state = await this.createMissingState(sessionId)
      await this.ensureSessionDataDirectory(state)
    })
  }

  async recordCommandResult(sessionId: string, receipt: CommandReceipt): Promise<void> {
    if (!isCommandReceipt(receipt)) throw new TypeError('Invalid command receipt')
    await this.withStateCreation(sessionId, async () => {
      this.assertHistoryWritable(sessionId)
      const state = this.sessionStates[sessionId]
      if (!state) throw new Error('Command conversation no longer exists')
      await this.store.appendRawEvents(SessionManager.currentPhysicalId(state), [{
        event: 'command_result', receipt,
      }])
    })
  }

  /** Receipts belong to this segment, not inherited/forked model history. */
  async getCommandResults(sessionId: string, physicalId?: string): Promise<CommandReceipt[]> {
    const state = this.sessionStates[sessionId]
    const id = physicalId ?? (state ? SessionManager.currentPhysicalId(state) : undefined)
    if (!id) return []
    const receipts = new Map<string, CommandReceipt>()
    for await (const record of this.store.readSessionLog(id)) {
      if (record.event !== 'command_result') continue
      if (!isCommandReceipt(record.receipt)) throw new TypeError('Invalid persisted command receipt')
      receipts.set(record.receipt.id, record.receipt)
      if (receipts.size > MAX_HISTORY) receipts.delete(receipts.keys().next().value!)
    }
    return [...receipts.values()]
  }

  private async ensureSessionDataDirectory(state: SessionState): Promise<void> {
    const { sessionDataDir } = resolveSessionLocations(
      this.workspace, state, undefined, this.workdirCapabilityLookup,
    )
    // Only Main-owned session data; never create a folder or remote display path.
    await mkdir(sessionDataDir, { recursive: true })
  }

  private async withStateCreation<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.stateCreations.get(sessionId) ?? Promise.resolve()
    const pending = previous.catch(() => {}).then(() => {
      if (this.deleting.has(sessionId)) throw new Error('Session is being deleted')
      return operation()
    })
    this.stateCreations.set(sessionId, pending)
    try { return await pending }
    finally { if (this.stateCreations.get(sessionId) === pending) this.stateCreations.delete(sessionId) }
  }

  private async createMissingState(sessionId: string): Promise<SessionState> {
    const address = channelAddressFromSessionId(sessionId)
    if (this.deps.projectId && address && address.projectId !== this.deps.projectId) throw new Error('Bot session project mismatch')
    const existing = this.sessionStates[sessionId]
    if (existing) return existing
    if (sessionId === 'web:orchestrator') throw new Error('The Project orchestrator must be created through its canonical configuration')

    const ts = new Date().toISOString()
    const physicalSessionId = newPhysicalSessionId(sessionId, 0, 2)
    const startEvent: SessionStartEvent = {
      sessionId,
      physicalIdVersion: 2,
      previous_physical_id: null,
      timestamp: ts,
    }

    await this.store.createSessionLog(physicalSessionId, [startEvent])

    const state: SessionState = {
      ownershipVersion: 2,
      physicalIdVersion: 2,
      ...(this.deps.projectId ? { projectId: this.deps.projectId } : {}),
      sessionId,
      segmentIndex: 0,
      mode: 'session',
      sessionKind: 'topic',
      parentSessionId: null,
      executionStatus: 'pending',
      automationVersion: 1,
    }
    await this.ensureSessionDataDirectory(state)
    await this.store.saveState(sessionId, state)
    this.sessionStates[sessionId] = state

    return state
  }

  private async prepareSessionContext(input: SessionInput, sessionId: string) {
    this.assertHistoryWritable(sessionId)
    const msg = inputContext(sessionId, input)
    const state = this.sessionStates[sessionId] ??
      await this.getOrCreateState(sessionId)
    const behavior = state.config ?? {}

    const conversationPolicy = this.deps.conversationPolicies?.resolve(sessionId)
    const { agentType: resolvedAgentType, allowedTools, blockedTools } = conversationPolicy
      ? { agentType: conversationPolicy.agent, allowedTools: conversationPolicy.agent.allowedTools ?? [], blockedTools: undefined }
      : this.resolveAgentTypeTools(state.agentType, state.sessionKind)

    const promptCtx: SessionPromptContext = {
      projectId: this.deps.projectId,
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
      admin: conversationPolicy ? false : msg.admin,
      defaultExecShell: behavior.defaultShell ?? this.deps.defaultExecShell,
      agent: resolvedAgentType,
      mode: state.mode,
      parentSessionId: delegationOwner(state),
      initiativeId: state.initiativeId,
      contextResetAt: state.contextResetAt,
      ...sessionPromptLocality(state),
    }
    const systemPrompt = conversationPolicy
      ? this.deps.conversationPolicies!.prompt(conversationPolicy, sessionId).systemPrompt
      : await this.deps.context.buildSystemPrompt(promptCtx)

    // Execution must retain unfinished tool calls; display/fork sanitization
    // would discard the very batch that Continue needs to finish.
    const continuing = input.kind === 'control' && (input.command.type === 'resume' || input.command.type === 'retry')
    const history = continuing
      ? await this.parseSessionLog(
        SessionManager.currentPhysicalId(state),
        undefined,
        state.segmentIndex === 0 && state.parent?.physicalId && state.parent.index != null
          ? { parentPhysicalId: state.parent.physicalId, forkAt: state.parent.index }
          : undefined,
      )
      : (await this.getHistory(sessionId)).messages

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...history,
    ]

    const sessionTools = conversationPolicy
      ? this.deps.conversationPolicies!.tools(conversationPolicy, sessionId)
      : this.calls.get(sessionId)?.tools ?? new SessionTools(
      this.deps.tools,
      this.deps.workspace,
      allowedTools,
      blockedTools,
      resolvedAgentType.allowedModules,
    )
    if (!conversationPolicy && !this.calls.has(sessionId)) sessionTools.setExecutionScope(state.mode ?? 'session', this.getAllowedSubagentModes(sessionId))

    // Import tools specified by parent (e.g., subagent preload_tools param)
    if (state.preloadTools && Object.keys(state.preloadTools).length > 0) {
      for (const [toolName, toolArgs] of Object.entries(state.preloadTools)) {
        try {
          const importTool = sessionTools.has('invoke_tool')
            ? this.deps.toolLoader ?? sessionTools.get('import_tool') as ImportTool | undefined
            : undefined
          if (importTool) {
            const imported = await importTool.importSource({
              source: `v:tools/${toolName}`,
              args: toolArgs,
            }, sessionTools)
            if (imported.startsWith('Error') || imported.startsWith('Unknown tool')) {
              console.warn(`[session-manager] Could not preload tool "${toolName}": ${imported}`)
              continue
            }
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
      conversationPolicy,
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
      // Display-only receipts must not shift existing model-history fork offsets.
      if (parsed.event === 'command_result') continue
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
