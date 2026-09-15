import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { readFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { ConfigSchema, type Config } from '../config/schema.ts'
import { ConfigStore, redactConfig, writePrivateFile } from '../config/store.ts'
import { parseModelSpec } from '../providers/aggregated.ts'
import { detectProvider } from '../providers/factory.ts'

type Raw = Record<string, unknown>
const record = (value: unknown): value is Raw => !!value && typeof value === 'object' && !Array.isArray(value)

function withOrganizationLearning(config: Config, raw: Raw): Config {
  const value = record(raw.learning) ? raw.learning : {}
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') throw new TypeError('Learning enabled must be a boolean')
  for (const interval of Object.values(config.learning)) {
    if (!Number.isInteger(interval) || interval < 1 || interval > 2_147_483_647) throw new TypeError('Learning intervals must be positive timer intervals')
  }
  const learning = { ...config.learning, enabled: value.enabled !== false }
  return { ...config, learning }
}

function rawConfig(config: Config): Raw {
  return {
    ...config,
    mcp: Object.fromEntries(config.mcp.servers.map(({ name, transport, ...server }) => [name, { ...server, type: transport }])),
  }
}

export interface OrganizationConfigOptions {
  configPath: string
  home: string
  getSharedConfig: () => Config
  onChanged?: (config: Config) => void
}

/** Provider setup may probe a model, but cannot select an organization's defaults. */
export class AppProviderConfigStore extends ConfigStore {
  override update(mutate: (raw: Raw) => unknown, signal?: AbortSignal): Promise<Config> {
    return super.update(raw => {
      const next = mutate(structuredClone(raw))
      if (!record(next) || !record(next.providers)) throw new TypeError('Provider configuration must be an object')
      return { ...raw, providers: next.providers }
    }, signal)
  }
}

/** Persists organization-owned settings only; shared provider connections never enter this file. */
export class OrganizationConfigStore extends ConfigStore {
  #config?: Config
  #legacy?: Config
  #inner: ConfigStore
  constructor(private readonly scope: OrganizationConfigOptions) {
    super()
    this.#inner = new ConfigStore({
      configPath: scope.configPath,
      getConfig: () => this.current(),
      onChanged: config => {
        const raw = JSON.parse(readFileSync(scope.configPath, 'utf8')) as Raw
        const merged = this.#merge(withOrganizationLearning(config, raw))
        scope.onChanged?.(merged)
        this.#config = merged
      },
    })
  }

  get configPath(): string { return this.scope.configPath }

  #merge(config: Config): Config {
    const channels = { ...config.channels }
    if (this.#legacy) {
      for (const id of Object.keys(this.#legacy.channels) as Array<keyof Config['channels']>) {
        Object.assign(channels, { [id]: { ...this.#legacy.channels[id], ...config.channels[id] } })
      }
    }
    return { ...config, channels, agent: { ...config.agent, workspace: this.scope.home }, providers: this.scope.getSharedConfig().providers }
  }

  async init(legacy?: Config, serializedLegacy?: Raw): Promise<Config> {
    this.#legacy = legacy
    await mkdir(dirname(this.scope.configPath), { recursive: true })
    try {
      await readFile(this.scope.configPath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const initial = legacy ?? ConfigSchema.parse({ channels: {}, mcp: {} })
      const { providers: _providers, ...raw } = serializedLegacy ?? rawConfig(initial)
      if (legacy && !serializedLegacy) raw.channels = {}
      raw.mcp = rawConfig(initial).mcp
      const parsedModel = parseModelSpec(initial.agent.model)
      const legacyQuickModel = legacy?.providers[parsedModel.provider ?? detectProvider(parsedModel.model)]?.quickModel
      raw.agent = { ...initial.agent, quickModel: initial.agent.quickModel ?? legacyQuickModel, workspace: this.scope.home }
      writePrivateFile(this.scope.configPath, JSON.stringify(raw, null, 2) + '\n')
    }
    const raw = await this.#inner.read()
    if ('providers' in raw) throw new Error('Organization configuration must not contain shared providers')
    const parsed = withOrganizationLearning(ConfigSchema.parse(raw), raw)
    this.#config = this.#merge(parsed)
    return this.#config
  }

  current(): Config {
    if (!this.#config) throw new Error('OrganizationConfigStore.init() must complete first')
    return this.#merge(this.#config)
  }

  async persistedChannels(): Promise<Config['channels']> {
    return ConfigSchema.parse(await this.#inner.read()).channels
  }

  refreshShared(): void {
    const config = this.current()
    this.scope.onChanged?.(config)
    this.#config = config
  }

  override async read(): Promise<Raw> {
    return rawConfig(this.current())
  }

  override async update(mutate: (raw: Raw) => unknown, signal?: AbortSignal): Promise<Config> {
    const previous = await this.read()
    const next = mutate(structuredClone(previous))
    if (!record(next)) throw new TypeError('Organization configuration must be an object')
    if ('providers' in next && !isDeepStrictEqual(next.providers, previous.providers) &&
      !isDeepStrictEqual(next.providers, redactConfig(previous.providers))) {
      throw new TypeError('Shared providers must be changed through App provider settings')
    }
    if (record(next.agent) && next.agent.workspace !== undefined && next.agent.workspace !== this.scope.home) {
      throw new TypeError('Organization Home cannot be changed through configuration')
    }
    const { providers: _providers, ...owned } = next
    withOrganizationLearning(ConfigSchema.parse(owned), owned)
    const persisted = await this.#inner.read()
    if (record(owned.channels) && record(previous.channels)) {
      const channels = { ...owned.channels }
      const saved = record(persisted.channels) ? persisted.channels : {}
      for (const id of ['qq', 'discord', 'feishu']) {
        if (id in channels && !isDeepStrictEqual(channels[id], previous.channels[id]) &&
          !isDeepStrictEqual(channels[id], redactConfig(previous.channels[id]))) {
          throw new TypeError('Bot configuration must be changed through organization bot settings')
        }
        if (id in saved) channels[id] = saved[id]
        else delete channels[id]
      }
      owned.channels = channels
    }
    await this.#inner.update(() => owned, signal)
    return this.current()
  }
}
