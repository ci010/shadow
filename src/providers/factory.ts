import type { LLMProvider } from './provider.ts'
import type { Config } from '../config/schema.ts'
import { env } from 'node:process'
import { OpenAICompatibleProvider } from './openai-compatible.ts'
import { AnthropicProvider } from './anthropic.ts'
import { CopilotProvider, CopilotAuthenticator } from './copilot.ts'
import { CopilotAuthenticatorV2, CopilotProviderV2 } from './copilot-v2.ts'
import { DeepSeekProvider } from './deepseek.ts'
import { AgnesProvider } from './agnes.ts'
import { AggregatedProvider, parseModelSpec } from './aggregated.ts'

/**
 * Well-known provider defaults.
 *
 * Every entry except `anthropic` and `copilot` is OpenAI-compatible and
 * handled by the generic `OpenAICompatibleProvider`.
 */
const PROVIDER_DEFAULTS: Record<string, {
  baseUrl?: string
  apiKeyEnv?: string
}> = {
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
  },
  anthropic: {
    baseUrl: 'https://api.anthropic.com/v1',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
  },
  copilot: {},
  'copilot-v2': {},
  'copilot-v1': {},
  deepseek: {
    baseUrl: 'https://api.deepseek.com',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
  },
  agnes: { baseUrl: 'https://apihub.agnes-ai.com/v1', apiKeyEnv: 'AGNES_API_KEY' },
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
  },
  gemini: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKeyEnv: 'GEMINI_API_KEY',
  },
  groq: {
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKeyEnv: 'GROQ_API_KEY',
  },
  stepfun: {
    baseUrl: 'https://api.stepfun.com/v1',
    apiKeyEnv: 'STEPFUN_API_KEY',
  },
  kimi: {
    baseUrl: 'https://api.moonshot.cn/v1',
    apiKeyEnv: 'KIMI_API_KEY',
  },
}

export function providerType(config: Config, id: string): string {
  return config.providers[id]?.type ?? id
}

export function isCopilotProviderType(type: string): boolean {
  return type === 'copilot' || type === 'copilot-v2' || type === 'copilot-v1'
}

/** Setup and inference must use the same instance broker, including rollback. */
export function copilotAuthForInstance(config: Config, id: string, root: CopilotAuthenticator): CopilotAuthenticator {
  if (providerType(config, id) === 'copilot-v1' && root instanceof CopilotAuthenticatorV2) {
    return root.forLegacyInstance(id)
  }
  return root.forInstance(id)
}

export function knownProviderNames(): string[] {
  return Object.keys(PROVIDER_DEFAULTS)
}

/**
 * Auto-detect the provider name from a model identifier.
 *
 * Copilot-flavoured Claude models use dot-version syntax (e.g. `claude-sonnet-4.6`),
 * while Anthropic API models use date suffixes (e.g. `claude-sonnet-4-20250514`).
 */
export function detectProvider(model: string): string {
  // Claude models — dot-version → copilot, date-version → anthropic
  if (model.startsWith('claude-')) {
    return /\d+\.\d+/.test(model) ? 'copilot' : 'anthropic'
  }
  // OpenAI
  if (/^(gpt-|o[134]-|o[134]$)/.test(model)) return 'openai'
  // DeepSeek
  if (model.startsWith('deepseek-')) return 'deepseek'
  if (model.startsWith('agnes-')) return 'agnes'
  // Google Gemini
  if (model.startsWith('gemini-')) return 'gemini'
  // Groq-hosted open models
  if (/^(llama|mixtral|gemma)/.test(model)) return 'groq'
  // Moonshot / Kimi
  if (model.startsWith('moonshot-') || model.startsWith('kimi-')) return 'kimi'
  // StepFun
  if (model.startsWith('step-')) return 'stepfun'
  // OpenRouter (slash-qualified model names)
  if (model.includes('/')) return 'openrouter'

  return 'openai'
}

/** Shared by construction and onboarding; custom endpoints may intentionally be keyless. */
export function resolveProviderSettings(config: Config, name: string): {
  apiKey: string
  baseUrl?: string
  authMode: 'api-key' | 'copilot' | 'none'
} {
  const configured = config.providers[name] ?? {}
  const type = providerType(config, name)
  const defaults = PROVIDER_DEFAULTS[type]
  const apiKey = configured.apiKey ??
    (name === type && defaults?.apiKeyEnv ? env[defaults.apiKeyEnv] : undefined) ?? ''
  const baseUrl = configured.baseUrl ?? defaults?.baseUrl
  const customEndpoint = !!configured.baseUrl &&
    configured.baseUrl.replace(/\/+$/, '') !== defaults?.baseUrl?.replace(/\/+$/, '')
  return {
    apiKey, baseUrl,
    authMode: isCopilotProviderType(type) ? 'copilot'
      : !apiKey && customEndpoint ? 'none' : 'api-key',
  }
}

/**
 * Instantiate a provider for the given model, using per-provider config
 * from `config.providers[providerName]` when available.
 *
 * The provider is auto-detected from the model name.
 * `anthropic` and `copilot` need specialised classes (different API format /
 * custom auth). Everything else is OpenAI-compatible and uses a single
 * generic `OpenAICompatibleProvider` backed by `fetch`.
 */
export function createProvider(
  model: string,
  config: Config,
  providerName?: string,
  copilotAuth?: CopilotAuthenticator,
): LLMProvider {
  const name = providerName ?? detectProvider(model)
  if (providerName && !config.providers[name] && !PROVIDER_DEFAULTS[name]) throw new Error(`Unknown provider instance "${name}"`)
  const type = providerType(config, name)
  const { apiKey, baseUrl } = resolveProviderSettings(config, name)

  // --- Anthropic (non-OpenAI API) ---
  if (type === 'anthropic') {
    return new AnthropicProvider({
      apiKey,
      baseUrl,
    })
  }

  // --- Copilot (OpenAI-compatible but with custom OAuth auth) ---
  if (isCopilotProviderType(type)) {
    const root = copilotAuth ?? new CopilotAuthenticatorV2()
    const auth = copilotAuthForInstance(config, name, root)
    return type === 'copilot-v1' ? new CopilotProvider(auth) : new CopilotProviderV2(auth)
  }

  if (type === 'deepseek') {
    return new DeepSeekProvider(model, { apiKey, baseUrl })
  }

  if (type === 'agnes') return new AgnesProvider(model, { apiKey, baseUrl })

  // --- All other OpenAI-compatible providers ---
  if (!baseUrl) {
    throw new Error(`Provider "${name}" requires a baseUrl`)
  }

  return new OpenAICompatibleProvider(name, apiKey, baseUrl, model)
}

// ---------------------------------------------------------------------------
//  Aggregated provider factory
// ---------------------------------------------------------------------------

/**
 * Create an {@link AggregatedProvider} that wraps providers detected from
 * the configured model names.
 *
 * Provider names are auto-detected from:
 *   1. `config.agent.model` (primary)
 *   2. `@provider` suffixes in `config.agent.model` / `config.agent.quickModel`
 *   3. Any providers with explicit config in `config.providers`
 */
export function createAggregatedProvider(config: Config, copilotAuth?: CopilotAuthenticator): AggregatedProvider {
  const mainModel = config.agent.model
  const { model: bareModel, provider: explicitProvider } = parseModelSpec(
    mainModel,
  )
  const primaryName = explicitProvider ?? detectProvider(bareModel)

  // Collect provider names to instantiate
  const names = new Set<string>([primaryName])

  // Providers referenced via model@provider in quickModel
  if (config.agent.quickModel) {
    const { provider } = parseModelSpec(config.agent.quickModel)
    if (provider) names.add(provider)
  }

  // Providers with explicit config entries. Copilot authenticates via OAuth
  // (no apiKey/baseUrl), so an empty `providers.copilot: {}` entry enables it.
  for (const [name, pc] of Object.entries(config.providers)) {
    if (isCopilotProviderType(providerType(config, name)) || pc.apiKey || pc.baseUrl) names.add(name)
  }

  // Instantiate each provider
  const providers = new Map<string, LLMProvider>()
  for (const name of names) {
    try {
      // Use the bare model for the primary provider, fallback model for others.
      // Pass the provider name explicitly so non-primary providers are created
      // as the right class (the model string alone would detect the primary).
      const model = name === primaryName ? bareModel : mainModel
      providers.set(name, createProvider(model, config, name, copilotAuth))
    } catch (err) {
      console.warn(
        `[aggregated] Failed to create provider "${name}": ${
          err instanceof Error ? err.message : err
        }`,
      )
    }
  }

  if (!providers.has(primaryName)) {
    throw new Error(
      `Primary provider "${primaryName}" could not be created`,
    )
  }

  return new AggregatedProvider(providers, primaryName, [...providers.keys()].map(id => ({
    id, type: providerType(config, id), name: config.providers[id]?.name,
  })))
}
