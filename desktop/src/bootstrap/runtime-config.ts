import { randomUUID } from 'node:crypto'
import { assertDataLayoutReady } from './data-layout-startup.js'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { isAbsolute, dirname, join, parse, resolve } from 'node:path'

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
    const absoluteDataDir = normalizeMainDirectoryPath(dataDir)
    let existing: MainRuntimeConfig | undefined
    try {
      existing = await new FileRuntimeConfigReader(this.filePath).readMain()
    } catch (error) {
      if (!isMissingRuntimeConfig(error)) throw error
    }
    await assertDataLayoutReady(absoluteDataDir)
    const config: MainRuntimeConfig = {
      version: 1,
      mode: 'main',
      dataDir: absoluteDataDir,
      localNodeId: existing?.localNodeId ?? this.localNodeIdFactory(),
    }
    await mkdir(absoluteDataDir, { recursive: true })
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

export function normalizeMainDirectoryPath(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 32_767
    || /[\u0000-\u001f]/u.test(value)
    || !isAbsolute(value)
    || (process.platform === 'win32' && parse(value).root.length < 3)
  ) {
    throw new TypeError('Main directory must be a full absolute path')
  }
  return resolve(value)
}

export function isMissingRuntimeConfig(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
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
    dataDir: normalizeMainDirectoryPath(candidate.dataDir),
    localNodeId: candidate.localNodeId,
  }
}