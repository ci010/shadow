import type { MessageContext } from '../bus/events.ts'
import type { ReasoningEffort, ThinkingConfig } from '../agent/llm-config.ts'
import type { Executor } from '../execution/executor.ts'
import type { ToolBridgeFactory } from '../script-runtime/bridge.ts'
import type { SessionTools } from './registry.ts'
import type { ExecShell } from './shell.ts'

export interface ExecutionContext extends MessageContext {
  memoryAccess?: import('../memory/contracts.ts').MemoryAccess
  projectId?: string
  evalBridge?: ToolBridgeFactory
  /** Host-only semantic capability, shared with this turn's inference budget. */
  infer?: import('../script-runtime/infer.ts').NodeInference
  inputSource?: 'user' | 'session' | 'event'
  /** Only a newly admitted, authenticated owner's direct message; never reconstructed on Retry/Continue. */
  workUserInput?: string
  /** Runtime-captured before inference, never supplied in model tool arguments. */
  workStamps?: import('../initiatives/work-contract.ts').WorkStamp[]
  /** Logical session ID (e.g. "discord:1234567890") */
  sessionId: string
  /** Physical session ID - the actual persisted session log identifier */
  physicalSessionId: string
  /**
   * Resolved working directory: a managed session folder or registered folder.
   * Filesystem/shell tools resolve ordinary relative paths here. Explicit
   * v:memory aliases and .tmp use Project Home; private uploads use explicit file references.
   * Falls back to the workspace root when unset.
   */
  cwd?: string
  /** Committed selected Folder identity, never an argument or cwd alias. */
  folderId?: string
  /** Host-only sole-call boundary; never available to nested scripts or parallel batches. */
  switchProjectFolder?: (prepared: { folderId: string; workdir: import('../sessions/locality.ts').WorkdirRefV1; content: string }) => Promise<string>
  /** Resolved identity for explicit-target file-change provenance. */
  fileChangeTarget?: { nodeId: string; capabilityId: string }
  /** Host-only, Project-authorized explicit tool target lookup. Never interprets display paths. */
  resolveToolTarget?: (nodeId: string, capabilityId: string) => Pick<ExecutionContext, 'cwd' | 'remoteWorkdir'>
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
  /** Host-only: run after this call result is persisted and emitted to outbound transport. */
  afterToolResultPublished?: (callback: () => void) => void
  /** Provider tool invocation ID, used for idempotent subagent admission. */
  toolCallId?: string
  /** Only the unfinished saved batch; remote shells reconcile instead of re-executing. */
  recoveringToolCall?: boolean
  /** Provider-facing tool name; nested script invocations are separate admissions. */
  toolCallName?: string
  /** Host-stamped nested script RPC; never accepted as a model tool argument. */
  scriptInvocation?: boolean
  /** Persist observed writes immediately, including nested script calls that outlive cancellation. */
  recordFileChange?: (change: import('../sessions/file-change-contract.ts').RecordedFileChange) => Promise<void>
  /** Read only this logical session's own recorded edits, across its physical segments. */
  readFileChange?: (id: string, signal: AbortSignal) => Promise<import('../sessions/file-change-contract.ts').RecordedFileChange | undefined>
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

export function currentOwnerWorkInput(context: ExecutionContext) {
  if (context.inputSource !== 'user' || context.admin !== true || context.isGroup
    || context.channel === 'a2a' || context.workUserInput === undefined) return undefined
  return { text: context.workUserInput, source: { sessionId: context.sessionId, physicalId: context.physicalSessionId,
    kind: 'user' as const, id: context.messageId } }
}
