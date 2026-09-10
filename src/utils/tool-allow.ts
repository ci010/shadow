import type { AgentTypeDefinition } from '../agent/agent-types/types.ts'

export function isToolAllowed(agentType: Pick<AgentTypeDefinition, 'allowedTools' | 'blockedTools'>,
  toolName: string, optIn = false
): boolean {
  if (agentType.allowedTools) {
    return agentType.allowedTools.includes(toolName)
  }
  if (optIn) {
    return false
  }
  if (agentType.blockedTools) {
    return !agentType.blockedTools.includes(toolName)
  }
  return true
}