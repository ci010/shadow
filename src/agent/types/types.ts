import type { ReasoningEffort, ThinkingConfig } from '../llm-config.ts'
import type { ExecutionMode } from '../../sessions/execution-mode.ts'

export interface AgentTypeDefinition {
  /** Unique name: 'general', 'sub', 'explore', 'eval', 'plan', or user-defined */
  name: string
  /** One-line description for LLM context / tooling */
  description: string
  /** Full system prompt body (markdown) */
  prompt: string
  /** Whitelist — if set, ONLY these tools are available (takes precedence over blockedTools) */
  allowedTools?: string[]
  /** Blacklist — these tools are removed from the full set */
  blockedTools?: string[]
  /** Optional ceiling for controlled skill-tool imports; never an OS sandbox. */
  allowedModules?: string[]
  /** Default invocation contract; callers may select another mode. */
  defaultMode: ExecutionMode
  /** 'builtin' or 'workspace' */
  source: 'builtin' | 'workspace'
  /** Directory path for workspace-defined types */
  dirPath?: string
  /** When false, skills context is not loaded for this agent type */
  skills?: boolean
  /** Include SOUL.md unless explicitly false, independently of execution mode. */
  soul?: boolean
  /** When true, agent is system-level and hidden from agent type summary */
  root?: boolean
  /** Model override */
  model?: string

  temperature?: number

  maxTokens?: number

  /** DeepSeek thinking mode toggle */
  thinking?: ThinkingConfig
  /** DeepSeek reasoning effort level */
  reasoningEffort?: ReasoningEffort
}
