import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { isAbsolute, dirname, join, resolve } from 'node:path'

export interface MainRuntimeConfig {
  readonly version: 1
  readonly mode: 'main'
  readonly dataDir: string
  readonly localNodeId: string
}

export type LocalNodeIdFactory = () => string

export interface RuntimeConfigWriter {
  writeMain(dataDir: string): Promise<void>
}

export interface RuntimeConfigReader {
  readMain(): Promise<MainRuntimeConfig>
}

export class FileRuntimeConfigReader implements RuntimeConfigReader {
  constructor(readonly filePath: string) {}

  async readMain(): Promise<MainRuntimeConfig> {
    return parseMainRuntimeConfig(JSON.parse(await readFile(this.filePath, 'utf8')))
  }
}

export class AtomicRuntimeConfigWriter implements RuntimeConfigWriter {
  constructor(
    readonly filePath: string,
    private readonly localNodeIdFactory: LocalNodeIdFactory = randomUUID,
  ) {}

  async writeMain(dataDir: string): Promise<void> {
    const absoluteDataDir = resolve(dataDir)
    if (!isAbsolute(absoluteDataDir)) throw new TypeError('Data directory must be absolute')
    const config: MainRuntimeConfig = {
      version: 1,
      mode: 'main',
      dataDir: absoluteDataDir,
      localNodeId: this.localNodeIdFactory(),
    }
    const directory = dirname(this.filePath)
    await mkdir(directory, { recursive: true })
    const temporaryPath = join(directory, `.${randomUUID()}.tmp`)
    try {
      const file = await open(temporaryPath, 'wx', 0o600)
      try {
        await file.writeFile(`${JSON.stringify(config)}\n`, 'utf8')
        await file.sync()
      } finally {
        await file.close()
      }
      await rename(temporaryPath, this.filePath)
    } catch (error) {
      await rm(temporaryPath, { force: true })
      throw error
    }
  }
}

export function runtimeConfigPath(userDataPath: string): string {
  return join(userDataPath, 'bootstrap', 'runtime-config.v1.json')
}

export function parseMainRuntimeConfig(value: unknown): MainRuntimeConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Runtime config is invalid')
  }
  const candidate = value as Record<string, unknown>
  if (
    Object.keys(candidate).length !== 4
    || candidate.version !== 1
    || candidate.mode !== 'main'
    || typeof candidate.dataDir !== 'string'
    || !isAbsolute(candidate.dataDir)
    || typeof candidate.localNodeId !== 'string'
    || candidate.localNodeId.length === 0
  ) {
    throw new TypeError('Runtime config is invalid')
  }
  return {
    version: 1,
    mode: 'main',
    dataDir: candidate.dataDir,
    localNodeId: candidate.localNodeId,
  }
}