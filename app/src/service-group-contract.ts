import { isRecord } from './folders-sidebar.ts'

export interface ServiceGroup {
  sessionId?: string; botInstanceId: string; platform: string; conversationId: string; name?: string; botName: string
  enabled: boolean; agent?: string; pending: boolean; lastSeen: number
  messages: Array<{ id: string; sender: string; text: string; state: 'received' | 'not_enabled' | 'not_triggered'; receivedAt: number }>
}
export type ServiceGroupSource = { apiBase: string; projectId: string; active: boolean; group?: string; session?: string }

/** Validate the entire projection before the engine publishes either data or revision. */
export function parseServiceGroups(body: unknown): { groups: ServiceGroup[]; agents: string[]; revision: string } {
  if (!isRecord(body) || typeof body.revision !== 'string' || !Array.isArray(body.agents) || body.agents.some(agent => typeof agent !== 'string') || !Array.isArray(body.groups) || body.groups.length > 200) throw new Error('Invalid groups')
  for (const group of body.groups) {
    if (!isRecord(group) || (group.sessionId !== undefined && typeof group.sessionId !== 'string') || typeof group.botInstanceId !== 'string' || typeof group.conversationId !== 'string' || !['qq', 'feishu'].includes(String(group.platform)) || (group.name !== undefined && typeof group.name !== 'string') || (group.agent !== undefined && typeof group.agent !== 'string') || typeof group.botName !== 'string' || typeof group.enabled !== 'boolean' || typeof group.pending !== 'boolean' || typeof group.lastSeen !== 'number' || !Array.isArray(group.messages) || group.messages.length > 20) throw new Error('Invalid group')
    for (const message of group.messages) if (!isRecord(message) || typeof message.id !== 'string' || typeof message.sender !== 'string' || typeof message.text !== 'string' || message.text.length > 2000 || !['received', 'not_enabled', 'not_triggered'].includes(String(message.state)) || typeof message.receivedAt !== 'number') throw new Error('Invalid message')
  }
  return { groups: body.groups as unknown as ServiceGroup[], agents: body.agents as string[], revision: body.revision }
}

