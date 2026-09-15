import type { ChatMessage } from '../providers/provider.ts'
import type { ReasoningEffort, ThinkingConfig } from '../agent/llm-config.ts'
import type { ExecShell } from '../tools/shell.ts'
import type { WorkdirRefV1 } from './locality.ts'
import type { YieldPolicy } from './yield-contract.ts'
import type { ExecutionMode } from './execution-mode.ts'

export type ExecutionStatus = 'pending' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled'

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

export interface SessionState {
  organizationId?: string
  /** Frozen execution lifetime; absent only in legacy records. */
  mode?: ExecutionMode
  executionStatus?: ExecutionStatus
  executionId?: string
  /** Structural owner, independent of the historical fork snapshot. */
  parentSessionId?: string | null
  /** Stable tool invocation key, used to reject/reuse duplicate execution admissions. */
  executionKey?: string
  /** Native parent tool invocation, for linking a running execution before its receipt returns. */
  parentToolCallId?: string
  /** One-shot completion has been admitted to its recipient. */
  completionReported?: boolean
  /** Logical session key (e.g. "discord:123") */
  sessionId: string
  /** 0-based index of the current physical session segment (incremented on each compaction). */
  segmentIndex: number
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
   * Set for subagents so they read/write the same `cwd` (and its `alignment/`,
   * `tmp/`, etc.) as the agent that spawned them. Inherited through the spawn
   * chain so nested subagents all resolve to the root spawner's folder.
   * Undefined for top-level sessions — they own their own folder (keyed by id).
   */
  workspaceRoot?: string
  /** Node-bound capability selecting the session's effective working directory. */
  workdir?: WorkdirRefV1
  /** Agent type name (e.g. 'general', 'reflector'). Set once at creation. */
  agentType?: string
  /** Project name for shared context. Set once at creation. */
  projectName?: string
  /** Folder-project identity, independent of projectName planning notes. */
  projectId?: string
  /** Subagent callback target session key (e.g. "discord:123"). Set once at creation. */
  reportTo?: string
  /** Display name of the user who triggered this session. Set once at creation. */
  originUser?: string
  /** Short description of this session's purpose. Set once at creation (subagents). */
  description?: string
  /** Session IDs of child (subagent) sessions spawned from this session. */
  children?: string[]
  /** Tools to preload (via import_tool) when the session starts. Maps tool name → extra args. */
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
  role: string
  content: string | unknown[] | null
  /** Round-trippable reasoning (DeepSeek). Sent back on next turn. */
  reasoning_content?: string | null
  /** Display-only reasoning narration (Copilot, OpenAI). Never sent back. */
  reasoning_text?: string | null
  /** Provider-scoped continuity for assistant messages. */
  provider_state?: ChatMessage['provider_state']
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

  getState(sessionKey: string): Promise<SessionState | null>
  saveState(sessionKey: string, state: SessionState): Promise<void>
  /** Load all session states into a record keyed by sessionId. */
  listAllStates(): Promise<Record<string, SessionState>>
  /** List all sessions with summary metadata. */
  listSessions(): Promise<
    Array<
      {
        sessionId: string
        segmentIndex: number
        lastActivityAt?: string
        projectId?: string
      }
    >
  >
  deleteState(sessionKey: string): Promise<void>

  // ── Session log operations ────────────────────────────────────────────

  /** Read all raw records from a physical session log, in order. */
  readSessionLog(sessionId: string): AsyncIterable<Record<string, unknown>>
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
