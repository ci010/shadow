import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, readdir, realpath, rename, unlink } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isClusterIdentifier } from '../cluster/contracts.ts'
import type { CapabilityDescriptorV1 } from '../cluster/contracts.ts'
import type { JobRequestV1 } from './contracts.ts'
import { CapabilityFilesystem, type WorkdirCapabilityBinding } from './capability-filesystem.ts'
import { CapabilityGit } from './capability-git.ts'
import { CapabilityShell, WORKDIR_PROCESS_EXECUTE_OPERATION } from './capability-shell.ts'
import { CapabilityWorkdirIdentity } from './capability-workdir-identity.ts'
import type { LocalJobOperationHandler, LocalProcessOperationHandler } from './local-executor.ts'
import {
  isManagedWorkdir, managedCapabilityForScope, MANAGED_SESSION_CAPABILITY,
  MANAGED_SESSION_OPERATION, MANAGED_WORKDIR_PERMISSIONS,
} from './managed-workdir.ts'

interface Allocation {
  version: 1
  capabilityId: string
  projectScope: string
  sessionId: string
}

/** The allocation root is Child-owned metadata, never a filesystem capability. */
export class ManagedChildWorkdirs {
  readonly #allocations = new Map<string, Allocation>()
  readonly #unavailable = new Set<string>()
  #writes: Promise<unknown> = Promise.resolve()
  #root?: string
  onCapability?: (capability: CapabilityDescriptorV1) => void | Promise<void>

  constructor(
    readonly rootPath: string,
    readonly nodeId: string,
    readonly staticWorkdirs: readonly (WorkdirCapabilityBinding & { displayName?: string })[],
  ) {
    if (!isAbsolute(rootPath)) throw new TypeError('Managed storage must be absolute')
    const ids = new Set<string>()
    for (const binding of staticWorkdirs) {
      if (!isClusterIdentifier(binding.capabilityId) || !isAbsolute(binding.rootPath) ||
        isManagedWorkdir(binding.capabilityId) || binding.capabilityId === MANAGED_SESSION_CAPABILITY ||
        binding.capabilityId === 'process-execute' || ids.has(binding.capabilityId)) {
        throw new TypeError('Reserved or duplicate Child capability ID')
      }
      ids.add(binding.capabilityId)
    }
  }

  async init(): Promise<void> {
    await mkdir(this.rootPath, { recursive: true, mode: 0o700 })
    if ((await lstat(this.rootPath)).isSymbolicLink()) throw new Error('Managed storage cannot be a link')
    this.#root = await realpath(this.rootPath)
    for (const binding of this.staticWorkdirs) {
      let root: string
      try { root = await realpath(binding.rootPath) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') root = resolve(binding.rootPath)
        else throw error
      }
      if (contains(root, this.#root) || contains(this.#root, root)) {
        throw new Error('Configured workdirs must not overlap managed session storage')
      }
    }
    for (const entry of await readdir(this.#root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[0-9a-f]{64}$/.test(entry.name)) throw new Error('Invalid managed storage entry')
      const directory = join(this.#root, entry.name)
      await this.#directory(directory)
      const record = parseAllocation(JSON.parse(await readFile(join(directory, 'owner.json'), 'utf8')))
      if (slot(record.capabilityId) !== entry.name) throw new Error('Managed allocation identity mismatch')
      // Missing/replaced workdirs are not recreated on startup.
      try { await this.#directory(join(directory, 'workdir')) } catch {
        this.#unavailable.add(record.capabilityId)
      }
      this.#allocations.set(record.capabilityId, record)
    }
  }

  get capabilities(): CapabilityDescriptorV1[] {
    this.#ready()
    return [{
      version: 1, nodeId: this.nodeId, capabilityId: MANAGED_SESSION_CAPABILITY,
      kind: 'shell', displayName: 'Managed session allocation',
      permissions: [MANAGED_SESSION_OPERATION], online: true,
    }, ...this.staticWorkdirs.map(binding => this.#descriptor(binding)), ...[...this.#allocations.values()].map(record =>
      ({ ...this.#descriptor({ capabilityId: record.capabilityId, rootPath: this.#path(record.capabilityId), displayName: 'Session workdir' }),
        online: !this.#unavailable.has(record.capabilityId) }))]
  }

  get operationHandlers(): readonly (LocalJobOperationHandler | LocalProcessOperationHandler)[] {
    return [{
      handles: operation => operation === MANAGED_SESSION_OPERATION || [
        'filesystem.read', 'filesystem.write', 'workdir.git.status', 'workdir.git.diff', 'workdir.identity',
      ].includes(operation),
      execute: async (request, signal) => {
        if (request.operation === MANAGED_SESSION_OPERATION) return this.#allocate(request, signal)
        const bindings = await this.#bindings(request, signal)
        const handlers = [new CapabilityFilesystem(bindings), new CapabilityGit(bindings), new CapabilityWorkdirIdentity(bindings)]
        return handlers.find(handler => handler.handles(request.operation))!.execute(request, signal)
      },
    }, {
      handles: operation => operation === WORKDIR_PROCESS_EXECUTE_OPERATION,
      prepareProcess: async (request, signal) =>
        new CapabilityShell(await this.#bindings(request, signal)).prepareProcess(request, signal),
    }]
  }

  async settleAllocations(): Promise<void> {
    await this.#writes
  }

  #ready(): string {
    if (!this.#root) throw new Error('ManagedChildWorkdirs.init() must complete first')
    return this.#root
  }

  #path(capabilityId: string): string {
    return join(this.#ready(), slot(capabilityId), 'workdir')
  }

  #descriptor(binding: WorkdirCapabilityBinding & { displayName?: string }): CapabilityDescriptorV1 {
    return {
      version: 1, capabilityId: binding.capabilityId, nodeId: this.nodeId, kind: 'workdir',
      displayName: binding.displayName ?? binding.capabilityId, displayPath: binding.rootPath,
      permissions: [...MANAGED_WORKDIR_PERMISSIONS], online: true,
    }
  }

  async #directory(path: string): Promise<void> {
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) {
      throw new Error('Managed session directory is unavailable or has been replaced')
    }
  }

  async #bindings(request: JobRequestV1, signal: AbortSignal): Promise<readonly WorkdirCapabilityBinding[]> {
    signal.throwIfAborted()
    if (!isManagedWorkdir(request.capabilityId)) return this.staticWorkdirs
    const record = this.#allocations.get(request.capabilityId)
    if (!record || record.projectScope !== request.managedProject) throw new Error('Managed session project access denied')
    await this.#directory(this.#ready())
    await this.#directory(join(this.#ready(), slot(record.capabilityId)))
    await this.#directory(this.#path(record.capabilityId))
    signal.throwIfAborted()
    return [{ capabilityId: record.capabilityId, rootPath: this.#path(record.capabilityId) }]
  }

  #allocate(request: JobRequestV1, signal: AbortSignal): Promise<string> {
    if (request.capabilityId !== MANAGED_SESSION_CAPABILITY || request.nodeId !== this.nodeId ||
      !request.managedProject || !request.args || typeof request.args !== 'object' ||
      Array.isArray(request.args) || Object.keys(request.args).length) {
      throw new TypeError('Managed allocation requires project authority and accepts no paths or arguments')
    }
    const capabilityId = managedCapabilityForScope(request.managedProject, request.sessionId)
    const record: Allocation = { version: 1, capabilityId, projectScope: request.managedProject, sessionId: request.sessionId }
    const result = this.#writes.then(async () => {
      signal.throwIfAborted()
      await this.#directory(this.#ready())
      const directory = join(this.#ready(), slot(capabilityId))
      if (!this.#allocations.has(capabilityId)) {
        await mkdir(directory, { mode: 0o700 }).catch(error => {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        })
        await this.#directory(directory)
        const metadata = join(directory, 'owner.json')
        try {
          const existing = parseAllocation(JSON.parse(await readFile(metadata, 'utf8')))
          if (JSON.stringify(existing) !== JSON.stringify(record)) throw new Error('Managed storage ownership collision')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          if ((await readdir(directory)).length) throw new Error('Managed storage reserved collision')
          const pending = join(directory, `${randomUUID()}.pending`)
          try {
            const file = await open(pending, 'wx', 0o600)
            try { await file.writeFile(JSON.stringify(record)); await file.sync() } finally { await file.close() }
            await rename(pending, metadata)
          } finally { await unlink(pending).catch(error => { if (error.code !== 'ENOENT') throw error }) }
        }
        await mkdir(join(directory, 'workdir'), { mode: 0o700 }).catch(error => {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        })
        await this.#directory(join(directory, 'workdir'))
        this.#allocations.set(capabilityId, record)
      }
      await this.#bindings({ ...request, capabilityId }, signal)
      this.#unavailable.delete(capabilityId)
      const descriptor = this.#descriptor({ capabilityId, rootPath: this.#path(capabilityId), displayName: 'Session workdir' })
      // Advertise before returning the job result so Main's subsequent lookup is live.
      await this.onCapability?.(descriptor)
      signal.throwIfAborted()
      return JSON.stringify({
        version: 1, nodeId: this.nodeId, capabilityId,
        displayName: descriptor.displayName, displayPathSnapshot: descriptor.displayPath,
      })
    })
    this.#writes = result.catch(() => {})
    return result
  }
}

function slot(capabilityId: string): string {
  return createHash('sha256').update(capabilityId).digest('hex')
}

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return !path || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

function parseAllocation(value: unknown): Allocation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid managed allocation')
  const record = value as Allocation
  if (Object.keys(record).sort().join(',') !== 'capabilityId,projectScope,sessionId,version' || record.version !== 1 ||
    typeof record.projectScope !== 'string' || typeof record.sessionId !== 'string' ||
    record.capabilityId !== managedCapabilityForScope(record.projectScope, record.sessionId)) {
    throw new Error('Invalid managed allocation')
  }
  return { version: 1, capabilityId: record.capabilityId, projectScope: record.projectScope, sessionId: record.sessionId }
}
