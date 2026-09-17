import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { ConfigSchema, type Config } from '../config/schema.ts'
import { ConfigStore, redactConfig, writePrivateFile } from '../config/store.ts'
import { parseModelSpec } from '../providers/aggregated.ts'
import { detectProvider } from '../providers/factory.ts'
import { MODEL_DEFAULT_FIELDS, modelDefaultsState, modelFields, patchModelDefaults, type ModelDefaultsPatch } from '../config/model-defaults.ts'

type Raw = Record<string, unknown>
const record = (value: unknown): value is Raw => !!value && typeof value === 'object' && !Array.isArray(value)

function withProjectLearning(config: Config, raw: Raw): Config {
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

export interface ProjectConfigOptions {
  configPath: string
  home: string
  getSharedConfig: () => Config
  onChanged?: (config: Config) => void | Promise<void>
}

/** Provider setup may probe a model, but cannot select an project's defaults. */
export class AppProviderConfigStore extends ConfigStore {
  async modelDefaults() {
    const raw = await this.read()
    return modelDefaultsState(record(raw.agent) ? raw.agent : {}, ConfigSchema.parse(raw).agent)
  }

  updateModelDefaults(patch: ModelDefaultsPatch, signal?: AbortSignal): Promise<Config> {
    return super.update(raw => ({ ...raw, agent: patchModelDefaults(record(raw.agent) ? raw.agent : {}, patch) }), signal)
  }

  override update(mutate: (raw: Raw) => unknown, signal?: AbortSignal): Promise<Config> {
    return super.update(raw => {
      const next = mutate(structuredClone(raw))
      if (!record(next) || !record(next.providers)) throw new TypeError('Provider configuration must be an object')
      return { ...raw, providers: next.providers }
    }, signal)
  }
}

/** Persists project-owned settings only; shared provider connections never enter this file. */
export class ProjectConfigStore extends ConfigStore {
  #config?: Config
  #legacy?: Config
  #ownedAgent: Raw = {}
  #inner: ConfigStore
  constructor(private readonly scope: ProjectConfigOptions) {
    super()
    this.#inner = new ConfigStore({
      configPath: scope.configPath,
      getConfig: () => this.current(),
      onChanged: async (config, raw) => {
        const ownedAgent = record(raw.agent) ? raw.agent : {}
        const merged = this.#merge(withProjectLearning(config, raw), ownedAgent)
        await scope.onChanged?.(merged)
        this.#ownedAgent = structuredClone(ownedAgent)
        this.#config = merged
      },
    })
  }

  get configPath(): string { return this.scope.configPath }

  #merge(config: Config, ownedAgent = this.#ownedAgent): Config {
    const channels = { ...config.channels }
    if (this.#legacy) {
      for (const id of Object.keys(this.#legacy.channels) as Array<keyof Config['channels']>) {
        Object.assign(channels, { [id]: { ...this.#legacy.channels[id], ...config.channels[id] } })
      }
    }
    const shared = this.scope.getSharedConfig()
    const localAgent: Raw = { ...config.agent }
    for (const key of MODEL_DEFAULT_FIELDS) delete localAgent[key]
    const agent = ConfigSchema.shape.agent.parse({
      ...localAgent, ...modelFields(shared.agent), ...modelFields(ownedAgent), workspace: this.scope.home,
    })
    return { ...config, channels, agent, providers: shared.providers }
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
      raw.agent = legacy
        ? { ...initial.agent, quickModel: initial.agent.quickModel ?? legacyQuickModel, workspace: this.scope.home }
        : { workspace: this.scope.home }
      writePrivateFile(this.scope.configPath, JSON.stringify(raw, null, 2) + '\n')
    }
    const raw = await this.#inner.read()
    if ('providers' in raw) throw new Error('Project configuration must not contain shared providers')
    const parsed = withProjectLearning(ConfigSchema.parse(raw), raw)
    this.#ownedAgent = record(raw.agent) ? structuredClone(raw.agent) : {}
    this.#config = this.#merge(parsed)
    return this.#config
  }

  current(): Config {
    if (!this.#config) throw new Error('ProjectConfigStore.init() must complete first')
    return this.#merge(this.#config)
  }

  async persistedChannels(): Promise<Config['channels']> {
    return ConfigSchema.parse(await this.#inner.read()).channels
  }

  async refreshShared(): Promise<void> {
    await this.#inner.update(raw => raw)
  }

  override async read(): Promise<Raw> {
    return structuredClone(rawConfig(this.current()))
  }

  modelDefaults() {
    return modelDefaultsState(this.#ownedAgent, this.current().agent, this.scope.getSharedConfig().agent)
  }

  updateModelDefaults(patch: ModelDefaultsPatch, signal?: AbortSignal): Promise<Config> {
    return this.updateOwned(raw => raw, signal, patch)
  }

  override async update(mutate: (raw: Raw) => unknown, signal?: AbortSignal): Promise<Config> {
    return this.updateOwned(mutate, signal)
  }

  private async updateOwned(mutate: (raw: Raw) => unknown, signal?: AbortSignal, modelPatch?: ModelDefaultsPatch): Promise<Config> {
    await this.#inner.update(persisted => {
      const previous = rawConfig(this.current())
      const next = mutate(structuredClone(previous))
      if (!record(next)) throw new TypeError('Project configuration must be an object')
      if ('providers' in next && !isDeepStrictEqual(next.providers, previous.providers) &&
        !isDeepStrictEqual(next.providers, redactConfig(previous.providers))) {
        throw new TypeError('Shared providers must be changed through App provider settings')
      }
      if (record(next.agent) && next.agent.workspace !== undefined && next.agent.workspace !== this.scope.home) {
        throw new TypeError('Project Home cannot be changed through configuration')
      }
      const { providers: _providers, ...owned } = next
      if (record(owned.agent) && record(previous.agent)) {
        const agent = { ...owned.agent }
        for (const key of MODEL_DEFAULT_FIELDS) {
          if (!(key in this.#ownedAgent) && isDeepStrictEqual(agent[key], previous.agent[key])) delete agent[key]
        }
        owned.agent = modelPatch ? patchModelDefaults(agent, modelPatch) : agent
      }
      withProjectLearning(ConfigSchema.parse(owned), owned)
      if (record(owned.channels) && record(previous.channels)) {
        const channels = { ...owned.channels }
        const saved = record(persisted.channels) ? persisted.channels : {}
        for (const id of ['qq', 'discord', 'feishu']) {
          if (id in channels && !isDeepStrictEqual(channels[id], previous.channels[id]) &&
            !isDeepStrictEqual(channels[id], redactConfig(previous.channels[id]))) {
            throw new TypeError('Bot configuration must be changed through project bot settings')
          }
          if (id in saved) channels[id] = saved[id]
          else delete channels[id]
        }
        owned.channels = channels
      }
      return owned
    }, signal)
    return this.current()
  }
}
