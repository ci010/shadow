import type { ReasoningEffort, ThinkingConfig } from '../llm-config.ts'
import type { ExecutionMode } from '../../sessions/execution-mode.ts'

export interface AgentTypeDefinition {
  /** Unique name: 'general', 'sub', 'explore', 'eval', 'plan', or user-defined */
  name: string
  /** One-line description for LLM context / tooling */
  description: string
  /** Full system prompt body (markdown) */
  prompt: string
  /** Original loaded AGENT.md, for read-only inspection. */
  definitionMarkdown?: string
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
  /** Runtime provenance, assigned by the publisher, never parsed from AGENT.md. */
  runtimeOrigin?: { kind: 'channel-integration' | 'bot'; id: string; revision: string }
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

/** Historical IDs still resolve for persisted sessions, bindings and draft reads. */
export function isRetiredBuiltinGeneral(type: Pick<AgentTypeDefinition, 'source' | 'name'>): boolean {
  return type.source === 'builtin' && (type.name === 'general-v2' || type.name === 'general-legacy')
}

/** User-selectable root roles stay out of automatic delegation suggestions. */
export function isSelectableAgentType(type: Pick<AgentTypeDefinition, 'name' | 'root' | 'source'>): boolean {
  return !isRetiredBuiltinGeneral(type) && (!type.root || type.name === 'general')
}
