import type { RegistrySnapshotV1 } from './contracts.ts'
import { dirname, join } from 'node:path'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { isNotFoundError } from '../utils/runtime.ts'
import type { InMemoryPairingNodeRegistry } from './registry.ts'

export interface RegistrySnapshotAdapter {
  load(): Promise<unknown | null>
  save(snapshot: RegistrySnapshotV1): Promise<void>
}

export class InMemoryRegistrySnapshotAdapter implements RegistrySnapshotAdapter {
  #snapshot: RegistrySnapshotV1 | null = null

  load(): Promise<RegistrySnapshotV1 | null> {
    return Promise.resolve(this.#snapshot === null ? null : structuredClone(this.#snapshot))
  }

  save(snapshot: RegistrySnapshotV1): Promise<void> {
    this.#snapshot = structuredClone(snapshot)
    return Promise.resolve()
  }
}

export class AtomicFileRegistrySnapshotAdapter
  implements RegistrySnapshotAdapter {
  constructor(readonly filePath: string) {}

  async load(): Promise<unknown | null> {
    let contents: string
    try {
      contents = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if (isNotFoundError(error)) return null
      throw error
    }
    return JSON.parse(contents)
  }

  async save(snapshot: RegistrySnapshotV1): Promise<void> {
    const directory = dirname(this.filePath)
    await mkdir(directory, { recursive: true })
    const temporaryPath = join(directory, `.${crypto.randomUUID()}.tmp`)
    try {
      const file = await open(temporaryPath, 'wx', 0o600)
      try {
        const contents = new TextEncoder().encode(
          `${JSON.stringify(snapshot)}\n`,
        )
        await file.writeFile(contents)
        await file.sync()
      } finally {
        await file.close()
      }
      await rename(temporaryPath, this.filePath)
    } catch (error) {
      await rm(temporaryPath).catch((removeError) => {
        if (!isNotFoundError(removeError)) throw removeError
      })
      throw error
    }
  }
}

export class RegistrySnapshotCoordinator {
  #saveQueue: Promise<void> = Promise.resolve()

  constructor(
    readonly registry: InMemoryPairingNodeRegistry,
    readonly adapter: RegistrySnapshotAdapter,
  ) {}

  async restore(now = new Date()): Promise<boolean> {
    const snapshot = await this.adapter.load()
    if (snapshot === null) return false
    this.registry.restoreSnapshot(snapshot, now)
    return true
  }

  save(now = new Date()): Promise<void> {
    const snapshot = this.registry.exportSnapshot(now)
    const save = this.#saveQueue.catch(() => {}).then(() =>
      this.adapter.save(snapshot)
    )
    this.#saveQueue = save
    return save
  }

  flush(): Promise<void> {
    return this.#saveQueue
  }
}