import { InputProcessorSchema } from '../events/input-processor-contract.ts'
import { z } from 'zod'
import { MemorySourceSchema, MemoryDomainSchema, MemoryResourceSchema } from '../memory/contracts.ts'

const snowflake = z.string().regex(/^[0-9]{1,20}$/)
const id = z.string().min(1).max(512)
export const integrationToolNames = [
  'read', 'search', 'memory_save', 'discord_history', 'discord_message_get',
  'channel_config', 'subagent', 'learned_skill', 'exec',
] as const
/** Owner-reviewed registered local source folders; no path, write or execution grants. */
export const SourceFoldersSchema = z.array(z.string().uuid()).max(16).refine(ids => new Set(ids).size === ids.length, 'Unique source folders required')
export const DiscordHistoryScopeSchema = z.object({
  guildId: snowflake,
  channelIds: z.array(snowflake).min(1).max(20).refine(ids => new Set(ids).size === ids.length, 'Unique history channels required'),
  threads: z.enum(['none', 'public-active', 'public-archived']),
  preEpoch: z.boolean(),
}).strict()
export type DiscordHistoryScope = z.infer<typeof DiscordHistoryScopeSchema>
export const IntegrationAgentInputSchema = z.object({
  id: z.string().uuid(),
  name: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  displayName: z.string().trim().min(1).max(100),
  markdown: z.string().min(1).max(128_000),
  execution: z.enum(['restricted', 'trusted']),
  tools: z.array(z.enum(integrationToolNames)).max(32),
  readDomains: z.array(z.string().uuid()).max(32),
  sourceFolders: SourceFoldersSchema.optional(),
  discordHistory: DiscordHistoryScopeSchema.optional(),
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
/** Separate owner-reviewed observation authority; never participant authority. */
export const DiscordObservationSchema = z.object({
  enabled: z.boolean().default(false),
  guildId: snowflake,
  channelIds: z.array(snowflake).min(2).max(20).refine(ids => new Set(ids).size === ids.length, 'Unique observation channels required'),
  audienceChannelId: snowflake,
  processor: InputProcessorSchema,
}).strict()
export type DiscordObservation = z.infer<typeof DiscordObservationSchema>
export interface DiscordObservationProof {
  scopeId: string; revision: string; botUserId: string; guildId: string; policy: z.infer<typeof InputProcessorSchema>
}
export const DiscordBindingSchema = z.object({
  id: z.string().uuid(), botInstanceId: id, botUserId: snowflake,
  target: DiscordTargetSchema,
  enabled: z.boolean(), agentId: z.string().uuid(),
  trigger: z.enum(['mention', 'all']),
  processor: InputProcessorSchema.optional(),
  observation: DiscordObservationSchema.optional(),
  participants: z.object({
    everyone: z.boolean(), userIds: z.array(snowflake).max(1000), roleIds: z.array(snowflake).max(250),
  }).strict(),
  tools: z.array(z.enum(integrationToolNames)).max(32),
  readDomains: z.array(z.string().uuid()).max(32),
  sourceFolders: SourceFoldersSchema.optional(),
  discordHistory: DiscordHistoryScopeSchema.optional(),
  inheritThreads: z.boolean(),
  manage: z.boolean(),
  epochRevision: z.number().int().nonnegative().optional(),
}).strict()
export type DiscordBinding = z.infer<typeof DiscordBindingSchema>
export const DiscordPackageSchema = z.object({ id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), source: z.record(z.string().max(512_000)) }).strict()
export const IntegrationChangeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('bot.save'), package: DiscordPackageSchema, adoptLegacy: z.literal(true).optional() }).strict(),
  z.object({ kind: z.literal('agent.save'), agent: IntegrationAgentInputSchema }).strict(),
  z.object({ kind: z.literal('bindings.save'), bindings: z.array(DiscordBindingSchema).min(1).max(200) }).strict(),
  z.object({ kind: z.literal('domain.create'), name: z.string().trim().min(1).max(160), domainKind: z.enum(['shared', 'agent-private']) }).strict(),
  z.object({
    kind: z.literal('knowledge.publish'), domainId: z.string().uuid(),
    title: z.string().trim().min(1).max(200), content: z.string().min(1).max(256_000),
    historyLocations: z.array(snowflake).max(200).optional(),
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
    list: 'Read current Discord revision, Agents, bindings and permitted domains. Owner chat lists named Discord connections in bots and QQ/Feishu connections with their authoring route in otherPlatformBots; enabled is configuration, not proof of connectivity. QQ/Feishu use authoring_change, not these Discord revisions or proposal formats.',
    directory: 'Owner: {botId,guildId?,after?}. Discord manager: {guildId?,after?}, always its own Bot. Omit guildId to discover named servers, then supply a returned guild ID for channels/roles. Use guildCursor as after for another server page.',
    members: '{guildId,query}, plus botId in owner chat. Search a name in a mutual server; at most 25 results. Discord has no global person-name search. Use returned IDs, not guessed IDs.',
    resource: 'Owner only: {resourceId}. Read an exact catalog resource and its version/source metadata before proposing a fixed-copy publication.',
    agent_file: 'Owner only: {agentId}. Inspect current AGENT.md without applying it. Approved snapshots, not unreviewed file edits, authorize Discord execution.',
    propose: '{baseRevision,changeJson}. changeJson is a JSON-encoded change below. This creates an expiring review, never approval.',
  },
  changes: {
    'agent.save': '{kind:"agent.save",agent:{id:<new UUID or existing Agent ID>,name:<stable lowercase name>,displayName,markdown,execution:"restricted"|"trusted",tools:[...],readDomains:[<domain UUID>],skills:[{name,content}]}}. markdown is AGENT.md with matching name and defaultMode: session. Omit server-owned version, publishedAt and managementBindingId when editing a listed Agent.',
    'bindings.save': '{kind:"bindings.save",bindings:[{id:<new UUID or existing binding ID>,botInstanceId,botUserId,target:{kind:"channel",guildId,channelId}|{kind:"dm",userId},enabled,agentId,trigger:"mention"|"all",participants:{everyone,userIds:[...],roleIds:[...]},tools:[...],readDomains:[...],inheritThreads,manage,processor?:{code,delayMs,includeBots?:boolean}}]}. processor runs restricted export async function run({event}) returning {action:"ignore"|"buffer"|"emit"}; no imports or tools. includeBots defaults false; self messages are always ignored and other bots have a 60s per-conversation cooldown. Windows are per sender and conversation, at most 60s; managed pending messages use a bounded private durable inbox with fresh authorization on recovery; no exactly-once guarantee. botUserId comes from directory. Every save, including an unchanged save, starts fresh context. Omitted bindings are unchanged.',
    'domain.create': '{kind:"domain.create",name,domainKind:"shared"|"agent-private"}. Review before referring to the returned domain ID; a domain name grants no access.',
    'knowledge.publish': '{kind:"knowledge.publish",domainId,title,content,sources:[{domain:{id,revision},resourceId?,version?,sessionId?,epoch?}],resourceKind?:"note"|"skill"}. Reference exact observed sources; resourceId/version and sessionId/epoch are pairs. [] is for genuinely new owner-provided text, never removal of known provenance. Publication copies the reviewed content; it does not expose the original or future edits.',
    'knowledge.revoke': 'Owner only: {kind:"knowledge.revoke",resourceId}. Revokes future access, not content already delivered.',
    'domain.revoke': 'Owner only: {kind:"domain.revoke",domainId}. Revokes future access and dependent executions.',
  },
  resources: {
    ownerReview: 'sourceFolders?:[<registered local Folder UUID>] and discordHistory?:{guildId,channelIds:[<exact channel IDs>],threads:"none"|"public-active"|"public-archived",preEpoch:boolean} on Agent and binding. Bindings may only narrow the Agent ceiling. Omitted means no new source/cross-channel/pre-epoch authority. Owner-only exact review; never arbitrary paths, private threads, writes or terminal access.',
    source: 'read v:source lists IDs; read v:source/<Folder UUID>/<relative file> with optional offset/limit. search {folderId,query,mode:"names"|"content",path?,limit?}. Source-only bounded literal search excludes hidden/dependency/build/credential paths, binary/oversized files and symlinks/hardlinks. Registered local POSIX folders only.',
    history: 'discord_history {channelId?,limit?,before?,query?} scans one page (query is literal within that page, not server-wide search). discord_message_get {channelId?,messageId}. Discover public threads: discord_history {channelId,threads:"active",limit?,threadAfter?} or {channelId,threads:"archived",limit?,archiveBefore?}. preEpoch explicitly permits platform history before the current authorization, never older internal memory. Live caller/Bot visibility+history and equivalent output audiences are required on reads and delivery.',
  },
  observation: {
    review:'Owner-only exact bindings.save review. observation.enabled defaults false. Dedicated service binding must have no participants, tools, domains, management, ordinary processor or inherited threads; its published Agent must be restricted and tool/domain-free. Configuration actor is not the observed sender or service execution principal.',
    configuration:'observation:{enabled:false,guildId,channelIds:[2..20 unique exact same-guild channels],audienceChannelId:<binding target channel>,processor:{code,delayMs,includeBots?,source?,sourceSha256?,snapshot?,codeSha256?}}. No implicit descendants or other guilds. The dedicated binding target is the explicitly reviewed output audience, not a sender permission grant.',
    execution:'Gateway observation runs before participant admission without weakening it. Only emit plus semantic:{type,data} wakes the isolated discord-observation service context through a host-owned event capability. Observed accounts need no participant grants and never receive tools or command authority. Bot identity owns execution/output; self messages are excluded and other bots require reviewed includeBots. Evidence is not broadcast through EventService subscriptions.',
    safety:'Every observation and wake checks current scope revision and live Bot visibility across selected channels plus audience send permission. Before inference/output/delivery these are rechecked; changes invalidate context and output leases. State partitions include scope, revision, guild and sender; programs also have a code-hash partition. Stop/timeout fail closed. At-least-once event admission is not exactly-once model execution or moderation.',
    authoring:'processor_check / processor_test work with semantic outputs. observation_propose freezes the complete dependency graph on an existing dedicated audience binding; enabled defaults false and proposal alone never activates. Schema resources include complete standalone observationFiles. Example requires four matching metadata image signatures in three distinct channels within 20 seconds, then one event and 60-second cooldown. Metadata is not a visual hash.',
  },
  classifier: {
    scope:'Owner-only optional observation.processor.classifier; not ordinary participant processors. Exact bindings.save review freezes policy with all program sources. observation_propose accepts classifier object; enabled defaults false.',
    policy:'Strict mandatory fields: model (configured catalog ID, <=256 chars), instructions (<=4000 chars), fields ([content and/or attachments]), maxInputBytes (1..16000), maxTokens (32..1024), maxRequests (1..100), maxWindowTokens (100..1000000), windowMs (1000..86400000), deadlineMs (10..1500), minConfidence (0..1). Output schema is fixed, not message-selected.',
    program:'Return classify:true for a two-phase run. Host selects original content and MIME/dimensions/size only, never URLs, names or other scope history. Second run receives classification:{label:ignore|buffer|semanticwake|unknown,confidence:0..1}; recursive classify is denied and emit requires semanticwake. Unknown/low confidence/budget/timeout/schema/revocation fail closed without strong-model fallback.',
    billing:'Per scope/revision/policy sliding budgets reserve serialized system/input UTF-8 bytes plus maxTokens before dispatch. Durable reservation dedupes retries/restart; uncertain calls become unknown, never automatic paid replay. No exactly-once billing or remote cancellation guarantee. Ledger capacity fails closed. No idle model calls; rule campaign path remains zero-call.',
    resources:'processor_resource: classifier/processor.ts, classifier/policy.json, classifier/fixtures.json. Fake fixture provider uses real host contract, no network/fees. Full limits/recovery: docs/event-input-processing.md.',
  },
  tools: integrationToolNames,
  boundaries: [
    'Names are communication labels; returned Project/Bot/channel/user IDs authorize. Resolve ambiguous names with the human.',
    'Unassigned channels and DMs are closed. Thread inheritance copies configuration, never history. DMs require explicit users and no roles.',
    'Forum channels (type 15) are assignment containers, not message destinations. Enable inheritThreads to cover their public posts; each post has its own conversation and live participant/permission checks. Forum directory canSend means Send Messages in Threads. Private threads, automatic post creation and archived-thread scanning remain unsupported.',
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
  resourceReview: z.object({
    agent: z.object({sourceFolders:SourceFoldersSchema,discordHistory:DiscordHistoryScopeSchema.nullable()}).strict(),
    bindings:z.array(z.object({id:z.string().uuid(),target:DiscordTargetSchema,sourceFolders:SourceFoldersSchema,discordHistory:DiscordHistoryScopeSchema.nullable()}).strict()).max(200),
  }).strict().optional(),
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
  historyLocations: z.array(snowflake).max(200).optional(),
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
  processor?: z.infer<typeof InputProcessorSchema>
  processorRevision?: string
  botUserId?: string
}
export interface DiscordIngress {
  chatId: string
  senderId: string
  messageId: string
}
export interface DiscordIntegrationTransport {
  assertHistory?(botId: string, chatId: string, senderId: string, audienceId: string, scope: DiscordHistoryScope, signal: AbortSignal): Promise<void>
  directory(botId: string, guildId: string | undefined, after: string | undefined, signal: AbortSignal): Promise<DiscordDirectory>
  inspect(botId: string, chatId: string, senderId: string, signal: AbortSignal): Promise<DiscordInspection>
  inspectTarget(botId: string, target: DiscordBinding['target'], signal: AbortSignal): Promise<{ botUserId: string; roleIds: string[] }>
  members?(botId: string, guildId: string, query: string, signal: AbortSignal): Promise<DiscordMember[]>
}

export interface DiscordAdapterIntegration {
  processorStorageId?: string
  classifyObservation?(proof:DiscordObservationProof,data:Record<string,unknown>,signal:AbortSignal):Promise<import('../events/input-classifier.ts').Classification>
  observe?(data: Record<string, unknown>, signal: AbortSignal): Promise<DiscordObservationProof[]>
  wakeObservation?(proof: DiscordObservationProof, items: Record<string, unknown>[], semantic: {type:string;data:Record<string,unknown>}, signal: AbortSignal): Promise<void>
  admit(input: DiscordIngress, signal: AbortSignal): Promise<DiscordIngressResult>
  discard(admissionId: string): void
  confirm(chatId: string, senderId: string, draftId: string, hash: string, signal: AbortSignal): Promise<void>
  invalidate(): void
}

export const IntegrationOverviewSchema = z.object({
  packages: z.record(z.object({active: DiscordPackageSchema, revision:z.string(), history:z.array(DiscordPackageSchema)})).default({}),
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
