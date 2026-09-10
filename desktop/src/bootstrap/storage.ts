import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { parseWizardState, type WizardState } from '../wizard/state-machine.js'

export interface BootstrapStateStorage {
  load(): Promise<WizardState | null>
  save(state: WizardState): Promise<void>
  clear(): Promise<void>
}

export class AtomicFileBootstrapStateStorage implements BootstrapStateStorage {
  constructor(readonly filePath: string) {}

  async load(): Promise<WizardState | null> {
    let contents: string
    try {
      contents = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return null
      throw error
    }
    return parseWizardState(JSON.parse(contents))
  }

  async save(state: WizardState): Promise<void> {
    const directory = dirname(this.filePath)
    await mkdir(directory, { recursive: true })
    const temporaryPath = join(directory, `.${randomUUID()}.tmp`)
    const file = await open(temporaryPath, 'wx', 0o600)
    try {
      await file.writeFile(`${JSON.stringify(parseWizardState(state), null, 2)}\n`, 'utf8')
      await file.sync()
    } finally {
      await file.close()
    }

    try {
      await rename(temporaryPath, this.filePath)
    } catch (error) {
      await rm(temporaryPath, { force: true })
      throw error
    }
  }

  async clear(): Promise<void> {
    await rm(this.filePath, { force: true })
  }
}

export function bootstrapStatePath(userDataPath: string): string {
  return join(userDataPath, 'bootstrap', 'wizard-state.v1.json')
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}