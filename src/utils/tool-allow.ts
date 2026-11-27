import type { AgentTypeDefinition } from '../agent/types/types.ts'

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

/** Legacy subagent tool grants and blocks covered both delegation modes. */
export function isDelegationToolAllowed(agent: Pick<AgentTypeDefinition, 'allowedTools' | 'blockedTools'>,
  name: 'subagent' | 'call',
): boolean {
  if (name === 'call' && agent.allowedTools !== undefined) {
    return agent.allowedTools.includes('call') || agent.allowedTools.includes('subagent')
  }
  if (name === 'call' && agent.blockedTools?.includes('subagent')) return false
  return isToolAllowed(agent, name)
}
