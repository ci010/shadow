import { normalizeStoredWorkdirIdentity } from './workdir-storage.ts'
import { availableExecShells } from './processes/shells.ts'
import { workdirIdOf } from './workdir-contracts.ts'
import { browseDirectories, pickerPath, LEGACY_FOLDER_PICKER_ID, FOLDER_BROWSE_OPERATION, FOLDER_SELECT_OPERATION } from '../folders/picker.ts'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, readdir, realpath, rename, unlink, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isClusterIdentifier } from '../cluster/contracts.ts'
import { assertExecutionSupported, type ExecutionSupport, type WorkdirAdvertisement } from './workdir-contracts.ts'
import type { ExecutionRequestV2 } from './contracts.ts'
import { CapabilityFilesystem, resolveExistingTarget, type WorkdirBinding } from './capability-filesystem.ts'
import { CapabilityGit } from './capability-git.ts'
import { CapabilityShell, parseWorkdirProcessArgs, WORKDIR_PROCESS_EXECUTE_OPERATION } from './capability-shell.ts'
import { CapabilityWorkdirIdentity } from './capability-workdir-identity.ts'
import type { LocalJobOperationHandler, LocalProcessOperationHandler } from './local-executor.ts'
import {
  isManagedWorkdir, managedWorkdirForScope, LEGACY_MANAGED_SERVICE_ID,
  MANAGED_SESSION_OPERATION, MANAGED_WORKDIR_OPERATIONS,
} from './managed-workdir.ts'

interface Allocation {
  version: 2
  workdirId: string
  projectScope: string
  sessionId: string
}

interface DirectoryIdentity {
  canonicalPath: string
  device: string
  inode: string
}

interface BindingIdentity {
  workdirId: string
  rootPath: string
  // An unavailable legacy directory is not permission to adopt a later replacement.
  identity: DirectoryIdentity | null
}

const IDENTITY_DIRECTORY = '.resource-identities-v1'
const MAX_IDENTITY_BYTES = 4 * 1024 * 1024

/** The allocation root is Child-owned metadata, never a filesystem capability. */
export class ManagedChildWorkdirs {
  readonly #picked = new Map<string, string>()
  readonly #allocations = new Map<string, Allocation>()
  readonly #unavailable = new Set<string>()
  #writes: Promise<unknown> = Promise.resolve()
  #root?: string
  #shells: string[] = []
  #bindingIdentities = new Map<string, BindingIdentity>()
  #identitySnapshot?: string
  #initialized = false
  onWorkdir?: (workdir: WorkdirAdvertisement) => void | Promise<void>

  constructor(
    readonly rootPath: string,
    readonly nodeId: string,
    readonly staticWorkdirs: readonly (WorkdirBinding & { displayName?: string })[],
  ) {
    if (!isAbsolute(rootPath)) throw new TypeError('Managed storage must be absolute')
    const ids = new Set<string>()
    for (const binding of staticWorkdirs) {
      if (!isClusterIdentifier(binding.workdirId) || !isAbsolute(binding.rootPath) ||
        isManagedWorkdir(binding.workdirId) || binding.workdirId === LEGACY_MANAGED_SERVICE_ID ||
        binding.workdirId === LEGACY_FOLDER_PICKER_ID || binding.workdirId.startsWith('picked-v1:') || binding.workdirId === 'process-execute' || ids.has(binding.workdirId)) {
        throw new TypeError('Reserved or duplicate Child capability ID')
      }
      ids.add(binding.workdirId)
    }
  }

  async init(): Promise<void> {
    this.#shells = (await availableExecShells()).map(shell => shell.name)
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
    try {
      const metadata = join(this.#root, 'picked-folders.json')
      const info = await lstat(metadata)
      if (!info.isFile() || info.size > 4 * 1024 * 1024) throw new Error('Invalid picked folder metadata')
      const records: unknown = JSON.parse(await readFile(metadata, 'utf8'))
      if (!Array.isArray(records)) throw new Error('Invalid picked folder metadata')
      for (const saved of records) {
        const record = parsePicked(saved)
        if (record.workdirId !== this.#pickedId(pickerPath(record.path)) || this.#picked.has(record.workdirId)) throw new Error('Invalid picked folder metadata')
        let root: string
        try { root = await realpath(record.path) } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          root = resolve(record.path)
        }
        if (contains(root, this.#root) || contains(this.#root, root)) throw new Error('Picked folders must not overlap managed session storage')
        this.#picked.set(record.workdirId, record.path)
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    for (const entry of await readdir(this.#root, { withFileTypes: true })) {
      if (entry.name === IDENTITY_DIRECTORY) {
        await this.#directory(join(this.#root, IDENTITY_DIRECTORY))
        continue
      }
      if (entry.isFile() && (entry.name === 'picked-folders.json' || /^\.picked-[a-f0-9-]{36}\.pending$/.test(entry.name))) continue
      if (!entry.isDirectory() || !/^[0-9a-f]{64}$/.test(entry.name)) throw new Error('Invalid managed storage entry')
      const directory = join(this.#root, entry.name)
      await this.#directory(directory)
      const record = parseAllocation(JSON.parse(await readFile(join(directory, 'owner.json'), 'utf8')))
      if (slot(record.workdirId) !== entry.name) throw new Error('Managed allocation identity mismatch')
      // Missing/replaced workdirs are not recreated on startup.
      try { await this.#directory(join(directory, 'workdir')) } catch {
        this.#unavailable.add(record.workdirId)
      }
      this.#allocations.set(record.workdirId, record)
    }
    const bindings = [
      ...this.staticWorkdirs,
      ...[...this.#picked].map(([workdirId, rootPath]) => ({ workdirId, rootPath })),
      ...[...this.#allocations.keys()].map(workdirId => ({ workdirId, rootPath: this.#path(workdirId) })),
    ]
    const indexDirectory = join(this.#root, IDENTITY_DIRECTORY)
    let firstBaseline = false
    try { await mkdir(indexDirectory, { mode: 0o700 }); firstBaseline = true }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    await this.#directory(indexDirectory)
    if (firstBaseline) {
      // The directory is a durable initialization tombstone. An interrupted first
      // write must fail closed next time, not silently establish another baseline.
      const identities = new Map<string, BindingIdentity>()
      for (const binding of bindings) {
        let identity: DirectoryIdentity | null = null
        if (!this.#unavailable.has(binding.workdirId)) {
          try { identity = await this.#bindingIdentity(binding.rootPath) }
          catch (error) { if (!unavailablePath(error)) throw error }
        }
        identities.set(binding.workdirId, { workdirId: binding.workdirId, rootPath: resolve(binding.rootPath), identity })
      }
      await this.#persistIdentities(identities)
    } else {
      this.#identitySnapshot = await this.#readIdentityIndex()
      this.#bindingIdentities = parseIdentityIndex(this.#identitySnapshot, this.nodeId)
    }
    for (const binding of bindings) {
      try { await this.#assertBinding(binding.workdirId, binding.rootPath) }
      catch (error) {
        if (!unavailablePath(error) && (error as NodeJS.ErrnoException).code !== 'workdir-unavailable') throw error
        this.#unavailable.add(binding.workdirId)
      }
    }
    this.#initialized = true
  }

  get workdirs(): WorkdirAdvertisement[] {
    this.#ready()
    if (!this.#initialized) throw new Error('ManagedChildWorkdirs.init() must complete first')
    return [
      ...[...this.#picked].map(([workdirId, rootPath]) => this.#descriptor({ workdirId, rootPath, displayName: basename(rootPath) || rootPath })),
      ...this.staticWorkdirs.map(binding => this.#descriptor(binding)),
      ...[...this.#allocations.values()].map(record => ({
        ...this.#descriptor({ workdirId: record.workdirId, rootPath: this.#path(record.workdirId), displayName: 'Session workdir' }),
        online: !this.#unavailable.has(record.workdirId),
      })),
    ]
  }

  get support(): ExecutionSupport {
    return { operations: [FOLDER_BROWSE_OPERATION, FOLDER_SELECT_OPERATION, MANAGED_SESSION_OPERATION] }
  }

  async assertCanExecute(request: ExecutionRequestV2, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    assertExecutionSupported(request, this.workdirs, this.support)
    if (request.nodeId !== this.nodeId || !request.projectScope) throw new Error('Execution requires the configured Main Project scope')
    if (request.workdirId !== undefined) {
      const bindings = await this.#bindings(request, signal)
      const binding = bindings.find(b => b.workdirId === workdirIdOf(request))
      if (!binding || !(await stat(binding.rootPath)).isDirectory()) throw new Error('Directory workdir is unavailable')
      await this.#assertBinding(binding.workdirId, binding.rootPath)
      if (request.operation.startsWith('workdir.process.')) {
        const args = parseWorkdirProcessArgs(request.args)
        if (!(await stat(await resolveExistingTarget(binding.rootPath, args.cwd ?? '.'))).isDirectory()) throw new Error('Initial cwd is not an available directory')
      }
    }
    signal.throwIfAborted()
  }

  get operationHandlers(): readonly (LocalJobOperationHandler | LocalProcessOperationHandler)[] {
    return [{
      handles: operation => [FOLDER_BROWSE_OPERATION, FOLDER_SELECT_OPERATION].includes(operation) || operation === MANAGED_SESSION_OPERATION || [
        'filesystem.read', 'filesystem.write', 'workdir.git.status', 'workdir.git.diff', 'workdir.identity',
      ].includes(operation),
      execute: async (request, signal) => {
        if ([FOLDER_BROWSE_OPERATION, FOLDER_SELECT_OPERATION].includes(request.operation)) return this.#pick(request, signal)
        if (request.operation === MANAGED_SESSION_OPERATION) return this.#allocate(request, signal)
        const bindings = await this.#bindings(request, signal)
        const handlers = [new CapabilityFilesystem(bindings), new CapabilityGit(bindings), new CapabilityWorkdirIdentity(bindings)]
        return handlers.find(handler => handler.handles(request.operation))!.execute(request, signal)
      },
    }, {
      handles: operation => operation === WORKDIR_PROCESS_EXECUTE_OPERATION || operation === 'workdir.process.execute-once',
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

  #path(workdirId: string): string {
    return join(this.#ready(), slot(workdirId), 'workdir')
  }

  #descriptor(binding: WorkdirBinding & { displayName?: string }): WorkdirAdvertisement {
    return {
      version: 2, workdirId: binding.workdirId, nodeId: this.nodeId,
      support: { operations: [...MANAGED_WORKDIR_OPERATIONS], shell: { shells: this.#shells, maxInputBytes: 32 * 1024, maxDeadlineMs: 120_000 } },
      displayName: binding.displayName ?? binding.workdirId, displayPath: binding.rootPath,
      online: !this.#unavailable.has(binding.workdirId),
    }
  }

  async #bindingIdentity(path: string): Promise<DirectoryIdentity> {
    const canonicalPath = await realpath(path)
    const info = await stat(canonicalPath, { bigint: true })
    if (!info.isDirectory()) throw Object.assign(new Error('Directory workdir unavailable'), { code: 'ENOTDIR' })
    return { canonicalPath, device: String(info.dev), inode: String(info.ino) }
  }

  async #assertBinding(workdirId: string, path: string): Promise<void> {
    const saved = this.#bindingIdentities.get(workdirId)
    if (!saved?.identity || saved.rootPath !== resolve(path) ||
      JSON.stringify(saved.identity) !== JSON.stringify(await this.#bindingIdentity(path))) {
      this.#unavailable.add(workdirId)
      throw Object.assign(new Error('Directory workdir has been replaced, rebound or has no verified identity'), { code: 'workdir-unavailable' })
    }
  }

  async #readIdentityIndex(): Promise<string> {
    const directory = join(this.#ready(), IDENTITY_DIRECTORY)
    await this.#directory(directory)
    const path = join(directory, 'index.json')
    const info = await lstat(path)
    if (!info.isFile() || info.size > MAX_IDENTITY_BYTES) throw new Error('Invalid directory identity index')
    return readFile(path, 'utf8')
  }

  async #persistIdentities(identities: Map<string, BindingIdentity>): Promise<void> {
    const directory = join(this.#ready(), IDENTITY_DIRECTORY)
    await this.#directory(directory)
    if (this.#identitySnapshot !== undefined && await this.#readIdentityIndex() !== this.#identitySnapshot) {
      throw new Error('Directory identity index changed; refusing to reset verified identities')
    }
    const contents = JSON.stringify({ version: 1, nodeId: this.nodeId, bindings: [...identities.values()] })
    if (Buffer.byteLength(contents) > MAX_IDENTITY_BYTES) throw new Error('Directory identity index is full')
    const temporary = join(directory, `${randomUUID()}.pending`)
    try {
      const file = await open(temporary, 'wx', 0o600)
      try { await file.writeFile(contents); await file.sync() } finally { await file.close() }
      await rename(temporary, join(directory, 'index.json'))
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error }) }
    this.#identitySnapshot = contents
    this.#bindingIdentities = identities
  }

  async #rememberNewBinding(workdirId: string, rootPath: string): Promise<void> {
    if (this.#bindingIdentities.has(workdirId)) {
      await this.#assertBinding(workdirId, rootPath)
      if (await this.#readIdentityIndex() !== this.#identitySnapshot) throw new Error('Directory identity index changed')
      return
    }
    const identity = await this.#bindingIdentity(rootPath)
    await this.#persistIdentities(new Map(this.#bindingIdentities).set(workdirId, { workdirId, rootPath: resolve(rootPath), identity }))
  }

  async #directory(path: string): Promise<void> {
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) {
      throw new Error('Managed session directory is unavailable or has been replaced')
    }
  }

  async #bindings(request: ExecutionRequestV2, signal: AbortSignal): Promise<readonly WorkdirBinding[]> {
    signal.throwIfAborted()
    const picked = this.#picked.get(workdirIdOf(request))
    if (picked) {
      const current = await realpath(picked)
      if (contains(current, this.#ready()) || contains(this.#ready(), current)) throw new Error('Picked folder overlaps managed session storage')
      return [{ workdirId: workdirIdOf(request), rootPath: picked }]
    }
    if (!isManagedWorkdir(workdirIdOf(request))) return this.staticWorkdirs
    const record = this.#allocations.get(workdirIdOf(request))
    if (!record || record.projectScope !== request.projectScope) throw Object.assign(new Error('Managed session project access denied'), { code: 'project-access-denied' })
    await this.#directory(this.#ready())
    await this.#directory(join(this.#ready(), slot(record.workdirId)))
    await this.#directory(this.#path(record.workdirId))
    signal.throwIfAborted()
    return [{ workdirId: record.workdirId, rootPath: this.#path(record.workdirId) }]
  }

  #pickedId(path: string): string { return `picked-v1:${createHash('sha256').update(path).digest('hex')}` }

  async #pick(request: ExecutionRequestV2, signal: AbortSignal): Promise<string> {
    if (request.workdirId !== undefined || request.nodeId !== this.nodeId ||
      !request.args || typeof request.args !== 'object' || Array.isArray(request.args) ||
      Object.keys(request.args).join(',') !== 'path') throw new TypeError('Invalid owner picker request')
    const path = (request.args as { path: unknown }).path
    if (request.operation === FOLDER_BROWSE_OPERATION) return JSON.stringify(await browseDirectories(path, signal))
    const rootPath = await realpath(pickerPath(path))
    if (!(await stat(rootPath)).isDirectory() || contains(rootPath, this.#ready()) || contains(this.#ready(), rootPath)) {
      throw new Error('Selected folder must not overlap managed session storage')
    }
    const workdirId = this.#pickedId(rootPath)
    const result = this.#writes.then(async () => {
      signal.throwIfAborted()
      await this.#directory(this.#ready())
      if (this.#picked.has(workdirId)) await this.#assertBinding(workdirId, rootPath)
      await this.#rememberNewBinding(workdirId, rootPath)
      if (!this.#picked.has(workdirId)) {
        const records = new Map(this.#picked).set(workdirId, rootPath)
        const temporary = join(this.#ready(), `.picked-${randomUUID()}.pending`)
        try {
          const file = await open(temporary, 'wx', 0o600)
          try { await file.writeFile(JSON.stringify([...records].map(([workdirId, path]) => ({ version: 2, workdirId, path })))); await file.sync() }
          finally { await file.close() }
          await rename(temporary, join(this.#ready(), 'picked-folders.json'))
        } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error }) }
        this.#picked.set(workdirId, rootPath)
      }
      await this.#assertBinding(workdirId, rootPath)
      this.#unavailable.delete(workdirId)
      const descriptor = this.#descriptor({ workdirId, rootPath, displayName: basename(rootPath) || rootPath })
      await this.onWorkdir?.(descriptor)
      return JSON.stringify({ version: 2, nodeId: this.nodeId, workdirId, displayName: descriptor.displayName, displayPathSnapshot: rootPath })
    })
    this.#writes = result.catch(() => {})
    return result
  }

  #allocate(request: ExecutionRequestV2, signal: AbortSignal): Promise<string> {
    if (request.workdirId !== undefined || request.nodeId !== this.nodeId ||
      !request.projectScope || !request.args || typeof request.args !== 'object' ||
      Array.isArray(request.args) || Object.keys(request.args).length) {
      throw new TypeError('Managed allocation requires project authority and accepts no paths or arguments')
    }
    const workdirId = managedWorkdirForScope(request.projectScope, request.sessionId)
    const record: Allocation = { version: 2, workdirId, projectScope: request.projectScope, sessionId: request.sessionId }
    const result = this.#writes.then(async () => {
      signal.throwIfAborted()
      await this.#directory(this.#ready())
      const directory = join(this.#ready(), slot(workdirId))
      if (!this.#allocations.has(workdirId)) {
        // Never adopt a pre-existing reserved slot, even an empty directory.
        // Previously verified IDs are tombstones too: removal cannot allocate anew.
        if (this.#bindingIdentities.has(workdirId)) throw new Error('Managed allocation identity already exists')
        await mkdir(directory, { mode: 0o700 })
        await this.#directory(directory)
        const metadata = join(directory, 'owner.json')
        const pending = join(directory, `${randomUUID()}.pending`)
        try {
          const file = await open(pending, 'wx', 0o600)
          try { await file.writeFile(JSON.stringify(record)); await file.sync() } finally { await file.close() }
          await rename(pending, metadata)
        } finally { await unlink(pending).catch(error => { if (error.code !== 'ENOENT') throw error }) }
        await mkdir(join(directory, 'workdir'), { mode: 0o700 })
        await this.#directory(join(directory, 'workdir'))
        await this.#rememberNewBinding(workdirId, this.#path(workdirId))
        this.#allocations.set(workdirId, record)
      }
      await this.#bindings({ ...request, nodeId: this.nodeId, workdirId }, signal)
      await this.#assertBinding(workdirId, this.#path(workdirId))
      if (await this.#readIdentityIndex() !== this.#identitySnapshot) throw new Error('Directory identity index changed')
      this.#unavailable.delete(workdirId)
      const descriptor = this.#descriptor({ workdirId, rootPath: this.#path(workdirId), displayName: 'Session workdir' })
      // Advertise before returning the job result so Main's subsequent lookup is live.
      await this.onWorkdir?.(descriptor)
      signal.throwIfAborted()
      return JSON.stringify({
        version: 2, nodeId: this.nodeId, workdirId,
        displayName: descriptor.displayName, displayPathSnapshot: descriptor.displayPath,
      })
    })
    this.#writes = result.catch(() => {})
    return result
  }
}

function slot(workdirId: string): string {
  return createHash('sha256').update(workdirId).digest('hex')
}

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return !path || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

function parseAllocation(value: unknown): Allocation {
  const saved = normalizeStoredWorkdirIdentity(value)
  if (!saved || Object.keys(saved).sort().join(',') !== 'projectScope,sessionId,version,workdirId' ||
    (saved.version !== 1 && saved.version !== 2) || typeof saved.projectScope !== 'string' || typeof saved.sessionId !== 'string' ||
    saved.workdirId !== managedWorkdirForScope(saved.projectScope, saved.sessionId)) throw new Error('Invalid managed allocation')
  return { version: 2, workdirId: saved.workdirId as string, projectScope: saved.projectScope, sessionId: saved.sessionId }
}
function parsePicked(value: unknown): { workdirId: string; path: string } {
  const saved = normalizeStoredWorkdirIdentity(value)
  if (!saved || (saved.version === undefined ? Object.keys(saved).sort().join(',') !== 'path,workdirId' : saved.version !== 2 || Object.keys(saved).sort().join(',') !== 'path,version,workdirId') || typeof saved.path !== 'string') throw new Error('Invalid picked folder metadata')
  return { workdirId: saved.workdirId as string, path: saved.path }
}

function unavailablePath(error: unknown): boolean {
  return ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')
}

function parseIdentityIndex(contents: string, nodeId: string): Map<string, BindingIdentity> {
  const invalid = () => new Error('Invalid directory identity index')
  const value: unknown = JSON.parse(contents)
  if (!isRecord(value) || Object.keys(value).sort().join(',') !== 'bindings,nodeId,version' ||
    value.version !== 1 || value.nodeId !== nodeId || !Array.isArray(value.bindings)) throw invalid()
  const identities = new Map<string, BindingIdentity>()
  for (const stored of value.bindings) {
    const entry = normalizeStoredWorkdirIdentity(stored)
    if (!isRecord(entry) || Object.keys(entry).sort().join(',') !== 'identity,rootPath,workdirId' ||
      !isClusterIdentifier(entry.workdirId) || !identityPath(entry.rootPath) || identities.has(entry.workdirId)) throw invalid()
    let identity: DirectoryIdentity | null = null
    if (entry.identity !== null) {
      const saved = entry.identity
      if (!isRecord(saved) || Object.keys(saved).sort().join(',') !== 'canonicalPath,device,inode' ||
        !identityPath(saved.canonicalPath) || typeof saved.device !== 'string' || !/^\d{1,64}$/.test(saved.device) ||
        typeof saved.inode !== 'string' || !/^\d{1,64}$/.test(saved.inode)) throw invalid()
      identity = { canonicalPath: saved.canonicalPath, device: saved.device, inode: saved.inode }
    }
    identities.set(entry.workdirId, { workdirId: entry.workdirId, rootPath: entry.rootPath, identity })
  }
  return identities
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function identityPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 32_768 && !value.includes('\0') &&
    isAbsolute(value) && resolve(value) === value
}
