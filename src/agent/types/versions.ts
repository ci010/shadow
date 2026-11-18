/** Stable definition IDs are stored in session state. Never repoint a released ID. */
export const BUILTIN_AGENT_VERSIONS = [
  { role: 'general', defaultVersion: 'v2', versions: [{ version: 'v1', agentType: 'general' }, { version: 'v2', agentType: 'general-v2' }] },
  { role: 'explore', defaultVersion: 'v1', versions: [{ version: 'v1', agentType: 'explore' }] },
  { role: 'plan', defaultVersion: 'v1', versions: [{ version: 'v1', agentType: 'plan' }] },
  { role: 'sub', defaultVersion: 'v1', versions: [{ version: 'v1', agentType: 'sub' }] },
  { role: 'verify', defaultVersion: 'v1', versions: [{ version: 'v1', agentType: 'verify' }] },
] as const

export type BuiltinAgentRole = typeof BUILTIN_AGENT_VERSIONS[number]['role']
export type AgentVersionDefaults = Partial<Record<string, string>>

export function isBuiltinAgentVersion(role: string, version: string): boolean {
  return BUILTIN_AGENT_VERSIONS.some(entry => entry.role === role && entry.versions.some(option => option.version === version))
}

export function builtinAgentVersion(role: BuiltinAgentRole, defaults: AgentVersionDefaults = {}) {
  const entry = BUILTIN_AGENT_VERSIONS.find(candidate => candidate.role === role)!
  return (entry.versions.find(option => option.version === (defaults[role] ?? entry.defaultVersion))
    ?? entry.versions.find(option => option.version === entry.defaultVersion)!)
}

/** Specialist family names select the current default for a fresh delegation.
 * General remains exact when explicitly requested; qualified versions are exact. */
export function delegatedBuiltinSelection(name: string): { role: BuiltinAgentRole; agentType?: string } | undefined {
  const exact = BUILTIN_AGENT_VERSIONS.find(role => role.versions.some(option => name === `${role.role}@${option.version}`))
  if (exact) return { role: exact.role, agentType: exact.versions.find(option => name === `${exact.role}@${option.version}`)!.agentType }
  const family = BUILTIN_AGENT_VERSIONS.find(role => role.role !== 'general' && role.role === name)
  return family && { role: family.role }
}
