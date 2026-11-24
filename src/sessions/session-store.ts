import type { WorkKickoffStamp } from '../initiatives/work-kickoff.ts'
import type { AgentPromptDraft } from '../agent/context/sub-override.ts'
import type { PromptVersion } from '../agent/context/prompt-version.ts'
import type { TaskRecord } from './task-record.ts'
import type { ChatMessage } from '../providers/provider.ts'
import { providerFailureKinds, type ProviderFailureKind } from '../providers/provider.ts'
import type { ReasoningEffort, ThinkingConfig } from '../agent/llm-config.ts'
import type { ExecShell } from '../tools/shell.ts'
import type { WorkdirRefV2 } from './locality.ts'
import type { YieldPolicy } from './yield-contract.ts'
import type { ExecutionMode } from './execution-mode.ts'
import type { AutomationSessionRef } from '../cron/contracts.ts'
import type { WorkPolicy } from './work-policy.ts'

export type ExecutionStatus = 'pending' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled'

export class ContextResetMetadataError extends Error {}
export class DecisionOwnerMetadataError extends Error {}

export function parseDecisionOwner(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 512) {
    throw new DecisionOwnerMetadataError('Invalid decision reporting owner')
  }
  return value
}

export function parseContextResetAt(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value) {
    throw new ContextResetMetadataError('Invalid session context reset timestamp')
  }
  return value
}

export interface SessionRecovery {
  id: string
  reason: 'stopped' | 'interrupted' | 'failed'
  /** Audience of the unfinished turn; absent on older recoveries. */
  userInvolved?: boolean
  /** Unfinished persisted calls; continuing may replay tools without durable reconciliation. */
  pendingToolCalls?: number
  providerFailure?: ProviderFailureKind
}

export function parseSessionRecovery(value: unknown): SessionRecovery | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string' || !value.id
    || !('reason' in value) || (value.reason !== 'stopped' && value.reason !== 'interrupted' && value.reason !== 'failed')) {
    throw new TypeError('Invalid session recovery metadata')
  }
  const userInvolved = 'userInvolved' in value ? value.userInvolved : undefined
  if ('userInvolved' in value && typeof userInvolved !== 'boolean') {
    throw new TypeError('Invalid session recovery metadata')
  }
  const pendingToolCalls = 'pendingToolCalls' in value ? value.pendingToolCalls : undefined
  if (pendingToolCalls !== undefined && (typeof pendingToolCalls !== 'number'
    || !Number.isSafeInteger(pendingToolCalls) || pendingToolCalls < 0)) throw new TypeError('Invalid session recovery metadata')
  const providerFailure = 'providerFailure' in value ? value.providerFailure : undefined
  if (providerFailure !== undefined && !providerFailureKinds.some(kind => kind === providerFailure)) {
    throw new TypeError('Invalid session recovery provider failure')
  }
  return { id: value.id, reason: value.reason,
    ...(providerFailure !== undefined ? { providerFailure: providerFailure as ProviderFailureKind } : {}),
    ...(typeof userInvolved === 'boolean' ? { userInvolved } : {}),
    ...(typeof pendingToolCalls === 'number' ? { pendingToolCalls } : {}) }
}

// ── Shared types ────────────────────────────────────────────────────────────

/**
 * Session config — user-configurable settings persisted on SessionState.prototype.
 * Can be changed per-session via `/config`.
 */
export interface SessionConfig {
  triggerMode?: 'mention' | 'all'
  model?: string
  temperature?: number
  maxTokens?: number
  defaultShell?: ExecShell
  /** DeepSeek thinking mode toggle */
  thinking?: ThinkingConfig
  /** DeepSeek reasoning effort level */
  contextWindow?: number
  reasoningEffort?: ReasoningEffort
  /** Omitted inherits global policy; null timeout waits indefinitely. */
  yield?: YieldPolicy
}

export interface SessionParent {
  /** Logical session key of the parent session (e.g. "discord:123") */
  id: string
  /** Physical session ID of the parent session log (for lineage tracking). Resolved by fork() if not provided. */
  physicalId?: string
  /** Raw record index in the parent session log up to which the fork inherits context */
  index?: number
}

export interface ArchivedStateQuery {
  projectId?: string
  jobId?: string
  parentId?: string
  executionKey?: string
  from?: string
  before?: string
  offset?: number
  limit?: number
}
export interface ConversationArchiveSummary {
  sessionId: string
  projectId?: string
  topic?: string
  name?: string
  archivedAt: string
  lastActivityAt?: string
  segmentIndex: number
  recordCount: number
  /** Uncompressed canonical raw JSON bytes including record separators. */
  byteLength: number
}
export interface ConversationArchiveQuery { projectId?: string; limit?: number; cursor?: string }
export interface ConversationArchivePage { items: ConversationArchiveSummary[]; nextCursor?: string }
export interface ConversationArchiveRange { nextOffset?: number; records: Record<string, unknown>[]; total: number }
export interface ArchiveReference { projectId: string; folderId?: string; workdir?: WorkdirRefV2 }

export interface SessionFollowUp {
  next: string
  after: number
}

export interface SessionFollowUpState {
  dueAt: number
  wakes: number
  startedAt: number
  phase: 'self_check' | 'follow_up'
  inputId: string
}

/** Validate persisted recovery data without coercion or inventing defaults. */
export function parseSessionFollowUpState(value: unknown): SessionFollowUpState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid session follow-up state')
  const { dueAt, wakes, startedAt, phase, inputId } = value as Record<string, unknown>
  const nonnegativeInteger = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0
  if (!nonnegativeInteger(dueAt) || !nonnegativeInteger(wakes) || !nonnegativeInteger(startedAt) ||
    (phase !== 'self_check' && phase !== 'follow_up') || typeof inputId !== 'string' || !inputId.trim()) {
    throw new TypeError('Invalid session follow-up state')
  }
  return { dueAt, wakes, startedAt, phase, inputId }
}

export interface SessionState {
  /** Assembly pin, independent of definition ID and draft revision. */
  promptVersion?: PromptVersion
  promptDraft?: AgentPromptDraft
  subDraft?: { revision: string; markdown: string }
  /** Most recent inference settings sent by a task or call, not current defaults. */
  executionInference?: import('../agent/llm-config.ts').ExecutionInference
  /** Current non-Discord execution activation; changes start a fresh model context. */
  serviceGeneration?: string
  /** Passive source evidence; never a BOT binding or an execution grant. */
  /** Offline identity migration only; missing origin never grants admission. */
  channelIdentityMigration?: 1
  channelSource?: import('../channels/passive-contract.ts').ChannelSource
  /** Host-created durable isolated Work executor, persisted by both stores. */
  automaticWork?: import('../cron/work-dispatch-contract.ts').AutomaticWorkSession
  /** Human input admission time, independent of assistant/event activity. Legacy unknown is protected. */
  lastUserMessageAt?: string
  /** Closeout receipt: legacy live entries are reversible; cold archive snapshots are immutable. */
  retirement?: import('./retirement-contract.ts').RetirementReceipt
  /** Future-only opt-in. Never inferred from historical agent names or addresses. */
  statePersistence?: import('./fresh-automation-state.ts').FreshAutomationPolicy
  /** Durable caller-side outcome barrier; execution completion alone is insufficient. */
  automationCallerSettled?: boolean
  /** A persisted scope reference, never a live authorization lease. */
  channelBoundary?: import('../channels/integration-contract.ts').ChannelBoundary
  /** Execution enforcement, independent of Work tool availability. Absent on legacy records. */
  workPolicy?: WorkPolicy
  /** Legacy display title; read fallback when canonical topic is absent. */
  name?: string
  /** Optional current step. Never inferred from legacy description. */
  focus?: string
  /** Explicit null opts out; absence leaves the default policy in effect. */
  followUp?: SessionFollowUp | null
  /** Internal recovery data; never exposed through self metadata. */
  sessionFollowUp?: SessionFollowUpState
  /** Explicit current-goal completion; independent of inferred runtime activity. Absent means open. */
  completed?: boolean
  /** Host-stamped self completion freshness; absent on legacy records. Not a public self patch. */
  completedAt?: string
  /** Legacy background summary title; explicit names and topic titles always take precedence. */
  generatedTitle?: string
  /** Last known platform conversation name; never overrides a user-selected name. */
  chatName?: string
  sessionKind?: 'topic'
  /** Stable overarching conversation title; current steps belong in focus. */
  topic?: string
  /** Creation provenance only; never lifecycle or directory ownership. */
  createdBySessionId?: string
  /** Immutable original creation request fingerprint for durable idempotency. */
  topicRequestHash?: string
  /** Human-selected reporting responsibility, not parenthood or answer authority. */
  decisionOwnerSessionId?: string
  /** Persisted v2: projectId is the runtime owner, folderId the directory resource. */
  ownershipVersion?: 2
  automation?: AutomationSessionRef
  /** Stops legacy address classification from being applied to newly created records. */
  automationVersion?: 1
  projectId?: string
  /** Frozen execution lifetime; absent only in legacy records. */
  mode?: ExecutionMode
  executionStatus?: ExecutionStatus
  /** Explicit user continuation is required; never replay this automatically. */
  recovery?: SessionRecovery
  executionId?: string
  /** Structural owner, independent of the historical fork snapshot. */
  parentSessionId?: string | null
  /** Stable tool invocation key, used to reject/reuse duplicate execution admissions. */
  executionKey?: string
  /** Native parent tool invocation, for linking a running execution before its receipt returns. */
  parentToolCallId?: string
  /** One-shot completion has been admitted to its recipient. */
  completionReported?: boolean
  /** Absent on legacy one-shot tasks and all calls/automation runs. */
  task?: TaskRecord
  /** Logical session key (e.g. "discord:123") */
  sessionId: string
  /** V2 hashes the complete logical ID. Absent retains legacy physical log addresses. */
  physicalIdVersion?: 2
  /** 0-based index of the current segment (incremented on compaction or explicit clear). */
  segmentIndex: number
  /** Excludes pre-clear transient memory from automatic prompt injection; files remain intact. */
  contextResetAt?: string
  /** ISO timestamp of the last user/assistant exchange. */
  lastActivityAt?: string
  /** Token count from the last known LLM response for this session. */
  lastKnownTokens?: number
  /** Session blueprint — user-configurable settings (model, temperature, etc.). */
  config?: SessionConfig
  /** Fork parent — present only when this session was created by forking. */
  parent?: SessionParent
  /**
   * Logical session id whose per-session working directory this session shares.
   * Set for temporary subagents so they read/write the same `cwd` (and its `alignment/`,
   * `tmp/`, etc.) as the agent that spawned them. Inherited through the spawn
   * chain so nested subagents all resolve to the root spawner's folder.
   * Also retained on migrated topics to preserve their historical data location;
   * it never conveys lifecycle ownership. New topics own their own directory.
   */
  workspaceRoot?: string
  /** Node-bound capability selecting the session's effective working directory. */
  workdir?: WorkdirRefV2
  /** Agent type name (e.g. 'general', 'reflector'). Set once at creation. */
  agentType?: string
  /** Canonical Work key for shared context; field name is internal. */
  initiativeId?: string
  /** Registered directory identity, independent of Work work context. */
  folderId?: string
  /** Prepared committed folder context, replayed as append-only history after restart. */
  workingContext?: string
  /** Subagent callback target session key (e.g. "discord:123"). Set once at creation. */
  reportTo?: string
  /** Display name of the user who triggered this session. Set once at creation. */
  originUser?: string
  /** Short description of this session's purpose. Set once at creation (subagents). */
  description?: string
  /** Session IDs of child (subagent) sessions spawned from this session. */
  children?: string[]
  /** Legacy session-only preloads restored through the internal loader; never installs configuration. */
  preloadTools?: Record<string, string[]>
}

export interface SessionStartEvent {
  previous_physical_id: string | null
  timestamp: string
  /** Compaction/handoff summary — present only on compacted session logs. */
  summary_context?: string
  [key: string]: unknown
}

export interface StoredMessage {
  /** Only the durable automatic kickoff drain may write this stamp. */
  work_kickoff?: WorkKickoffStamp
  /** Host provenance, assigned only when admitting direct user input. */
  direct_input?: { sessionId: string; id: string; text: string; at: string; profileSource?: import('../agent/identity.ts').ReflectionProfileSource }
  /** Atomic history-only channel input marker, scoped to this physical context. */
  channel_receipt?: boolean
  channel_input_id?: string
  role: string
  content: string | unknown[] | null
  /** Round-trippable reasoning (DeepSeek). Sent back on next turn. */
  reasoning_content?: string | null
  /** Display-only reasoning narration (Copilot, OpenAI). Never sent back. */
  reasoning_text?: string | null
  /** Provider-scoped continuity for assistant messages. */
  provider_state?: ChatMessage['provider_state']
  responseContext?: ChatMessage['responseContext']
  tool_calls?: ChatMessage['tool_calls']
  tool_call_id?: string
  name?: string
  timestamp: string
  /** Token usage for this LLM call. Only present on assistant messages. */
  usage?: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
}

// ── Store interface ─────────────────────────────────────────────────────────

export interface SessionStore {
  /** Ensure storage is ready (create dirs, tables, etc.) */
  init(): Promise<void>

  // ── State management ──────────────────────────────────────────────────

  archiveConversation?(state: SessionState): Promise<void>
  queryConversationArchives?(query?: ConversationArchiveQuery): Promise<ConversationArchivePage>
  isConversationArchived?(sessionId: string): Promise<boolean>
  /** Original raw-record coordinates. offset >= 0; limit is 1..1000. Missing physical IDs return null. */
  readArchivedLogRange?(physicalId: string, offset: number, limit: number): Promise<ConversationArchiveRange | null>
  readArchivedState?(sessionKey: string): Promise<SessionState | null>
  queryArchivedStates?(query?: ArchivedStateQuery): Promise<SessionState[]>
  /** Optional authoritative archive invalidation token, including external writes. */
  archiveRevision?(): Promise<string>
  countArchivedStates?(query?: ArchivedStateQuery): Promise<number>
  archiveFeatureStates?(projectId?: string): Promise<SessionState[]>
  archiveState?(state: SessionState): Promise<void>
  listArchiveReferences?(): Promise<ArchiveReference[]>
  getState(sessionKey: string): Promise<SessionState | null>
  saveState(sessionKey: string, state: SessionState): Promise<void>
  /** Load all session states into a record keyed by sessionId. */
  listAllStates(): Promise<Record<string, SessionState>>
  /** List all sessions with summary metadata. */
  listSessions(): Promise<
    Array<
      {
        sessionId: string
        name?: string
        segmentIndex: number
        lastActivityAt?: string
        folderId?: string
        sessionKind?: SessionState['sessionKind']
        topic?: string
        createdBySessionId?: string
      }
    >
  >
  deleteState(sessionKey: string): Promise<void>

  // ── Session log operations ────────────────────────────────────────────

  /** Read all raw records from a physical session log, in order. */
  readSessionLog(sessionId: string, options?: { strict?: boolean }): AsyncIterable<Record<string, unknown>>
  /** Append messages to a physical session log. */
  appendMessages(sessionId: string, messages: StoredMessage[]): Promise<void>
  /** Write the initial records for a new physical session (start + optional init). */
  createSessionLog(
    sessionId: string,
    events: Record<string, unknown>[],
  ): Promise<void>
  /** Append raw events (e.g. a single init event) to an existing session log. */
  appendRawEvents(
    sessionId: string,
    events: Record<string, unknown>[],
  ): Promise<void>
  /** Delete a physical session log. */
  deleteSessionLog(sessionId: string): Promise<void>

  /** Count the number of records in a physical session log. */
  countSessionLog(sessionId: string): Promise<number>

  /** Read only the first record of a physical session log (e.g. the start event). */
  readFirstRecord(sessionId: string): Promise<Record<string, unknown> | null>

  /** Optional cleanup/close (for SQLite). */
  close?(): void
}
