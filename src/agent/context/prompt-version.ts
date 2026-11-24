import type { AgentTypeDefinition } from '../types/types.ts'
import { BUILTIN_AGENT_VERSIONS } from '../types/versions.ts'

export type PromptVersion = 'v1' | 'v2'

export function isPromptVersion(value: unknown): value is PromptVersion {
  return value === 'v1' || value === 'v2'
}

export function builtinPromptDefault(saved?: PromptVersion) {
  const env = process.env.SHADOW_BUILTIN_PROMPT_VERSION
  if (env !== undefined) return { version: isPromptVersion(env) ? env : null, source: 'environment' } as const
  return { version: saved ?? 'v2', source: saved === undefined ? 'builtin' : 'app' } as const
}

/** Definition IDs remain independent of prompt assembly. This catalog also
 * records the historical fallback for sessions predating the assembly pin. */
export function resolvePrompt(agent: AgentTypeDefinition, options: { pinned?: PromptVersion; fresh?: boolean; defaultVersion?: PromptVersion } = {}) {
  const family = agent.source === 'builtin' && !agent.runtimeOrigin
    ? BUILTIN_AGENT_VERSIONS.find(entry => entry.versions.some(option => option.agentType === agent.name))
    : undefined
  const historicalGeneralV2 = agent.source === 'builtin' && !agent.runtimeOrigin && agent.name === 'general-v2'
  const historical = historicalGeneralV2 ? 'v2' : family?.versions.find(option => option.agentType === agent.name)?.version ?? 'v1'
  const configured = family && options.fresh && !options.pinned ? builtinPromptDefault(options.defaultVersion).version : historical
  if (configured === null) {
    throw new Error('SHADOW_BUILTIN_PROMPT_VERSION must be v1 or v2')
  }
  return {
    role: family?.role ?? (historicalGeneralV2 ? 'general' : agent.name),
    version: options.pinned ?? configured,
  } as const
}
