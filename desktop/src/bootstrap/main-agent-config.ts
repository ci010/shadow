import { randomUUID } from 'node:crypto'
import { assertDataLayoutReady } from './data-layout-startup.js'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

interface ProtectedMainRuntimeConfig {
  readonly version: 1
  readonly mode: 'main'
  readonly dataDir: string
  readonly localNodeId: string
}

interface MainAgentConfig {
  readonly agent: {
    readonly workspace: string
    readonly sessionStorage: 'sqlite'
  }
  readonly channels: {
    readonly web: { readonly enabled: true }
  }
  readonly providers: {
    readonly copilot: Record<string, never>
  }
}

export interface MainAgentConfigInitializer {
  initialize(): Promise<void>
}

export class AtomicMainAgentConfigInitializer implements MainAgentConfigInitializer {
  constructor(private readonly runtimeConfigFilePath: string) {}

  async initialize(): Promise<void> {
    const runtimeConfig = parseProtectedMainRuntimeConfig(
      JSON.parse(await readFile(this.runtimeConfigFilePath, 'utf8')),
    )
    const dataDir = resolve(runtimeConfig.dataDir)
    await assertDataLayoutReady(dataDir)
    const workspace = dataDir
    const configFilePath = join(dataDir, 'app.json')
    const config: MainAgentConfig = {
      agent: { workspace, sessionStorage: 'sqlite' },
      channels: { web: { enabled: true } },
      providers: { copilot: {} },
    }

    await mkdir(dirname(configFilePath), { recursive: true })
    if (await validateExistingConfig(configFilePath, config)) return

    const temporaryPath = join(dirname(configFilePath), `.${randomUUID()}.tmp`)
    try {
      const file = await open(temporaryPath, 'wx', 0o600)
      try {
        await file.writeFile(`${JSON.stringify(config)}\n`, 'utf8')
        await file.sync()
      } finally {
        await file.close()
      }
      await rename(temporaryPath, configFilePath)
    } catch (error) {
      await rm(temporaryPath, { force: true })
      throw error
    }
  }
}

function parseProtectedMainRuntimeConfig(value: unknown): ProtectedMainRuntimeConfig {
  if (!isRecordWithExactKeys(value, ['version', 'mode', 'dataDir', 'localNodeId'])
    || value.version !== 1
    || value.mode !== 'main'
    || typeof value.dataDir !== 'string'
    || !isAbsolute(value.dataDir)
    || resolve(value.dataDir) !== value.dataDir
    || typeof value.localNodeId !== 'string'
    || value.localNodeId.length === 0) {
    throw new TypeError('Protected Main runtime config is invalid')
  }
  return value as unknown as ProtectedMainRuntimeConfig
}

async function validateExistingConfig(filePath: string, expected: MainAgentConfig): Promise<boolean> {
  let contents: string
  try {
    contents = await readFile(filePath, 'utf8')
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return false
    throw error
  }
  let existing: unknown
  try {
    existing = JSON.parse(contents)
  } catch {
    throw new TypeError('Existing Main agent config is incompatible')
  }
  if (!isCompatibleMainAgentConfig(existing, expected)) {
    throw new TypeError('Existing Main agent config is incompatible')
  }
  return true
}

// Desktop checks only the storage boundary and basic shape. The backend owns full
// schema validation; resumed setup must not discard provider/model customization.
function isCompatibleMainAgentConfig(value: unknown, expected: MainAgentConfig): boolean {
  if (!isRecord(value) || !isRecord(value.agent)) return false
  return value.agent.workspace === expected.agent.workspace
    && (value.agent.sessionStorage === undefined || value.agent.sessionStorage === 'sqlite' || value.agent.sessionStorage === 'jsonl')
    && (value.channels === undefined || isRecord(value.channels))
    && (value.providers === undefined || isRecord(value.providers))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isRecordWithExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key))
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}