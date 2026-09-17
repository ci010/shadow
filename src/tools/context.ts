import type { MessageContext } from '../bus/events.ts'
import type { ReasoningEffort, ThinkingConfig } from '../agent/llm-config.ts'
import type { Executor } from '../execution/executor.ts'
import type { ToolBridgeFactory } from '../script-runtime/bridge.ts'
import type { SessionTools } from './registry.ts'
import type { ExecShell } from './shell.ts'

export interface ExecutionContext extends MessageContext {
  projectId?: string
  evalBridge?: ToolBridgeFactory
  inputSource?: 'user' | 'session' | 'event'
  /** Logical session ID (e.g. "discord:1234567890") */
  sessionId: string
  /** Physical session ID - the actual persisted session log identifier */
  physicalSessionId: string
  /**
   * Resolved working directory: a managed session folder or registered folder.
   * Filesystem/shell tools resolve relative paths here. Shared resources such as
   * memory/ and SOUL.md stay under Main; private uploads use explicit file references.
   * Falls back to the workspace root when unset.
   */
  cwd?: string
  /** Capability-backed remote workspace. Local-only tools must reject this context. */
  remoteWorkdir?: {
    nodeId: string
    capabilityId: string
    executor: Executor
  }
  /** Session-scoped tool overlay - provides filtered, session-aware tool access. */
  tools: SessionTools
  /** Abort signal for the current turn - tools should check this for early cancellation. */
  signal: AbortSignal
  /** Provider tool invocation ID, used for idempotent subagent admission. */
  toolCallId?: string
  /** Provider-facing tool name; nested script invocations are separate admissions. */
  toolCallName?: string
  /** Resolved default shell for exec in this context, after global/session overrides. */
  defaultExecShell?: ExecShell
  /** LLM model override for this session. */
  model?: string
  /** LLM temperature override for this session. */
  temperature?: number
  /** LLM max tokens override for this session. */
  maxTokens?: number
  /** DeepSeek thinking mode toggle */
  thinking?: ThinkingConfig
  /** DeepSeek reasoning effort level */
  reasoningEffort?: ReasoningEffort
}
