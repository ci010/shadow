import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, lstat, realpath, open, stat } from 'node:fs/promises'
import { basename, dirname, join, toNamespacedPath } from 'node:path'
import { isolationGit } from '../cron/work-isolation.ts'
import { selectFolder } from './identifier.ts'
import type { FolderRegistry } from './registry.ts'
import type { RemoteFolderRecord } from './contracts.ts'
import type { DerivedWorkspaceRemoteBackend } from './remote-derived-workspace.ts'
import { parseDerivedWorkspaceResult, type DerivedWorkspaceResult } from '../execution/derived-workspace-contract.ts'
import { managedProjectScope } from '../execution/managed-workdir.ts'

export interface DerivedWorkspaceRequest {
  source: string
  branch: string
  description?: string
  workKey?: string
  name?: string
  idempotencyKey?: string
}
export interface DerivedWorkspaceReceipt {
  backend: 'git-worktree'
  projectId: string
  sourceId: string
  sourcePath: string
  commonDir: string
  commonIdentity: string
  path: string
  branch: string
  baseBranch: string
  baseCommit: string
  description: string
  workKey?: string
  workspaceId?: string
  /** Main-only correlation. Remote paths above are display snapshots, not Main addresses. */
  remote?: { nodeId: string; sourceWorkdirId: string; workdirId: string; key: string }
}
export interface DerivedWorkspaceCreator {
  createDerivedWorkspace(request: DerivedWorkspaceRequest, signal: AbortSignal): Promise<DerivedWorkspaceReceipt & { workspaceId: string }>
}
interface RemoteCreationRecord {
  fingerprint: string
  phase: 'remote-planned' | 'remote-created' | 'remote-registered'
  remote: { nodeId: string; sourceWorkdirId: string; key: string }
  result?: DerivedWorkspaceResult
  receipt?: DerivedWorkspaceReceipt
}
const queues = new Map<string, Promise<unknown>>()
const sameReceipt = (a: DerivedWorkspaceReceipt, b: DerivedWorkspaceReceipt): boolean => {
  const fields: (keyof DerivedWorkspaceReceipt)[] = ['backend', 'projectId', 'sourceId', 'sourcePath', 'commonDir', 'commonIdentity', 'path', 'branch', 'baseBranch', 'baseCommit', 'description', 'workKey', 'workspaceId']
  return fields.every(key => a[key] === b[key]) && (a.remote === undefined || b.remote === undefined
    ? a.remote === b.remote
    : a.remote.nodeId === b.remote.nodeId && a.remote.sourceWorkdirId === b.remote.sourceWorkdirId && a.remote.workdirId === b.remote.workdirId && a.remote.key === b.remote.key)
}

/** Git layout is deliberately backend-specific. A future LayerFS backend must return
 * its own resource identity, never disguise a mount reference as a local path. */
export class DerivedWorkspaces implements DerivedWorkspaceCreator {
  constructor(private readonly options: {
    projectId: string
    directory: string
    folders: Pick<FolderRegistry, 'list' | 'requireExecutionAvailable' | 'register' | 'reserveDestination' | 'acquireAccess'> & Partial<Pick<FolderRegistry, 'registerRemote'>>
    remote?: DerivedWorkspaceRemoteBackend
    validateWork: (key: string) => void
  }) {}

  async createDerivedWorkspace(request: DerivedWorkspaceRequest, signal: AbortSignal): Promise<DerivedWorkspaceReceipt & { workspaceId: string }> {
    for (const [key, value] of Object.entries(request)) {
      if (!['source', 'branch', 'description', 'workKey', 'name', 'idempotencyKey'].includes(key) || typeof value !== 'string' || value.length > 2000 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Invalid workspace creation parameters.')
    }
    if (!request.source || !request.branch) throw new Error('source and branch are required.')
    if (request.name !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(request.name)) throw new Error('Invalid workspace name.')
    const source = selectFolder(this.options.folders.list(), request.source)
    const normalized = { source: source.id, branch: request.branch, description: request.description, workKey: request.workKey, name: request.name }
    const fingerprint = createHash('sha256').update(JSON.stringify([this.options.projectId, normalized])).digest('hex')
    const recoveryKey = request.idempotencyKey ?? randomUUID()
    const key = createHash('sha256').update(recoveryKey).digest('hex')
    const file = join(this.options.directory, `${key}.json`)
    const previous = queues.get(file) ?? Promise.resolve()
    const pending = previous.catch(() => {}).then(async () => {
      const release = this.options.folders.acquireAccess()
      let lock: DatabaseSync | undefined
      try {
        signal.throwIfAborted()
        await mkdir(this.options.directory, { recursive: true })
        // SQLite's OS lock releases on host death; no timeout-based lock stealing.
        // Paired Child receipt paths can exceed MAX_PATH. Node fs handles those
        // paths, but SQLite's Windows VFS needs the native extended-length form.
        lock = new DatabaseSync(toNamespacedPath(`${file}.lock.sqlite`))
        lock.exec('BEGIN IMMEDIATE')
        const folder = await this.options.folders.requireExecutionAvailable(source.id, signal)
        if (folder.kind === 'remote') {
          if (!this.options.remote || !this.options.folders.registerRemote) throw new Error('Remote workspace creation is unsupported; no Main filesystem fallback.')
          if (request.workKey !== undefined) this.options.validateWork(request.workKey)
          return await this.#createRemote(folder, request, fingerprint, key, file, signal)
        }
        if (request.workKey !== undefined) this.options.validateWork(request.workKey)
        const root = await realpath(folder.path)
        if (await realpath(await isolationGit(root, ['rev-parse', '--show-toplevel'], signal)) !== root) throw new Error('Source must be a registered repository root.')
        const commonDir = await realpath(await isolationGit(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'], signal))
        const commonStat = await stat(commonDir)
        const commonIdentity = `${commonStat.dev}:${commonStat.ino}`
        // Accept branch refs only, never revision expressions, options or arbitrary commits.
        const short = request.branch.replace(/^refs\/(heads|remotes)\//, '')
        await isolationGit(root, ['check-ref-format', '--branch', short], signal)
        if (short.startsWith('-') || short.includes('@{') || request.branch === 'HEAD') throw new Error('Expected a local or existing remote-tracking branch.')
        let ref: string
        if (request.branch.startsWith('refs/')) {
          if (!/^refs\/(heads|remotes)\//.test(request.branch)) throw new Error('Unsupported branch namespace.')
          ref = request.branch
        } else {
          try { await isolationGit(root, ['show-ref', '--verify', `refs/heads/${short}`], signal); ref = `refs/heads/${short}` }
          catch { ref = `refs/remotes/${short}` }
        }
        let phase: string | undefined
        const persist = async (receipt: DerivedWorkspaceReceipt, nextPhase: string) => {
          const temporary = `${file}.${randomUUID()}.tmp`
          const handle = await open(temporary, 'wx', 0o600)
          try { await handle.writeFile(JSON.stringify({ fingerprint, receipt, phase: nextPhase })); await handle.sync() } finally { await handle.close() }
          await rename(temporary, file)
          phase = nextPhase
        }
        let receipt: DerivedWorkspaceReceipt
        try {
          const saved = JSON.parse(await readFile(file, 'utf8'))
          if (saved.remote || saved.receipt?.remote) throw new Error('Idempotency request/source identity conflict; remote records cannot become local.')
          if (saved.fingerprint !== fingerprint || saved.receipt.projectId !== this.options.projectId || saved.receipt.sourceId !== source.id || saved.receipt.sourcePath !== root || saved.receipt.commonDir !== commonDir || saved.receipt.commonIdentity !== commonIdentity) throw new Error('Idempotency request/source identity conflict.')
          receipt = saved.receipt
          phase = saved.phase
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          const baseCommit = await isolationGit(root, ['rev-parse', '--verify', `${ref}^{commit}`], signal)
          // Flat UUID names avoid prefix collisions with user branches such as `shadow`.
          const refs = (await isolationGit(root, ['for-each-ref', '--format=%(refname)', 'refs/heads/'], signal)).split('\n')
          let token = randomUUID()
          for (let attempt = 0; refs.some(ref => ref === `refs/heads/shadow-derived-${token}` || ref.startsWith(`refs/heads/shadow-derived-${token}/`)); attempt++) {
            if (attempt >= 4) throw new Error('Unable to allocate an independent branch name.')
            token = randomUUID()
          }
          // Reusing a derived Workspace as a source must not accumulate UUIDs
          // until a directory component (or ordinary Windows checkout) overflows.
          const prefix = request.name ?? Array.from(basename(root)).slice(0, 40).join('')
          const path = join(dirname(root), `${prefix}-worktree-${token}`)
          const description = `${request.description ? request.description + '\n' : ''}Git worktree from ${root} (${ref})${request.workKey ? `; Work ${request.workKey}` : ''}`
          receipt = { backend: 'git-worktree', projectId: this.options.projectId, sourceId: source.id, sourcePath: root, commonDir, commonIdentity, path, branch: `shadow-derived-${token}`, baseBranch: ref, baseCommit, description, ...(request.workKey ? { workKey: request.workKey } : {}) }
          await persist(receipt, 'planned')
        }
        if (receipt.backend !== 'git-worktree' || typeof receipt.path !== 'string' || dirname(receipt.path) !== dirname(root) ||
          typeof receipt.branch !== 'string' || !/^shadow(?:\/|-)derived-[0-9a-f-]{36}$/.test(receipt.branch) ||
          typeof receipt.baseCommit !== 'string' || !/^[0-9a-f]{40,64}$/.test(receipt.baseCommit) || receipt.baseBranch !== ref ||
          typeof receipt.description !== 'string' || receipt.workKey !== request.workKey ||
          !['planned', 'checkout-complete', 'registered'].includes(phase ?? '') ||
          (receipt.workspaceId !== undefined && typeof receipt.workspaceId !== 'string')) throw new Error('Invalid retained creation record.')
        const releaseDestination = await this.options.folders.reserveDestination(receipt.path)
        try {
          let exists = false
          try { const stat = await lstat(receipt.path); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe retained worktree path.'); exists = true }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
          if (exists && phase !== 'checkout-complete' && phase !== 'registered') throw new Error('Interrupted worktree checkout has unknown completion; retained for inspection, not registered.')
          if (!exists) {
            if (receipt.workspaceId) throw new Error('Registered worktree is missing; refusing to recreate user resources.')
            await isolationGit(root, ['worktree', 'add', '-b', receipt.branch, '--', receipt.path, receipt.baseCommit], signal)
          }
          await this.verify(receipt, signal)
          await persist(receipt, 'checkout-complete')
          const registered = await this.options.folders.register(receipt.path, signal, receipt.description)
          if (receipt.workspaceId && receipt.workspaceId !== registered.id) throw new Error('Registered workspace identity changed.')
          const completed = { ...receipt, workspaceId: registered.id }
          await persist(completed, 'registered')
          return completed
        } finally { releaseDestination() }
      } catch (error) {
        throw new Error(`${error instanceof Error ? error.message : String(error)} Recovery idempotencyKey: ${recoveryKey}`, { cause: error })
      } finally {
        lock?.close()
        release()
      }
    })
    queues.set(file, pending)
    try { return await pending } finally { if (queues.get(file) === pending) queues.delete(file) }
  }

  #remoteResult(folder: RemoteFolderRecord, value: unknown): DerivedWorkspaceResult {
    const result = parseDerivedWorkspaceResult(value)
    if (result.nodeId !== folder.workdir.nodeId || result.sourceWorkdirId !== folder.workdir.workdirId ||
      result.receipt.projectId !== managedProjectScope(this.options.projectId) || result.receipt.workKey !== undefined ||
      result.workdir.workdirId === folder.workdir.workdirId) throw new Error('Remote derived workspace Project/source identity mismatch.')
    return result
  }

  #mainReceipt(sourceId: string, key: string, result: DerivedWorkspaceResult, workKey?: string, workspaceId?: string): DerivedWorkspaceReceipt {
    const { workspaceId: _childWorkspaceId, ...receipt } = result.receipt
    return { ...receipt, projectId: this.options.projectId, sourceId,
      ...(workKey !== undefined ? { workKey } : {}), ...(workspaceId !== undefined ? { workspaceId } : {}),
      remote: { nodeId: result.nodeId, sourceWorkdirId: result.sourceWorkdirId, workdirId: result.workdir.workdirId, key } }
  }

  #remoteRecord(value: unknown, key: string): RemoteCreationRecord {
    const saved = value as RemoteCreationRecord
    if (!saved || typeof saved !== 'object' || !/^[0-9a-f]{64}$/.test(key) ||
      typeof saved.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(saved.fingerprint) ||
      !saved.remote || saved.remote.key !== key || typeof saved.remote.nodeId !== 'string' || typeof saved.remote.sourceWorkdirId !== 'string' ||
      !['remote-planned', 'remote-created', 'remote-registered'].includes(saved.phase)) throw new Error('Idempotency request/source identity conflict or invalid remote creation record.')
    if (saved.phase === 'remote-planned') {
      if (saved.result !== undefined || saved.receipt !== undefined) throw new Error('Invalid remote creation record.')
    } else {
      const result = parseDerivedWorkspaceResult(saved.result)
      if (!saved.receipt || saved.receipt.projectId !== this.options.projectId || typeof saved.receipt.sourceId !== 'string' ||
        result.nodeId !== saved.remote.nodeId || result.sourceWorkdirId !== saved.remote.sourceWorkdirId ||
        result.receipt.projectId !== managedProjectScope(this.options.projectId) || result.receipt.workKey !== undefined ||
        (saved.phase === 'remote-registered' ? typeof saved.receipt.workspaceId !== 'string' : saved.receipt.workspaceId !== undefined) ||
        !sameReceipt(saved.receipt, this.#mainReceipt(saved.receipt.sourceId, key, result, saved.receipt.workKey, saved.receipt.workspaceId))) throw new Error('Invalid remote creation receipt identity.')
    }
    return saved
  }

  async #persistRemote(file: string, record: RemoteCreationRecord): Promise<void> {
    const temporary = `${file}.${randomUUID()}.tmp`
    const handle = await open(temporary, 'wx', 0o600)
    try { await handle.writeFile(JSON.stringify(record)); await handle.sync() } finally { await handle.close() }
    await rename(temporary, file)
  }

  async #registeredRemote(receipt: DerivedWorkspaceReceipt, signal: AbortSignal): Promise<void> {
    if (!receipt.remote || !receipt.workspaceId) throw new Error('Remote workspace registration is incomplete.')
    const folder = await this.options.folders.requireExecutionAvailable(receipt.workspaceId, signal)
    if (folder.kind !== 'remote' || folder.workdir.nodeId !== receipt.remote.nodeId || folder.workdir.workdirId !== receipt.remote.workdirId ||
      (folder.projectId !== undefined && folder.projectId !== this.options.projectId)) throw new Error('Registered remote workspace binding mismatch.')
  }

  async #createRemote(folder: RemoteFolderRecord, request: DerivedWorkspaceRequest, fingerprint: string, key: string, file: string, signal: AbortSignal): Promise<DerivedWorkspaceReceipt & { workspaceId: string }> {
    if (folder.projectId !== undefined && folder.projectId !== this.options.projectId) throw new Error('Remote source is outside the current Project.')
    let saved: RemoteCreationRecord
    try { saved = this.#remoteRecord(JSON.parse(await readFile(file, 'utf8')), key) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      saved = { fingerprint, phase: 'remote-planned', remote: { nodeId: folder.workdir.nodeId, sourceWorkdirId: folder.workdir.workdirId, key } }
      // Intent is durable before dispatch; an unknown outcome is not silently
      // rerouted to another source, node, Project, or local backend after restart.
      await this.#persistRemote(file, saved)
    }
    if (saved.fingerprint !== fingerprint || saved.remote.nodeId !== folder.workdir.nodeId || saved.remote.sourceWorkdirId !== folder.workdir.workdirId ||
      (saved.receipt && saved.receipt.sourceId !== folder.id)) throw new Error('Idempotency request/source identity conflict.')
    signal.throwIfAborted()
    if (saved.result) {
      const verified = this.#remoteResult(folder, await this.options.remote!.verify(folder, saved.remote.key, signal))
      if (!sameReceipt(verified.receipt, saved.result.receipt) || verified.workdir.workdirId !== saved.result.workdir.workdirId) throw new Error('Retained remote worktree identity mismatch; preserved for inspection.')
    } else {
      const result = this.#remoteResult(folder, await this.options.remote!.create(folder, { key, branch: request.branch,
        ...(request.description !== undefined ? { description: request.description } : {}), ...(request.name !== undefined ? { name: request.name } : {}) }, signal))
      saved = { ...saved, phase: 'remote-created', result, receipt: this.#mainReceipt(folder.id, key, result, request.workKey) }
      await this.#persistRemote(file, saved)
    }
    const receipt = saved.receipt!
    if (receipt.workspaceId) {
      await this.#registeredRemote(receipt, signal)
      return receipt as DerivedWorkspaceReceipt & { workspaceId: string }
    }
    signal.throwIfAborted()
    const registered = await this.options.folders.registerRemote!({ version: 2, nodeId: saved.result!.nodeId, workdirId: saved.result!.workdir.workdirId }, signal)
    if (registered.kind !== 'remote' || registered.workdir.nodeId !== saved.remote.nodeId || registered.workdir.workdirId !== receipt.remote!.workdirId ||
      (registered.projectId !== undefined && registered.projectId !== this.options.projectId)) throw new Error('Registered remote workspace binding mismatch.')
    const completed = { ...receipt, workspaceId: registered.id }
    await this.#persistRemote(file, { ...saved, phase: 'remote-registered', receipt: completed })
    return completed
  }

  async #verifyRemote(receipt: DerivedWorkspaceReceipt, signal: AbortSignal): Promise<void> {
    if (!this.options.remote || !receipt.remote || !/^[0-9a-f]{64}$/.test(receipt.remote.key)) throw new Error('Remote workspace verification is unavailable; no Main filesystem fallback.')
    const release = this.options.folders.acquireAccess()
    try {
      signal.throwIfAborted()
      const saved = this.#remoteRecord(JSON.parse(await readFile(join(this.options.directory, `${receipt.remote.key}.json`), 'utf8')), receipt.remote.key)
      if (!saved.receipt || !saved.result || !sameReceipt(saved.receipt, receipt)) throw new Error('Retained remote workspace receipt mismatch.')
      const source = await this.options.folders.requireExecutionAvailable(receipt.sourceId, signal)
      if (source.kind !== 'remote' || source.workdir.nodeId !== receipt.remote.nodeId || source.workdir.workdirId !== receipt.remote.sourceWorkdirId ||
        (source.projectId !== undefined && source.projectId !== this.options.projectId)) throw new Error('Current remote source identity mismatch.')
      const verified = this.#remoteResult(source, await this.options.remote.verify(source, saved.remote.key, signal))
      if (!sameReceipt(verified.receipt, saved.result.receipt) || verified.workdir.workdirId !== saved.result.workdir.workdirId) throw new Error('Retained remote worktree identity mismatch; preserved for inspection.')
      // A lost registration is not permission to re-register or recreate it.
      await this.#registeredRemote(receipt, signal)
    } finally { release() }
  }

  async retained(idempotencyKey: string): Promise<DerivedWorkspaceReceipt | undefined> {
    const key = createHash('sha256').update(idempotencyKey).digest('hex')
    try {
      const saved = JSON.parse(await readFile(join(this.options.directory, `${key}.json`), 'utf8'))
      if (saved.remote) this.#remoteRecord(saved, key)
      return saved.receipt
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  }

  async verify(receipt: DerivedWorkspaceReceipt, signal: AbortSignal): Promise<void> {
    if (receipt.remote !== undefined) return this.#verifyRemote(receipt, signal)
    const source = await this.options.folders.requireExecutionAvailable(receipt.sourceId, signal)
    if (source.kind === 'remote' || source.path !== receipt.sourcePath ||
      await realpath(await isolationGit(source.path, ['rev-parse', '--path-format=absolute', '--git-common-dir'], signal)) !== receipt.commonDir) throw new Error('Current source repository identity mismatch.')
    const commonStat = await stat(receipt.commonDir)
    if (`${commonStat.dev}:${commonStat.ino}` !== receipt.commonIdentity) throw new Error('Current source repository identity mismatch.')
    if (receipt.projectId !== this.options.projectId || receipt.backend !== 'git-worktree' ||
      await realpath(await isolationGit(receipt.path, ['rev-parse', '--path-format=absolute', '--git-common-dir'], signal)) !== receipt.commonDir ||
      await isolationGit(receipt.path, ['symbolic-ref', '--short', 'HEAD'], signal) !== receipt.branch ||
      await realpath(await isolationGit(receipt.path, ['rev-parse', '--show-toplevel'], signal)) !== await realpath(receipt.path)) throw new Error('Retained worktree identity mismatch; preserved for inspection.')
  }
}
