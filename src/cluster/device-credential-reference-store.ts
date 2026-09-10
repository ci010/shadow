import { dirname, join } from 'node:path'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { isNotFoundError } from '../utils/runtime.ts'
import {
  type DeviceCredentialReferenceV1,
  validateDeviceCredentialReferenceV1,
} from './device-credentials.ts'

export interface DeviceCredentialReferenceStore {
  load(): Promise<unknown | null>
  save(reference: DeviceCredentialReferenceV1): Promise<void>
}

export class AtomicDeviceCredentialReferenceStore
  implements DeviceCredentialReferenceStore {
  constructor(readonly filePath: string) {}

  async load(): Promise<DeviceCredentialReferenceV1 | null> {
    let contents: string
    try {
      contents = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if (isNotFoundError(error)) return null
      throw error
    }
    const validation = validateDeviceCredentialReferenceV1(
      JSON.parse(contents),
    )
    if (!validation.success) {
      throw new TypeError(validation.errors.join('; '))
    }
    return structuredClone(validation.value)
  }

  async save(reference: DeviceCredentialReferenceV1): Promise<void> {
    const validation = validateDeviceCredentialReferenceV1(reference)
    if (!validation.success) {
      throw new TypeError(validation.errors.join('; '))
    }
    const directory = dirname(this.filePath)
    await mkdir(directory, { recursive: true })
    const temporaryPath = join(directory, `.${crypto.randomUUID()}.tmp`)
    try {
      await writeFile(
        temporaryPath,
        `${JSON.stringify(validation.value)}\n`,
        { flag: 'wx', mode: 0o600 },
      )
      await rename(temporaryPath, this.filePath)
    } catch (error) {
      await rm(temporaryPath).catch((removeError) => {
        if (!isNotFoundError(removeError)) throw removeError
      })
      throw error
    }
  }
}