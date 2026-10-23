import { z } from 'zod'
import type { AgentTypeDefinition } from '../agent/types/types.ts'
import type { ChannelAddress } from '../bus/events.ts'
import { ScriptImportsSchema } from '../script-runtime/module-policy.ts'

export const ResourceName = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/)
const identifier = z.string().min(1).max(512).regex(/^[^\x00-\x1f\x7f]+$/)
export const JsonSchema = z.record(z.unknown())
const route = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  path: z.string().min(1).max(1024).regex(/^\/[^?#\\]*$/),
  bodySchema: JsonSchema.optional(),
}).strict()

export const CapabilityGrantSchema = z.discriminatedUnion('kind', [
  z.object({
    id: ResourceName, kind: z.literal('http'),
    origin: z.string().url().refine(value => {
      const url = new URL(value)
      return url.protocol === 'https:' && url.origin === value && !url.username && !url.password
    }, 'HTTP grants require an HTTPS origin without credentials or a path.'),
    routes: z.array(route).min(1).max(32),
    credential: z.object({ secretRef: ResourceName, header: z.string().regex(/^[A-Za-z][A-Za-z0-9-]*$/), prefix: z.string().max(64).default('') }).strict().optional(),
  }).strict(),
  z.object({
    id: ResourceName, kind: z.literal('inbox'), sessionId: identifier,
  }).strict(),
])
export type CapabilityGrant = z.infer<typeof CapabilityGrantSchema>

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

export const ResourceBundleSchema = z.object({
  version: z.literal(1),
  files: z.record(z.string().max(512_000)),
  bindings: z.array(ConversationBindingSchema).max(1000),
}).strict()
export type ResourceBundle = z.infer<typeof ResourceBundleSchema>

export const AuthoredToolSchema = z.object({
  source: z.string().regex(/^[a-zA-Z0-9_-]+\.(?:js|ts)$/),
  description: z.string().min(1).max(2000),
  parameters: JsonSchema,
  imports: ScriptImportsSchema.default([]),
}).strict()
export type AuthoredToolDeclaration = z.infer<typeof AuthoredToolSchema>
export interface PublishedTool extends AuthoredToolDeclaration {
  name: string
  skill: string
  code: string
}
export interface ResourceSnapshot {
  revision: string
  bundle: ResourceBundle
}
export type PublishedAgent = AgentTypeDefinition
export interface ResolvedConversationPolicy {
  revision: string
  binding: ConversationBinding
  agent: PublishedAgent
  skillPrompts: Array<{ name: string; content: string }>
  tools: PublishedTool[]
}

export function conversationBindingKey(address: Pick<ChannelAddress, 'botInstanceId' | 'platform' | 'conversationId'>): string {
  return JSON.stringify([address.botInstanceId, address.platform, address.conversationId])
}
