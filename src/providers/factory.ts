import type { LLMProvider } from './provider.ts'
import type { Config, ProviderConfig } from '../config/schema.ts'
import { env } from 'node:process'
import { OpenAICompatibleProvider } from './openai-compatible.ts'
import { AnthropicProvider } from './anthropic.ts'
import { CopilotProvider } from './copilot.ts'
import { DeepSeekProvider } from './deepseek.ts'
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
    apiKeyEnv: 'ANTHROPIC_API_KEY',
  },
  copilot: {},
  deepseek: {
    baseUrl: 'https://api.deepseek.com',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
  },
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
): LLMProvider {
  const name = providerName ?? detectProvider(model)
  const providerConfig: ProviderConfig = config.providers[name] ?? {}
  const defaults = PROVIDER_DEFAULTS[name]

  // --- Anthropic (non-OpenAI API) ---
  if (name === 'anthropic') {
    return new AnthropicProvider({
      apiKey: providerConfig.apiKey,
    })
  }

  // --- Copilot (OpenAI-compatible but with custom OAuth auth) ---
  if (name === 'copilot') {
    return new CopilotProvider()
  }

  if (name === 'deepseek') {
    return new DeepSeekProvider(model)
  }

  // --- All other OpenAI-compatible providers ---
  const baseUrl = providerConfig.baseUrl ?? defaults?.baseUrl
  if (!baseUrl) {
    throw new Error(`Provider "${name}" requires a baseUrl`)
  }

  const apiKey = providerConfig.apiKey ??
    (defaults?.apiKeyEnv ? env[defaults.apiKeyEnv] : undefined) ?? ''

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
export function createAggregatedProvider(config: Config): AggregatedProvider {
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
    if (name === 'copilot' || pc.apiKey || pc.baseUrl) names.add(name)
  }

  // Instantiate each provider
  const providers = new Map<string, LLMProvider>()
  for (const name of names) {
    try {
      // Use the bare model for the primary provider, fallback model for others.
      // Pass the provider name explicitly so non-primary providers are created
      // as the right class (the model string alone would detect the primary).
      const model = name === primaryName ? bareModel : mainModel
      providers.set(name, createProvider(model, config, name))
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

  return new AggregatedProvider(providers, primaryName)
}
