import type { AgentTypeDefinition } from '../types/types.ts'
import { BUILTIN_AGENT_VERSIONS } from '../types/versions.ts'

export type PromptVersion = 'v1' | 'v2'

export function isPromptVersion(value: unknown): value is PromptVersion {
  return value === 'v1' || value === 'v2'
}

/** Definition IDs remain independent of prompt assembly. This catalog also
 * records the historical fallback for sessions predating the assembly pin. */
export function resolvePrompt(agent: AgentTypeDefinition, options: { pinned?: PromptVersion; fresh?: boolean } = {}) {
  const family = agent.source === 'builtin' && !agent.runtimeOrigin
    ? BUILTIN_AGENT_VERSIONS.find(entry => entry.versions.some(option => option.agentType === agent.name))
    : undefined
  const historical = family?.versions.find(option => option.agentType === agent.name)?.version ?? 'v1'
  const configured = process.env.SHADOW_BUILTIN_PROMPT_VERSION
  if (family && options.fresh && configured !== undefined && !isPromptVersion(configured)) {
    throw new Error('SHADOW_BUILTIN_PROMPT_VERSION must be v1 or v2')
  }
  return {
    role: family?.role ?? agent.name,
    version: options.pinned ?? (family && options.fresh ? (isPromptVersion(configured) ? configured : 'v2') : historical),
  } as const
}
