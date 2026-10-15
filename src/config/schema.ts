import { z } from 'zod'
import { parseMcpServerConfig } from '../mcp/config.ts'
import { MAX_YIELD_TIMEOUT_MS } from '../sessions/yield-contract.ts'
import { REASONING_EFFORTS } from '../agent/llm-config.ts'
import { DEFAULT_AGENT_MODEL } from './defaults.ts'
import { WebSearchSelectionSchema } from './web-search.ts'
import { A2aConfigSchema } from '../a2a/config.ts'
import { workObserverConfigSchema } from '../projects/work-observer.ts'
import { retirementConfigSchema } from '../sessions/retirement-contract.ts'

// ── Provider configs ────────────────────────────────────────────────────────

export const ProviderConfigSchema = z.object({
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  /** Lightweight model used for fast classifications (e.g. intent routing). */
  quickModel: z.string().optional(),
  /**
   * Per-model context window overrides, keyed by model id. Highest priority,
   * overrides the built-in registry.
   */
  modelContextWindows: z.record(z.string(), z.number()).optional(),
})

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>

/**
 * Open-ended record: any provider name maps to the same generic config.
 * e.g. { openai: { apiKey: "..." }, anthropic: { ... } }
 */
export const ProvidersSchema = z.record(z.string(), ProviderConfigSchema)
  .default({})

// ── Channel configs ─────────────────────────────────────────────────────────

const ChannelBaseSchema = z.object({
  enabled: z.boolean().default(false),
  allowFrom: z.array(z.string()).optional(),
  /** Chat IDs that have admin privileges. DMs are admin by default; this is for group chats. */
  adminChats: z.array(z.string()).optional(),
  /** Exact group/channel IDs whose whole audience is trusted; does not grant tool permissions. */
  trustedChats: z.array(z.string().max(16_384).regex(/^[^\x00-\x1f]+$/).trim().min(1)).max(1000).optional(),
})

export const DiscordChannelSchema = ChannelBaseSchema.extend({
  token: z.string().optional(),
  /** 'mention' = respond only to @mentions, DMs, and replies to bot. 'all' = respond to everything. */
  triggerMode: z.enum(['all', 'mention']).default('mention'),
  /** Emoji to react with when a message is received. Set to empty string to disable. Default: '👀' */
  reactionEmoji: z.string().default('👀'),
  memberIntent: z.boolean().optional(),
})

export const FeishuChannelSchema = ChannelBaseSchema.extend({
  /** App ID from Feishu Open Platform */
  appId: z.string().optional(),
  /** App Secret from Feishu Open Platform */
  appSecret: z.string().optional(),
  /** Encryption key for event payloads */
  encryptKey: z.string().optional(),
  /** Verification token for event subscription */
  verificationToken: z.string().optional(),
})

export const QQChannelSchema = ChannelBaseSchema.extend({
  /** Record all delivered group messages; only mentions trigger a model turn by default. */
  triggerMode: z.enum(['all', 'mention']).default('mention'),
  /** Bot AppID from the QQ Bot platform (q.qq.com). */
  appId: z.string().optional(),
  /** Bot AppSecret (client secret) used to mint the app access token. */
  secret: z.string().optional(),
  /** Bot token (legacy guild API). Optional for the v2 group/C2C API. */
  token: z.string().optional(),
  /** Use the sandbox API endpoint (sandbox.api.sgroup.qq.com) for testing. */
  sandbox: z.boolean().default(false),
  /**
   * Gateway intents bitmask. Defaults to GROUP_AND_C2C_EVENT | PUBLIC_GUILD_MESSAGES.
   * Override only if you know which events your bot is approved to receive.
   */
  intents: z.number().optional(),
  /** Render outbound messages as QQ Markdown (msg_type 2). Defaults to true. */
  markdown: z.boolean().default(true),
})

export const WebChannelSchema = ChannelBaseSchema.extend({})

export const WeChatChannelSchema = ChannelBaseSchema.extend({
  /** iLink Bot API base URL. Defaults to https://ilinkai.weixin.qq.com */
  baseUrl: z.string().optional(),
})

export const WeChatDesktopChannelSchema = ChannelBaseSchema.extend({
  /** WeChat main window handle (hex string, e.g. "0x20454"). Auto-detected if omitted. */
  mainWindowHandle: z.string().optional(),
  /** Poll interval in ms. Default: 1000. */
  pollIntervalMs: z.number().optional(),
  /** Full window scan every N ticks. Default: 5. */
  windowScanEveryTicks: z.number().optional(),
})

export const ChannelsSchema = z.object({
  discord: DiscordChannelSchema.optional(),
  feishu: FeishuChannelSchema.optional(),
  qq: QQChannelSchema.optional(),
  web: WebChannelSchema.optional(),
  wechat: WeChatChannelSchema.optional(),
  wechatDesktop: WeChatDesktopChannelSchema.optional(),
})

// ── MCP configs ─────────────────────────────────────────────────────────────

/**
 * Config file format: record of server name → server config.
 *
 * ```json
 * "mcp": {
 *   "my-server": { "command": "npx", "args": ["-y", "my-mcp-server"] }
 * }
 * ```
 *
 * Transformed into `{ servers: McpServerConfig[] }` after parsing.
 */
export const McpSchema = z
  .record(z.string(), z.unknown())
  .default({})
  .transform((record, ctx) => {
    const servers: McpServerConfig[] = []
    for (const [name, input] of Object.entries(record)) {
      try {
        servers.push(parseMcpServerConfig(name, input))
      } catch (error) {
        if (!(error instanceof z.ZodError)) throw error
        for (const issue of error.issues) {
          ctx.addIssue({ ...issue, path: [name, ...issue.path] })
        }
      }
    }
    return { servers }
  })

/**
 * Resolved MCP server config with name and transport (post-transform).
 * Used throughout the MCP subsystem.
 */
export interface McpServerConfig {
  name: string
  transport: 'stdio' | 'sse' | 'streamable-http'
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  headers?: Record<string, string>
  description?: string
  trustReadOnlyHints?: boolean
  readOnlyOverrides?: Record<string, { readOnly: boolean; fingerprint: string }>
}

// ── Agent configs ───────────────────────────────────────────────────────────

export const AgentSchema = z.object({
  /** Model name with an optional explicit @provider suffix. */
  model: z.string().default(DEFAULT_AGENT_MODEL),
  /** Lightweight model for mid-turn intent classification (steer vs abort). */
  quickModel: z.string().optional(),
  /** Workspace root for bootstrap files, skills, memory */
  workspace: z.string().default('./workspace'),
  temperature: z.number().default(0.7),
  maxToolIterations: z.number().default(20),
  autoHandoff: z.boolean().default(true),
  handoffMinThreshold: z.number().min(0.5).max(0.95).default(0.75),
  handoffMaxThreshold: z.number().min(0.5).max(0.95).default(0.95),
  /** Session storage backend: 'jsonl' (default, file-based) or 'sqlite'. */
  sessionStorage: z.enum(['jsonl', 'sqlite']).default('jsonl'),
  /** DeepSeek thinking mode toggle */
  thinking: z.object({ type: z.enum(['enabled', 'disabled']) }).optional(),
  /** Optional three-tier context budget; omission preserves provider/model defaults. */
  contextWindow: z.union([z.literal(256000), z.literal(400000), z.literal(1000000)]).optional(),
  /** Default reasoning effort, unless overridden by a conversation. */
  reasoningEffort: z.enum(REASONING_EFFORTS).default('medium'),
})

// ── Tool configs ────────────────────────────────────────────────────────────

export const ExecToolSchema = z.object({
  nodeOnly: z.boolean().optional(),
  defaultShell: z.enum([
    'cmd',
    'sh',
    'bash',
    'git-bash',
    'powershell',
    'pwsh',
    'node',
  ]).optional(),
  timeoutMs: z.number().default(60_000),
  maxOutputBytes: z.number().default(10_000),
})

export const WindowsToolSchema = z.object({
  enabled: z.boolean().default(false),
  backend: z.enum(['cli', 'napi']).default('cli'),
  cliPath: z.string().optional(),
  napiPath: z.string().optional(),
  timeoutMs: z.number().default(60_000),
  maxOutputBytes: z.number().default(10_000),
})

export const ChromeToolSchema = z.object({
  /** Path to Chrome/Edge/Brave executable. Auto-detected if omitted. */
  executablePath: z.string().optional(),
  /** Base port for remote debugging (default: 9222). Sessions auto-allocate from this. */
  basePort: z.number().default(9222),
})

export const ToolsSchema = z.object({
  exec: ExecToolSchema.optional(),
  yield: z.object({
    timeoutMs: z.number().int().min(1).max(MAX_YIELD_TIMEOUT_MS).nullable().default(null),
  }).strict().optional(),
  restrictToWorkspace: z.boolean().default(false),
  braveApiKey: z.string().optional(),
  firecrawlApiKey: z.string().optional(),
  exaApiKey: z.string().optional(),
  tavilyApiKey: z.string().optional(),
  webSearchProvider: WebSearchSelectionSchema.optional(),
  windows: WindowsToolSchema.optional(),
  chrome: ChromeToolSchema.optional(),
})

// ── Learning config ────────────────────────────────────────────────────────

export const LearningSchema = z.object({
  /** Project-owned automatic scheduling preferences; omitted items default on. */
  pipelines: z.object({ reflector: z.boolean().optional(), encapsulator: z.boolean().optional(), soulReflector: z.boolean().optional() }).strict().optional(),
  /** Interval for reflector poll (default 30 minutes). */
  reflectIntervalMs: z.number().default(30 * 60 * 1000),
  /** Interval for encapsulator poll (default 2 hours). */
  encapsulateIntervalMs: z.number().default(120 * 60 * 1000),
  /** Interval for soul-reflector poll (default 12 hours). */
  soulIntervalMs: z.number().default(12 * 60 * 60 * 1000),
})

// ── Cron config ─────────────────────────────────────────────────────────────

export const CronConfigSchema = z.object({
  /**
   * IANA timezone name used to interpret cron schedules as local time.
   * e.g. "Asia/Shanghai", "America/New_York", "Europe/London".
   * Defaults to the system timezone detected from the OS.
   */
  timezone: z.string().default(() =>
    Intl.DateTimeFormat().resolvedOptions().timeZone
  ),
})

// ── Tunnel config ──────────────────────────────────────────────────────

export const TunnelSchema = z.object({
  enabled: z.boolean().default(false),
  /** Extra CLI args passed to `devtunnel host` (e.g. ["--allow-anonymous"]). */
  args: z.array(z.string()).optional(),
})

// ── Root config ─────────────────────────────────────────────────────────

export const ConfigSchema = z.object({
  network: z.object({ proxyEnabled: z.boolean().default(true) }).strict().optional(),
  a2a: A2aConfigSchema.optional(),
  agent: AgentSchema.default({}),
  providers: ProvidersSchema.default({}),
  channels: ChannelsSchema.default({}),
  mcp: McpSchema.default({}),
  tools: ToolsSchema.default({}),
  learning: LearningSchema.default({}),
  workObserver: workObserverConfigSchema.default({}),
  sessionRetirement: retirementConfigSchema.default({}),
  cron: CronConfigSchema.default({}),
  tunnel: TunnelSchema.default({}),
  voice: z.never().optional(),
})

export type Config = z.infer<typeof ConfigSchema>
export type ChannelName = keyof z.infer<typeof ChannelsSchema>
