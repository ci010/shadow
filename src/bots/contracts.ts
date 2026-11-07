import { z } from 'zod'
import type { AgentTypeDefinition } from '../agent/types/types.ts'
import type { ChannelAddress } from '../bus/events.ts'
import { CapabilityGrantSchema, ResourceName } from '../execution/grant-contract.ts'

const identifier = z.string().min(1).max(512).regex(/^[^\x00-\x1f\x7f]+$/)

export const ConversationBindingSchema = z.object({
  botInstanceId: identifier, platform: z.enum(['qq', 'discord', 'feishu']),
  conversationId: identifier, enabled: z.boolean().default(true),
  agent: ResourceName, skills: z.array(ResourceName).max(32).default([]),
  allowFrom: z.array(identifier).max(1000).optional(),
  readFolders: z.array(identifier).max(32).default([]),
  parameters: z.record(z.unknown()).default({}),
  grants: z.array(CapabilityGrantSchema).max(32).default([]),
}).strict()
export type ConversationBinding = z.infer<typeof ConversationBindingSchema>

/** Model-visible declaration only; source and execution stay in the frozen BOT package. */
export interface PolicyTool {
  name: string
  description: string
  parameters: Record<string, unknown>
  imports: readonly string[]
}
export type PublishedAgent = AgentTypeDefinition
export interface ResolvedConversationPolicy {
  generation?: string
  revision: string
  binding: ConversationBinding
  agent: PublishedAgent
  skillPrompts: Array<{ name: string; content: string }>
  tools: PolicyTool[]
}

export function conversationBindingKey(address: Pick<ChannelAddress, 'botInstanceId' | 'platform' | 'conversationId'>): string {
  return JSON.stringify([address.botInstanceId, address.platform, address.conversationId])
}
