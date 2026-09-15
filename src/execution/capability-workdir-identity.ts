import { createHash } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import type { WorkdirCapabilityBinding } from './capability-filesystem.ts'
import type { JobRequestV1 } from './contracts.ts'
import type { LocalJobOperationHandler } from './local-executor.ts'
import { MAX_WORKDIR_ANCESTORS, WORKDIR_IDENTITY_OPERATION, type WorkdirIdentityV1 } from './workdir-identity.ts'

export class CapabilityWorkdirIdentity implements LocalJobOperationHandler {
  readonly #roots = new Map<string, string>()

  constructor(bindings: readonly WorkdirCapabilityBinding[]) {
    for (const binding of bindings) {
      if (!binding.capabilityId || this.#roots.has(binding.capabilityId) || !isAbsolute(binding.rootPath)) {
        throw new TypeError('Workdir identity bindings require unique IDs and absolute roots')
      }
      this.#roots.set(binding.capabilityId, binding.rootPath)
    }
  }

  handles(operation: string): boolean { return operation === WORKDIR_IDENTITY_OPERATION }

  async execute(request: JobRequestV1, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted()
    const root = this.#roots.get(request.capabilityId)
    if (!root || !this.handles(request.operation)) throw new Error('Workdir identity capability is not registered')
    if (!request.args || typeof request.args !== 'object' || Array.isArray(request.args) ||
      Object.keys(request.args).length) throw new TypeError('Workdir identity accepts no arguments')
    let current = await realpath(root)
    const ids: string[] = []
    while (true) {
      signal.throwIfAborted()
      const info = await stat(current, { bigint: true })
      if (!info.isDirectory() || info.ino === 0n) throw new Error('Stable directory identity is unavailable on this filesystem')
      // Device/inode identity follows the actual filesystem's case and alias semantics,
      // without exposing a physical path or depending on a capability's display text.
      ids.push(createHash('sha256').update(`workdir-identity-v1:${info.dev}:${info.ino}`).digest('hex'))
      const parent = dirname(current)
      if (parent === current) break
      if (ids.length > MAX_WORKDIR_ANCESTORS) throw new Error('Workdir ancestor identity limit exceeded')
      current = await realpath(parent)
    }
    const identity: WorkdirIdentityV1 = { version: 1, rootId: ids[0], ancestorIds: ids.slice(1) }
    return JSON.stringify(identity)
  }
}
