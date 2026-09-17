import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { resolveConfigPath } from './loader.ts'
import { ChannelsSchema, ConfigSchema, type Config } from './schema.ts'

export const REDACTED_SECRET = '__SHADOW_REDACTED__'
type RawConfig = Record<string, unknown>

function isRecord(value: unknown): value is RawConfig {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isSecret(key: string, parent: string): boolean {
  return parent === 'env' || /(?:apiKey|token|secret|password|credential|encryptKey)$/i.test(key)
}

function restoreExplicitPlaceholders(next: unknown, previous: unknown): unknown {
  if (next === REDACTED_SECRET && typeof previous === 'string') return previous
  if (Array.isArray(next)) return next.map((value, index) =>
    restoreExplicitPlaceholders(value, Array.isArray(previous) ? previous[index] : undefined))
  if (!isRecord(next)) return next
  return Object.fromEntries(Object.entries(next).map(([key, value]) => [
    key, restoreExplicitPlaceholders(value, isRecord(previous) && Object.hasOwn(previous, key) ? previous[key] : undefined),
  ]))
}

export function redactConfig(value: unknown, parent = ''): unknown {
  if (Array.isArray(value)) return value.map((entry) => redactConfig(entry, parent))
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    isSecret(key, parent) && typeof item === 'string' && item
      ? REDACTED_SECRET
      : redactConfig(item, key),
  ]))
}

function restoreSecrets(next: unknown, previous: unknown, parent = ''): unknown {
  // MCP is an editable document: omission means deletion, not secret retention.
  if (parent === 'mcp') return restoreExplicitPlaceholders(next, previous)
  if (Array.isArray(next)) return next.map((value, index) =>
    restoreSecrets(value, Array.isArray(previous) ? previous[index] : undefined, parent))
  if (!isRecord(next)) return next
  const result = { ...next }
  if (isRecord(previous)) {
    for (const [key, value] of Object.entries(previous)) {
      if (isSecret(key, parent) && (result[key] === undefined || result[key] === REDACTED_SECRET)) {
        result[key] = value
      } else if (key in result) {
        result[key] = restoreSecrets(result[key], value, key)
      }
    }
  }
  return result
}

function hasPlaceholder(value: unknown): boolean {
  if (value === REDACTED_SECRET) return true
  if (Array.isArray(value)) return value.some(hasPlaceholder)
  return isRecord(value) && Object.values(value).some(hasPlaceholder)
}

/** Replace a persisted document atomically, without exposing a partially written file. */
export function writePrivateFile(path: string, content: string): void {
  const staging = `${path}.${randomUUID()}.new`
  try {
    writeFileSync(staging, content, { mode: 0o600, flag: 'wx' })
    chmodSync(staging, 0o600)
    renameSync(staging, path)
  } finally {
    rmSync(staging, { force: true })
  }
}

export interface ConfigStoreOptions {
  configPath?: string
  getConfig?: () => Config
  onChanged?: (config: Config, raw: RawConfig) => void | Promise<void>
}

export class ConfigStore {
  private snapshot?: { path: string; text: string; raw: RawConfig }
  private loading?: Promise<void>
  private pending: Promise<unknown> = Promise.resolve()

  constructor(private readonly options: ConfigStoreOptions = {}) {}

  private async load(): Promise<void> {
    if (this.snapshot) return
    this.loading ??= (async () => {
      const path = this.options.configPath ?? await resolveConfigPath()
      if (!path) throw new Error('No configuration file is available.')
      const text = readFileSync(path, 'utf8')
      const raw: unknown = JSON.parse(text)
      if (!isRecord(raw)) throw new TypeError('Configuration must be an object.')
      ConfigSchema.parse(raw)
      this.snapshot = { path, text, raw }
    })().finally(() => { this.loading = undefined })
    await this.loading
  }

  async read(): Promise<RawConfig> {
    await this.load()
    return structuredClone(this.snapshot!.raw)
  }

  update(
    mutate: (raw: RawConfig) => unknown,
    signal?: AbortSignal,
  ): Promise<Config> {
    const next = this.pending.catch(() => {}).then(() => this.commit(mutate, signal))
    this.pending = next
    return next
  }

  private async commit(mutate: (raw: RawConfig) => unknown, signal?: AbortSignal): Promise<Config> {
    signal?.throwIfAborted()
    await this.load()
    const { path, text: previousText, raw: previous } = this.snapshot!
    const raw = restoreSecrets(mutate(structuredClone(previous)), previous)
    if (!isRecord(raw)) throw new TypeError('Configuration must be an object.')
    if (hasPlaceholder(raw)) throw new Error('Unknown credential placeholder.')
    const parsed = ConfigSchema.parse(raw)
    // Preserve environment-only credentials without ever copying them to disk.
    const active = this.options.getConfig?.()
    for (const [name, provider] of Object.entries(parsed.providers)) {
      if (provider.apiKey === undefined && active?.providers[name]?.apiKey) {
        provider.apiKey = active.providers[name].apiKey
      }
    }
    const previousProviders = isRecord(previous.providers) ? previous.providers : {}
    const nextProviders = isRecord(raw.providers) ? raw.providers : {}
    for (const [name, provider] of Object.entries(active?.providers ?? {})) {
      const before = isRecord(previousProviders[name]) ? previousProviders[name] : {}
      const after = isRecord(nextProviders[name]) ? nextProviders[name] : {}
      if (before.apiKey === undefined && after.apiKey === undefined && provider.apiKey) {
        parsed.providers[name] ??= {}
        parsed.providers[name].apiKey = provider.apiKey
      }
    }
    const beforeTools = isRecord(previous.tools) ? previous.tools : {}
    const afterTools = isRecord(raw.tools) ? raw.tools : {}
    for (const key of ['braveApiKey', 'firecrawlApiKey'] as const) {
      if (beforeTools[key] === undefined && afterTools[key] === undefined && active?.tools[key] !== undefined) {
        parsed.tools[key] = active.tools[key]
      }
    }
    const beforeExec = isRecord(beforeTools.exec) ? beforeTools.exec : {}
    const afterExec = isRecord(afterTools.exec) ? afterTools.exec : {}
    if (beforeExec.defaultShell === undefined && afterExec.defaultShell === undefined && active?.tools.exec?.defaultShell) {
      parsed.tools.exec = { timeoutMs: 60_000, maxOutputBytes: 10_000, ...parsed.tools.exec, defaultShell: active.tools.exec.defaultShell }
    }
    const beforeMcp = isRecord(previous.mcp) ? previous.mcp : {}
    const afterMcp = isRecord(raw.mcp) ? raw.mcp : {}
    for (const server of active?.mcp.servers ?? []) {
      if (!(server.name in beforeMcp) && !(server.name in afterMcp)) parsed.mcp.servers.push(structuredClone(server))
    }
    // Channel setup also supports environment-only credentials. Keep those in
    // memory, without copying them into the serialized document.
    for (const id of ['qq', 'feishu', 'discord'] as const) {
      const current: Record<string, unknown> | undefined = active?.channels[id]
      if (!current) continue
      const rawChannels = isRecord(raw) && isRecord(raw.channels) ? raw.channels : {}
      const entry = isRecord(rawChannels[id]) ? rawChannels[id] : {}
      const previousChannels = isRecord(previous.channels) ? previous.channels : {}
      const previousEntry = isRecord(previousChannels[id]) ? previousChannels[id] : {}
      const inherited: Record<string, unknown> = {}
      for (const field of ['appId', 'secret', 'token', 'appSecret', 'encryptKey', 'verificationToken']) {
        if (entry[field] === undefined && previousEntry[field] === undefined && current[field] !== undefined) {
          inherited[field] = current[field]
        }
      }
      if (!Object.keys(inherited).length) continue
      if (entry.enabled === undefined) inherited.enabled = current.enabled
      Object.assign(parsed.channels, ChannelsSchema.parse({
        [id]: { ...parsed.channels[id], ...inherited },
      }))
    }
    signal?.throwIfAborted()
    const text = JSON.stringify(raw, null, 2) + '\n'
    if (readFileSync(path, 'utf8') !== previousText) {
      throw new Error('Configuration changed on disk; reload the runtime before updating it. No file was overwritten.')
    }
    if (text !== previousText) writePrivateFile(path, text)
    try {
      await this.options.onChanged?.(parsed, structuredClone(raw))
    } catch (cause) {
      if (text !== previousText) {
        if (readFileSync(path, 'utf8') !== text) {
          throw new Error('Configuration activation failed and the file changed externally; the external edit was preserved. Reload the runtime.', { cause })
        }
        writePrivateFile(path, previousText)
      }
      throw new Error('Configuration could not be activated; the previous file was restored.', { cause })
    }
    this.snapshot = { path, text, raw: structuredClone(raw) }
    return parsed
  }
}
