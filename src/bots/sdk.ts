import { z } from 'zod'
import { parseDocument } from 'yaml'
import { ConversationBindingSchema, ResourceName } from '../agent-authoring/contracts.ts'
import { assertSupportedJsonSchema } from '../agent-authoring/capabilities.ts'
import { DiscordBindingSchema, DiscordHistoryScopeSchema, SourceFoldersSchema } from '../channels/integration-contract.ts'

/** SDK packages are data at publication time. Only tool invocation executes source. */
export const BotToolNameSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/)
const names = z.array(BotToolNameSchema).max(64).refine(a => new Set(a).size === a.length, 'Duplicate tool names')
const moduleName = z.string().regex(/^@shadow\/[A-Za-z][A-Za-z0-9_-]{0,127}$/).refine(s => s !== '@shadow/bot-runtime' && s !== '@shadow/bot-sdk', 'Reserved SDK module')
const imports = z.array(moduleName).max(31).refine(a => new Set(a).size === a.length, 'Duplicate imports')
export const BotSourcePathSchema = z.string().min(1).max(256).refine(s =>
  !s.startsWith('/') && !s.includes('\\') && s.split('/').every(p => p !== '' && p !== '.' && p !== '..') && !/[\x00-\x1f\x7f:]/.test(s), 'Use a relative package path without traversal')
const binding = ConversationBindingSchema.omit({ agent: true }).extend({ platform: z.enum(['qq', 'feishu']), tools: names }).strict()
const discord = DiscordBindingSchema.omit({ agentId: true, epochRevision: true }).extend({ platform: z.literal('discord'), tools: names }).strict()
export const BotBindingSchema = z.discriminatedUnion('platform', [binding, discord])
const baseDefinition = z.object({
  id: ResourceName,
  prompt: z.string().trim().min(1).max(128_000),
  allowedModules: imports,
  tools: z.array(z.object({
    name: BotToolNameSchema, description: z.string().trim().min(1).max(2000),
    parameters: z.record(z.unknown()).superRefine((s, ctx) => {
      try { assertSupportedJsonSchema(s) } catch { ctx.addIssue({ code: 'custom', message: 'Unsupported tool parameter schema' }) }
    }),
    module: BotSourcePathSchema.refine(s => /\.(?:ts|js|mts|mjs)$/.test(s), 'Expected JS or TS source'),
    export: z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/).optional(),
    imports,
  }).strict()).max(64),
  bindings: z.array(BotBindingSchema).max(1000),
  readDomains: z.array(z.string().uuid()).max(32).optional(),
  sourceFolders: SourceFoldersSchema.optional(),
  discordHistory: DiscordHistoryScopeSchema.optional(),
  skills: z.array(z.object({ name: ResourceName, content: z.string().min(1).max(64_000) }).strict()).max(32).optional(),
}).strict()
const definition = z.discriminatedUnion('mode', [
  baseDefinition.extend({ mode: z.literal('service'), connection: z.never().optional(), agent: z.never().optional() }),
  baseDefinition.extend({ mode: z.literal('personal'), connection: z.string().uuid(), agent: ResourceName }),
]).superRefine((bot, ctx) => {
  if (bot.mode === 'personal') {
    if (!bot.connection || !bot.agent) ctx.addIssue({ code: 'custom', message: 'Personal BOT requires connection and agent' })
    if (bot.bindings.length || bot.tools.length || bot.allowedModules.length || bot.readDomains || bot.sourceFolders || bot.discordHistory || bot.skills)
      ctx.addIssue({ code: 'custom', message: 'Personal BOT uses ordinary role tools/context; custom tools, service bindings and scopes are not supported' })
  } else if (bot.connection || bot.agent) ctx.addIssue({ code: 'custom', message: 'Service BOT cannot select a personal connection or role' })
  const seen = new Set<string>()
  for (const tool of bot.tools) {
    if (seen.has(tool.name)) ctx.addIssue({ code: 'custom', message: `Duplicate tool: ${tool.name}` })
    seen.add(tool.name)
    for (const name of tool.imports) if (!bot.allowedModules.includes(name)) ctx.addIssue({ code: 'custom', message: `Module not allowed: ${name}` })
  }
})
export const BotDefinitionSchema = definition
export type BotDefinition = z.infer<typeof BotDefinitionSchema>

/** Validate generated data. Deployed bot configuration is JSON, never executable TS. */
export function defineBot(definition: BotDefinition): BotDefinition { return BotDefinitionSchema.parse(definition) }
export interface BotToolContext {
  services: { call(name: string, input: Record<string, unknown>): Promise<unknown> }
  channel: { call(operation: string, input: Record<string, unknown>): Promise<unknown> }
  storage: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<unknown>; delete(key: string): Promise<unknown> }
  log: { info(message: string): Promise<void>; warn(message: string): Promise<void>; error(message: string): Promise<void> }
  /** Lifetime marker. Cancellation terminates the child and aborts host callbacks. */
  signal: { readonly aborted: boolean; throwIfAborted(): void }
}
export interface BotTool<T = Record<string, unknown>> { description?: string; parameters?: Record<string, unknown>; execute(args: T, ctx: BotToolContext): unknown | Promise<unknown> }
export function defineTool<T = Record<string, unknown>>(tool: BotTool<T>): BotTool<T> { return tool }

export function validateBotFiles(files: Record<string, string>): void {
  const entries = Object.entries(files)
  if (!entries.length || entries.length > 128) throw new Error('Bot package requires 1–128 files')
  let bytes = 0
  for (const [path, text] of entries) {
    BotSourcePathSchema.parse(path)
    if (typeof text !== 'string' || Buffer.byteLength(text) > 512_000) throw new Error('Bot file exceeds size limit')
    bytes += Buffer.byteLength(text)
  }
  if (bytes > 2_000_000) throw new Error('Bot package exceeds size limit')
}

/** BOT.md: YAML frontmatter {id, config: bot.json}, followed by the prompt.
 * JSON config contains allowedModules, tools, bindings and optional scopes/skills.
 * No module is imported, evaluated or compiled by this pure parser.
 */
export function parseBot(files: Record<string, string>): BotDefinition {
  validateBotFiles(files)
  const markdown = files['BOT.md']
  const match = typeof markdown === 'string' && /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(markdown)
  if (!match) throw new Error('BOT.md requires YAML frontmatter and a prompt')
  const document = parseDocument(match[1]!, { uniqueKeys: true })
  if (document.errors.length) throw new Error('Invalid BOT.md frontmatter')
  const header = z.object({ id: ResourceName, config: BotSourcePathSchema.refine(s => s.endsWith('.json')) }).strict().parse(document.toJS({ maxAliasCount: 0 }))
  if (!Object.hasOwn(files, header.config)) throw new Error('Bot config file missing')
  const config: unknown = JSON.parse(files[header.config]!)
  if (!config || typeof config !== 'object' || Array.isArray(config) || Object.hasOwn(config, 'id') || Object.hasOwn(config, 'prompt')) throw new Error('Bot JSON config must not override identity or prompt')
  const bot = BotDefinitionSchema.parse({ ...config, id: header.id, prompt: match[2] })
  for (const tool of bot.tools) if (!Object.hasOwn(files, tool.module)) throw new Error(`Tool source missing: ${tool.module}`)
  return bot
}
