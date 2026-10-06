import { z } from 'zod'
import { MemorySourceSchema, MemoryDomainSchema, MemoryResourceSchema } from '../memory/contracts.ts'

const snowflake = z.string().regex(/^[0-9]{1,20}$/)
const id = z.string().min(1).max(512)
export const integrationToolNames = [
  'read', 'search', 'memory_save', 'discord_history', 'discord_message_get',
  'channel_config', 'subagent', 'learned_skill', 'exec',
] as const
export const IntegrationAgentInputSchema = z.object({
  id: z.string().uuid(),
  name: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  displayName: z.string().trim().min(1).max(100),
  markdown: z.string().min(1).max(128_000),
  execution: z.enum(['restricted', 'trusted']),
  tools: z.array(z.enum(integrationToolNames)).max(32),
  readDomains: z.array(z.string().uuid()).max(32),
  skills: z.array(z.object({ name: z.string().trim().min(1).max(100), content: z.string().min(1).max(64_000) }).strict()).max(16),
}).strict()
export type IntegrationAgentInput = z.infer<typeof IntegrationAgentInputSchema>
export const IntegrationAgentSchema = IntegrationAgentInputSchema.extend({
  version: z.string().regex(/^[a-f0-9]{64}$/), publishedAt: z.string().datetime(),
  managementBindingId: z.string().uuid().optional(),
}).strict()
export type IntegrationAgent = z.infer<typeof IntegrationAgentSchema>

export const DiscordTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('channel'), guildId: snowflake, channelId: snowflake }).strict(),
  z.object({ kind: z.literal('dm'), userId: snowflake }).strict(),
])
export const DiscordBindingSchema = z.object({
  id: z.string().uuid(), botInstanceId: id, botUserId: snowflake,
  target: DiscordTargetSchema,
  enabled: z.boolean(), agentId: z.string().uuid(),
  trigger: z.enum(['mention', 'all']),
  participants: z.object({
    everyone: z.boolean(), userIds: z.array(snowflake).max(1000), roleIds: z.array(snowflake).max(250),
  }).strict(),
  tools: z.array(z.enum(integrationToolNames)).max(32),
  readDomains: z.array(z.string().uuid()).max(32),
  inheritThreads: z.boolean(),
  manage: z.boolean(),
  epochRevision: z.number().int().nonnegative().optional(),
}).strict()
export type DiscordBinding = z.infer<typeof DiscordBindingSchema>
export const IntegrationChangeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('agent.save'), agent: IntegrationAgentInputSchema }).strict(),
  z.object({ kind: z.literal('bindings.save'), bindings: z.array(DiscordBindingSchema).min(1).max(200) }).strict(),
  z.object({ kind: z.literal('domain.create'), name: z.string().trim().min(1).max(160), domainKind: z.enum(['shared', 'agent-private']) }).strict(),
  z.object({
    kind: z.literal('knowledge.publish'), domainId: z.string().uuid(),
    title: z.string().trim().min(1).max(200), content: z.string().min(1).max(256_000),
    sources: z.array(MemorySourceSchema).max(4096),
    resourceKind: z.enum(['note', 'skill']).optional(),
  }).strict(),
  z.object({ kind: z.literal('knowledge.revoke'), resourceId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal('domain.revoke'), domainId: z.string().uuid() }).strict(),
])
export type IntegrationChange = z.infer<typeof IntegrationChangeSchema>
export const integrationConfigurationGuide = {
  workflow: 'list -> directory/members -> propose with the exact list revision -> human review. schema only documents inputs; it grants no permission.',
  actions: {
    list: 'Read current revision, Agents, bindings and permitted domains. Owner chat also lists named Discord Bot connections, including unassigned ones; enabled is configuration, not proof of connectivity.',
    directory: 'Owner: {botId,guildId?,after?}. Discord manager: {guildId?,after?}, always its own Bot. Omit guildId to discover named servers, then supply a returned guild ID for channels/roles. Use guildCursor as after for another server page.',
    members: '{guildId,query}, plus botId in owner chat. Search a name in a mutual server; at most 25 results. Discord has no global person-name search. Use returned IDs, not guessed IDs.',
    resource: 'Owner only: {resourceId}. Read an exact catalog resource and its version/source metadata before proposing a fixed-copy publication.',
    agent_file: 'Owner only: {agentId}. Inspect current AGENT.md without applying it. Approved snapshots, not unreviewed file edits, authorize Discord execution.',
    propose: '{baseRevision,changeJson}. changeJson is a JSON-encoded change below. This creates an expiring review, never approval.',
  },
  changes: {
    'agent.save': '{kind:"agent.save",agent:{id:<new UUID or existing Agent ID>,name:<stable lowercase name>,displayName,markdown,execution:"restricted"|"trusted",tools:[...],readDomains:[<domain UUID>],skills:[{name,content}]}}. markdown is AGENT.md with matching name and defaultMode: session. Omit server-owned version, publishedAt and managementBindingId when editing a listed Agent.',
    'bindings.save': '{kind:"bindings.save",bindings:[{id:<new UUID or existing binding ID>,botInstanceId,botUserId,target:{kind:"channel",guildId,channelId}|{kind:"dm",userId},enabled,agentId,trigger:"mention"|"all",participants:{everyone,userIds:[...],roleIds:[...]},tools:[...],readDomains:[...],inheritThreads,manage}]}. botUserId comes from directory. Every save, including an unchanged save, starts fresh context. Omitted bindings are unchanged.',
    'domain.create': '{kind:"domain.create",name,domainKind:"shared"|"agent-private"}. Review before referring to the returned domain ID; a domain name grants no access.',
    'knowledge.publish': '{kind:"knowledge.publish",domainId,title,content,sources:[{domain:{id,revision},resourceId?,version?,sessionId?,epoch?}],resourceKind?:"note"|"skill"}. Reference exact observed sources; resourceId/version and sessionId/epoch are pairs. [] is for genuinely new owner-provided text, never removal of known provenance. Publication copies the reviewed content; it does not expose the original or future edits.',
    'knowledge.revoke': 'Owner only: {kind:"knowledge.revoke",resourceId}. Revokes future access, not content already delivered.',
    'domain.revoke': 'Owner only: {kind:"domain.revoke",domainId}. Revokes future access and dependent executions.',
  },
  tools: integrationToolNames,
  boundaries: [
    'Names are communication labels; returned Project/Bot/channel/user IDs authorize. Resolve ambiguous names with the human.',
    'Unassigned channels and DMs are closed. Thread inheritance copies configuration, never history. DMs require explicit users and no roles.',
    'Agent tools/domains are ceilings; bindings may only narrow them. A chat manager cannot widen its own scope, manage another Bot or self-approve.',
    'Participants control who invokes the Agent, not who can read its Discord replies. Confidential work belongs in a private channel.',
    'Project-private memory, global SOUL and other conversation epochs are not inherited. Shared knowledge requires explicit fixed-copy human publication and binding grants.',
    'Trusted exec is host execution, not an OS sandbox. Privileged Agents require selected people or roles, not everyone.',
    'Owner proposals require Project Bots > Discord access > Review. A Discord manager proposal may also be confirmed by the same currently authorized human with /shadow-approve <draft-id> <hash>. Never execute or infer approval for that human.',
    'Never request or include credentials in chat. Create/connect Bot identities in Project Bots; Discord installation and privileged intents require platform-side setup.',
  ],
}
export const IntegrationActorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('owner'), id }).strict(),
  z.object({ kind: z.literal('discord'), id, botInstanceId: id, channelId: snowflake, userId: snowflake, bindingId: z.string().uuid() }).strict(),
])
export type IntegrationActor = z.infer<typeof IntegrationActorSchema>
export const IntegrationDraftSchema = z.object({
  id: z.string().uuid(), baseRevision: z.number().int().nonnegative(),
  hash: z.string().regex(/^[a-f0-9]{64}$/), change: IntegrationChangeSchema, actor: IntegrationActorSchema,
  createdAt: z.string().datetime(), expiresAt: z.string().datetime(),
  status: z.enum(['pending', 'applying', 'applied', 'cancelled']), appliedRevision: z.number().int().positive().optional(),
  affectedBindings: z.array(z.string().uuid()),
  warning: z.string(),
  validationHash: z.string(),
  agentFileHash: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
}).strict()
export type IntegrationDraft = z.infer<typeof IntegrationDraftSchema>

export const DiscordLocationSchema = z.object({
  id: snowflake, name: z.string().max(100).nullable(), type: z.number().int(),
  guildId: snowflake.nullable(), guildName: z.string().max(100).nullable(),
  parentId: snowflake.nullable(), parentName: z.string().max(100).nullable(),
  recipientId: snowflake.nullable(),
}).strict()
export type DiscordLocation = z.infer<typeof DiscordLocationSchema>
export interface DiscordInspection {
  botUserId: string
  location: DiscordLocation
  actor: { id: string; name: string; roleIds: string[] }
  canView: boolean
  canSend: boolean
  canReadHistory: boolean
}
export interface DiscordDirectory {
  botUserId: string
  guilds: Array<{ id: string; name: string; icon: string | null }>
  guildCursor: string | null
  guildId: string | null
  channels: Array<{
    id: string; name: string; type: number; parentId: string | null
    canView: boolean; canSend: boolean; canReadHistory: boolean; supported: boolean
  }>
  roles: Array<{ id: string; name: string }>
  synchronizedAt: string
  completeness: 'guild-page' | 'channels-and-active-threads'
  notice: string
}

export const DiscordDirectorySchema = z.object({
  botUserId: snowflake, guilds: z.array(z.object({ id: snowflake, name: z.string(), icon: z.string().nullable() })),
  guildCursor: snowflake.nullable(), guildId: snowflake.nullable(),
  channels: z.array(z.object({
    id: snowflake, name: z.string(), type: z.number().int(), parentId: snowflake.nullable(),
    canView: z.boolean(), canSend: z.boolean(), canReadHistory: z.boolean(), supported: z.boolean(),
  }).strict()),
  roles: z.array(z.object({ id: snowflake, name: z.string() }).strict()),
  synchronizedAt: z.string().datetime(), completeness: z.enum(['guild-page', 'channels-and-active-threads']), notice: z.string(),
}).strict()
export const DiscordMemberSchema = z.object({ id: snowflake, name: z.string(), username: z.string() }).strict()
export type DiscordMember = z.infer<typeof DiscordMemberSchema>

export const ChannelBoundarySchema = z.object({
  version: z.literal(1), bindingId: z.string().uuid(), revision: z.string().regex(/^[a-f0-9]{64}$/),
  agentId: z.string().uuid(), agentVersion: z.string().regex(/^[a-f0-9]{64}$/),
  epoch: z.string().uuid(), domainId: z.string().uuid(),
  startSegment: z.number().int().nonnegative(),
  startedAt: z.string().datetime(),
  ownerSessionId: z.string().min(1).max(1024).optional(),
  botInstanceId: id, botUserId: snowflake, conversationId: snowflake,
  location: DiscordLocationSchema,
  sources: z.array(MemorySourceSchema).max(4096),
  learningActor: snowflake.optional(),
  learningInputId: z.string().min(1).max(1024).optional(),
  learning: z.object({ batchId: z.string().uuid(), pipeline: z.enum(['reflector', 'encapsulator', 'soulReflector']) }).strict().optional(),
}).strict()
export type ChannelBoundary = z.infer<typeof ChannelBoundarySchema>
export class ChannelBoundaryMetadataError extends Error {}
export function parseChannelBoundary(value: unknown): ChannelBoundary | undefined {
  if (value === undefined) return undefined
  const result = ChannelBoundarySchema.safeParse(value)
  if (!result.success) throw new ChannelBoundaryMetadataError('Invalid persisted channel authorization metadata.')
  return result.data
}

export interface DiscordIngressResult {
  trigger: DiscordBinding['trigger']
  location: DiscordLocation
  admissionId: string
}
export interface DiscordIngress {
  chatId: string
  senderId: string
  messageId: string
}
export interface DiscordIntegrationTransport {
  directory(botId: string, guildId: string | undefined, after: string | undefined, signal: AbortSignal): Promise<DiscordDirectory>
  inspect(botId: string, chatId: string, senderId: string, signal: AbortSignal): Promise<DiscordInspection>
  inspectTarget(botId: string, target: DiscordBinding['target'], signal: AbortSignal): Promise<{ botUserId: string; roleIds: string[] }>
  members?(botId: string, guildId: string, query: string, signal: AbortSignal): Promise<DiscordMember[]>
}

export interface DiscordAdapterIntegration {
  admit(input: DiscordIngress, signal: AbortSignal): Promise<DiscordIngressResult>
  discard(admissionId: string): void
  confirm(chatId: string, senderId: string, draftId: string, hash: string, signal: AbortSignal): Promise<void>
  invalidate(): void
}

export const IntegrationOverviewSchema = z.object({
  projectId: id, version: z.literal(1), revision: z.number().int().nonnegative(),
  agents: z.array(IntegrationAgentSchema), bindings: z.array(DiscordBindingSchema),
  deploymentIssues: z.array(z.object({ agentId: z.string().uuid(), message: z.string() }).strict()),
  drafts: z.array(IntegrationDraftSchema),
  audit: z.array(z.object({ id: z.string(), at: z.string().datetime(), actor: z.string(), kind: z.string(),
    revision: z.number().int(), affectedBindings: z.array(z.string()) }).strict()),
  domains: z.array(MemoryDomainSchema), resources: z.array(MemoryResourceSchema),
  tools: z.array(z.enum(integrationToolNames)),
  templates: z.array(z.object({ name: z.string(), description: z.string(), prompt: z.string(), model: z.string().optional() }).strict()),
  legacy: z.array(z.object({ botId: z.string(), legacySessionId: z.boolean(), adminChats: z.array(z.string()), notice: z.string() }).strict()),
  sessions: z.array(ChannelBoundarySchema.extend({ sessionId: z.string() })),
  learning: z.array(z.object({
    sessionId: z.string(), epoch: z.string().uuid(), domainId: z.string().uuid(), bindingId: z.string().uuid(),
    revision: z.string(), botInstanceId: z.string(), pipeline: z.enum(['reflector', 'encapsulator', 'soulReflector']),
    status: z.enum(['idle', 'pending', 'running', 'applying', 'completed', 'paused']), summary: z.string(),
    workerSessionId: z.string().optional(), retryAt: z.string().datetime().optional(),
  }).strict()).default([]),
}).strict()
export type IntegrationOverview = z.infer<typeof IntegrationOverviewSchema>
export const IntegrationPreviewSchema = z.object({
  projectId: id, botInstanceId: id, senderId: snowflake,
  sessionId: z.string(), location: DiscordLocationSchema, agent: z.string(), revision: z.string(),
  newContextRequired: z.boolean(), systemPrompt: z.string(), execution: z.enum(['restricted', 'trusted']),
  sections: z.array(z.object({ name: z.string(), content: z.string(), characters: z.number() }).strict()),
  tools: z.array(z.object({ name: z.string(), description: z.string(), parameters: z.unknown() }).strict()),
  domains: z.array(MemoryDomainSchema), notice: z.string(),
}).strict()
export type IntegrationPreview = z.infer<typeof IntegrationPreviewSchema>
