import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { resolveConfigPath } from './loader.ts'
import { ConfigSchema, type Config } from './schema.ts'

export const REDACTED_SECRET = '__SHADOW_REDACTED__'
type RawConfig = Record<string, unknown>

function isRecord(value: unknown): value is RawConfig {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isSecret(key: string, parent: string): boolean {
  return parent === 'env' || /(?:apiKey|token|secret|password|credential|encryptKey)$/i.test(key)
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

/** Synchronous final commit keeps cancellation, persistence and live activation indivisible. */
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
  onChanged?: (config: Config) => void
}

export class ConfigStore {
  constructor(private readonly options: ConfigStoreOptions = {}) {}

  private async path(): Promise<string> {
    const path = this.options.configPath ?? await resolveConfigPath()
    if (!path) throw new Error('No configuration file is available.')
    return path
  }

  async read(): Promise<RawConfig> {
    return JSON.parse(readFileSync(await this.path(), 'utf8')) as RawConfig
  }

  async update(
    mutate: (raw: RawConfig) => unknown,
    signal?: AbortSignal,
  ): Promise<Config> {
    const path = await this.path()
    signal?.throwIfAborted()
    const previousText = readFileSync(path, 'utf8')
    const previous = JSON.parse(previousText)
    const raw = restoreSecrets(mutate(structuredClone(previous)), previous)
    if (hasPlaceholder(raw)) throw new Error('Unknown credential placeholder.')
    const parsed = ConfigSchema.parse(raw)
    // Preserve environment-only credentials without ever copying them to disk.
    const active = this.options.getConfig?.()
    for (const [name, provider] of Object.entries(parsed.providers)) {
      if (provider.apiKey === undefined && active?.providers[name]?.apiKey) {
        provider.apiKey = active.providers[name].apiKey
      }
    }
    signal?.throwIfAborted()
    writePrivateFile(path, JSON.stringify(raw, null, 2) + '\n')
    try {
      this.options.onChanged?.(parsed)
    } catch {
      writePrivateFile(path, previousText)
      throw new Error('Configuration could not be activated; the previous file was restored.')
    }
    return parsed
  }
}
