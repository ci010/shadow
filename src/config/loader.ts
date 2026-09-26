import { resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import { env } from 'node:process'
import { type Config, ConfigSchema } from './schema.ts'
import { fileExists } from '../utils/paths.ts'

const DEFAULT_CONFIG_PATHS = [
  'bot.config.json',
  '.bot/config.json',
]

/**
 * Resolve the config path that will be used, if any.
 */
export async function resolveConfigPath(
  explicitPath?: string,
): Promise<string | null> {
  if (explicitPath) {
    const abs = resolve(explicitPath)
    return (await fileExists(abs)) ? abs : null
  }

  for (const candidate of DEFAULT_CONFIG_PATHS) {
    const abs = resolve(candidate)
    if (await fileExists(abs)) {
      return abs
    }
  }

  return null
}

export function normalizePersistedConfig(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Configuration must be an object.')
  }
  const raw: Record<string, unknown> = { ...value }
  if (Object.hasOwn(raw, 'voice')) {
    delete raw.voice
    console.warn('[config] Retired voice settings are ignored; automatic STT is no longer available. Use audio_cpp for transcription. The retired field is removed on the next configuration save.')
  }
  return raw
}

/**
 * Load config from file or fall back to defaults + env vars.
 */
export async function loadConfig(explicitPath?: string): Promise<Config> {
  let raw: Record<string, unknown> = {}

  if (explicitPath) {
    const content = await readFile(explicitPath, 'utf8')
    raw = JSON.parse(content)
    console.info(`[config] Loaded config from ${explicitPath}`)
  } else {
    for (const candidate of DEFAULT_CONFIG_PATHS) {
      const abs = resolve(candidate)
      if (await fileExists(abs)) {
        const content = await readFile(abs, 'utf8')
        raw = JSON.parse(content)
        console.info(`[config] Loaded config from ${abs}`)
        break
      }
    }
  }

  raw = normalizePersistedConfig(raw)
  // Overlay environment variables into the raw config
  overlayEnv(raw)

  return ConfigSchema.parse(raw)
}

/**
 * Merge well-known environment variables into the raw config object.
 */
function overlayEnv(raw: Record<string, unknown>): void {
  const providers = (raw.providers ?? {}) as Record<
    string,
    Record<string, unknown>
  >

  // Provider API keys: any env var matching <NAME>_API_KEY sets providers.<name>.apiKey
  const providerEnvMap: Record<string, string> = {
    OPENAI_API_KEY: 'openai',
    ANTHROPIC_API_KEY: 'anthropic',
    DEEPSEEK_API_KEY: 'deepseek',
    OPENROUTER_API_KEY: 'openrouter',
    GEMINI_API_KEY: 'gemini',
    GROQ_API_KEY: 'groq',
    STEPFUN_API_KEY: 'stepfun',
    MOONSHOT_API_KEY: 'kimi',
  }

  for (const [envVar, providerName] of Object.entries(providerEnvMap)) {
    const val = env[envVar]
    if (val) {
      providers[providerName] ??= {}
      providers[providerName].apiKey = val
    }
  }

  // Channel tokens
  if (env.DISCORD_TOKEN) {
    const channels = (raw.channels ?? {}) as Record<
      string,
      Record<string, unknown>
    >
    channels.discord ??= {}
    channels.discord.token = env.DISCORD_TOKEN
    // Auto-enable Discord when token is provided via env
    if (channels.discord.enabled === undefined) {
      channels.discord.enabled = true
    }
    raw.channels = channels
  }

  // Feishu channel credentials
  const feishuAppId = env.FEISHU_APP_ID ??
    env.LARK_APP_ID
  const feishuAppSecret = env.FEISHU_APP_SECRET ??
    env.LARK_APP_SECRET
  if (feishuAppId || feishuAppSecret) {
    const channels = (raw.channels ?? {}) as Record<
      string,
      Record<string, unknown>
    >
    channels.feishu ??= {}
    if (feishuAppId) {
      channels.feishu.appId = feishuAppId
      if (channels.feishu.enabled === undefined) {
        channels.feishu.enabled = true
      }
    }
    if (feishuAppSecret) {
      channels.feishu.appSecret = feishuAppSecret
      if (channels.feishu.enabled === undefined) {
        channels.feishu.enabled = true
      }
    }
    raw.channels = channels
  }

  // QQ Bot channel credentials
  const qqAppId = env.QQ_BOT_APP_ID
  const qqSecret = env.QQ_BOT_SECRET
  const qqToken = env.QQ_BOT_TOKEN
  if (qqAppId || qqSecret || qqToken) {
    const channels = (raw.channels ?? {}) as Record<
      string,
      Record<string, unknown>
    >
    channels.qq ??= {}
    if (qqAppId) channels.qq.appId = qqAppId
    if (qqSecret) channels.qq.secret = qqSecret
    if (qqToken) channels.qq.token = qqToken
    if ((qqAppId || qqSecret) && channels.qq.enabled === undefined) {
      channels.qq.enabled = true
    }
    raw.channels = channels
  }

  // Tool keys
  if (env.BRAVE_API_KEY) {
    const tools = (raw.tools ?? {}) as Record<string, unknown>
    tools.braveApiKey = env.BRAVE_API_KEY
    raw.tools = tools
  }

  if (env.FIRECRAWL_API_KEY) {
    const tools = (raw.tools ?? {}) as Record<string, unknown>
    tools.firecrawlApiKey = env.FIRECRAWL_API_KEY
    raw.tools = tools
  }

  for (const [variable, field] of [['EXA_API_KEY', 'exaApiKey'], ['TAVILY_API_KEY', 'tavilyApiKey']] as const) {
    if (env[variable]) {
      const tools = (raw.tools ?? {}) as Record<string, unknown>
      tools[field] = env[variable]
      raw.tools = tools
    }
  }

  if (env.EXEC_TOOL_DEFAULT_SHELL) {
    const tools = (raw.tools ?? {}) as Record<string, unknown>
    const execTool = (tools.exec ?? {}) as Record<string, unknown>
    execTool.defaultShell = env.EXEC_TOOL_DEFAULT_SHELL
    tools.exec = execTool
    raw.tools = tools
  }

  const windowsMcpEnabled = env.WINDOWS_TOOL_MCP_ENABLE === '1' &&
    env.WINDOWS_TOOL_MCP_PATH

  if (windowsMcpEnabled) {
    const mcp = (raw.mcp ?? {}) as Record<string, unknown>
    const mcpPath = env.WINDOWS_TOOL_MCP_PATH!
    const command = env.WINDOWS_TOOL_MCP_COMMAND ?? 'node'

    if (!('windows-tool' in mcp)) {
      const mcpEnv: Record<string, string> = {}
      if (env.WINDOWS_TOOL_CLI) {
        mcpEnv.WINDOWS_TOOL_CLI = env.WINDOWS_TOOL_CLI!
      }
      if (env.WINDOWS_TOOL_TIMEOUT_MS) {
        mcpEnv.WINDOWS_TOOL_TIMEOUT_MS = env.WINDOWS_TOOL_TIMEOUT_MS!
      }
      if (env.WINDOWS_TOOL_MAX_OUTPUT) {
        mcpEnv.WINDOWS_TOOL_MAX_OUTPUT = env.WINDOWS_TOOL_MAX_OUTPUT!
      }
      mcp['windows-tool'] = {
        type: 'stdio',
        command,
        args: [mcpPath],
        env: Object.keys(mcpEnv).length > 0 ? mcpEnv : undefined,
      }
    }

    raw.mcp = mcp
  }

  raw.providers = providers
}
