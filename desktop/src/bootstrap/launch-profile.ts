import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export interface MainLaunchProfile {
  readonly version: 1
  readonly role: 'main'
  readonly port: number
  readonly localExecutor: boolean
}

export interface ChildLaunchProfile {
  readonly version: 1
  readonly role: 'child'
  readonly port: number
}
export type LaunchProfile = MainLaunchProfile | ChildLaunchProfile

export interface LaunchProfileStore {
  load(): Promise<LaunchProfile | null>
  save(profile: LaunchProfile): Promise<void>
}

export class AtomicLaunchProfileStore implements LaunchProfileStore {
  constructor(readonly filePath: string) {}

  async load(): Promise<LaunchProfile | null> {
    let contents: string
    try {
      contents = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return null
      throw error
    }
    return parseLaunchProfile(JSON.parse(contents))
  }

  async save(profile: LaunchProfile): Promise<void> {
    const value = parseLaunchProfile(profile)
    const directory = dirname(this.filePath)
    await mkdir(directory, { recursive: true })
    const temporaryPath = join(directory, `.${randomUUID()}.tmp`)
    try {
      const file = await open(temporaryPath, 'wx', 0o600)
      try {
        await file.writeFile(`${JSON.stringify(value)}\n`, 'utf8')
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

export function parseLaunchProfile(value: unknown): LaunchProfile {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const candidate = value as Record<string, unknown>
    if (candidate.role === 'child' && candidate.version === 1 && Object.keys(candidate).length === 3
      && Number.isSafeInteger(candidate.port) && (candidate.port as number) >= 1 && (candidate.port as number) <= 65_535) {
      return { version: 1, role: 'child', port: candidate.port as number }
    }
  }
  return parseMainLaunchProfile(value)
}

export function parseMainLaunchProfile(value: unknown): MainLaunchProfile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Launch profile is invalid')
  }
  const candidate = value as Record<string, unknown>
  if (
    Object.keys(candidate).length !== 4
    || candidate.version !== 1
    || candidate.role !== 'main'
    || !Number.isSafeInteger(candidate.port)
    || (candidate.port as number) < 1
    || (candidate.port as number) > 65_535
    || typeof candidate.localExecutor !== 'boolean'
  ) {
    throw new TypeError('Launch profile is invalid')
  }
  return {
    version: 1,
    role: 'main',
    port: candidate.port as number,
    localExecutor: candidate.localExecutor,
  }
}

export function launchProfilePath(userDataPath: string): string {
  return join(userDataPath, 'bootstrap', 'launch-profile.v1.json')
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}