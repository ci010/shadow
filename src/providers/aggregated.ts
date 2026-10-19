import type { ToolDefinition } from '../tools/tool.ts'
import { modelMessages } from './message-content.ts'
import type {
  ChatMessage,
  LLMProvider,
  LLMProviderOptions,
  LLMResponse,
  ModelInfo,
} from './provider.ts'

// ---------------------------------------------------------------------------
//  Model spec parsing
// ---------------------------------------------------------------------------

export interface ModelSpec {
  model: string
  provider?: string
}

/**
 * Parse a `model@provider` string into its components.
 * Splits on the **last** `@` so model names containing `/` (e.g. OpenRouter's
 * `anthropic/claude-sonnet-4`) work correctly.
 *
 * - `"gpt-4o@openai"`          → `{ model: "gpt-4o", provider: "openai" }`
 * - `"gpt-4o"`                 → `{ model: "gpt-4o", provider: undefined }`
 * - `"anthropic/claude@openrouter"` → `{ model: "anthropic/claude", provider: "openrouter" }`
 */
export function parseModelSpec(spec: string): ModelSpec {
  const idx = spec.lastIndexOf('@')
  if (idx <= 0) return { model: spec }
  return { model: spec.slice(0, idx), provider: spec.slice(idx + 1) }
}

// ---------------------------------------------------------------------------
//  AggregatedProvider
// ---------------------------------------------------------------------------

/**
 * Wraps multiple {@link LLMProvider} instances and routes requests using the
 * `model@provider` convention.
 *
 * - `"gpt-4o@openai"` → routes to the `openai` provider with model `gpt-4o`
 * - `"gpt-4o"` (no `@`) → routes to the primary provider
 */
export class AggregatedProvider implements LLMProvider {
  readonly name = 'aggregated'

  constructor(
    private readonly providers: Map<string, LLMProvider>,
    private readonly primaryProviderName: string,
    readonly instances: ReadonlyArray<{ id: string; type: string; name?: string }> = [],
  ) {}

  // ── LLMProvider interface ─────────────────────────────────────────────

  chat(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options: LLMProviderOptions,
  ): Promise<LLMResponse> {
    const { provider, options: cleaned } = this.resolve(options)
    return provider.chat(modelMessages(messages), tools, cleaned)
  }

  async listModels(): Promise<string[]> {
    const results: string[] = []
    const entries = Array.from(this.providers.entries())
    // Discovery is best-effort per identity; chat routing below never fails over.
    const lists = await Promise.all(entries.map(async ([, p]) => {
      try { return await p.listModels() } catch { return [] }
    }))
    for (let i = 0; i < entries.length; i++) {
      const [name] = entries[i]
      for (const model of lists[i]) {
        results.push(`${model}@${name}`)
      }
    }
    results.sort()
    return results
  }

  async listModelInfos(): Promise<ModelInfo[]> {
    const entries = Array.from(this.providers.entries())
    const lists = await Promise.all(
      entries.map(async ([, p]) => {
        try {
          return p.listModelInfos
            ? await p.listModelInfos()
            : (await p.listModels()).map((id): ModelInfo => ({ id }))
        } catch { return [] }
      }),
    )
    const results: ModelInfo[] = []
    for (let i = 0; i < entries.length; i++) {
      const [name] = entries[i]
      for (const info of lists[i]) {
        results.push({ ...info, id: `${info.id}@${name}` })
      }
    }
    results.sort((a, b) => a.id.localeCompare(b.id))
    return results
  }

  // ── Public helpers ────────────────────────────────────────────────────

  /** Catalog identity using the same primary-provider rule as chat routing. */
  qualifiedModelId(spec: string): string {
    const { model, provider } = parseModelSpec(spec)
    return `${model}@${provider ?? this.primaryProviderName}`
  }

  /** Look up an underlying provider by name. */
  getProvider(name: string): LLMProvider | undefined {
    return this.providers.get(name)
  }

  /** All registered provider names. */
  get providerNames(): string[] {
    return Array.from(this.providers.keys())
  }

  // ── Internal routing ──────────────────────────────────────────────────

  private resolve(options: LLMProviderOptions): {
    provider: LLMProvider
    options: LLMProviderOptions
  } {
    const spec = options.model
    const { model, provider: providerName } = parseModelSpec(spec)
    if (!providerName) {
      // Bare model name — route to primary
      return { provider: this.primary(), options: { ...options, model } }
    }

    const target = this.providers.get(providerName)
    if (!target) {
      const available = Array.from(this.providers.keys()).join(', ')
      throw new Error(
        `Provider "${providerName}" not configured. Available: ${available}`,
      )
    }
    return { provider: target, options: { ...options, model } }
  }

  private primary(): LLMProvider {
    const p = this.providers.get(this.primaryProviderName)
    if (!p) {
      throw new Error(
        `Primary provider "${this.primaryProviderName}" not found`,
      )
    }
    return p
  }
}
