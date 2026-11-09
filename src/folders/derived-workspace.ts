import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, lstat, realpath, open, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { isolationGit } from '../cron/work-isolation.ts'
import { selectFolder } from './identifier.ts'
import type { FolderRegistry } from './registry.ts'

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
}
export interface DerivedWorkspaceCreator {
  createDerivedWorkspace(request: DerivedWorkspaceRequest, signal: AbortSignal): Promise<DerivedWorkspaceReceipt & { workspaceId: string }>
}
const queues = new Map<string, Promise<unknown>>()

/** Git layout is deliberately backend-specific. A future LayerFS backend must return
 * its own resource identity, never disguise a mount reference as a local path. */
export class DerivedWorkspaces implements DerivedWorkspaceCreator {
  constructor(private readonly options: {
    projectId: string
    directory: string
    folders: Pick<FolderRegistry, 'list' | 'requireExecutionAvailable' | 'register' | 'reserveDestination' | 'acquireAccess'>
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
        lock = new DatabaseSync(`${file}.lock.sqlite`)
        lock.exec('BEGIN IMMEDIATE')
        const folder = await this.options.folders.requireExecutionAvailable(source.id, signal)
        if (folder.kind === 'remote') throw new Error('Remote workspace creation is unsupported; no Main filesystem fallback.')
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
          if (saved.fingerprint !== fingerprint || saved.receipt.projectId !== this.options.projectId || saved.receipt.sourceId !== source.id || saved.receipt.sourcePath !== root || saved.receipt.commonDir !== commonDir || saved.receipt.commonIdentity !== commonIdentity) throw new Error('Idempotency request/source identity conflict.')
          receipt = saved.receipt
          phase = saved.phase
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          const baseCommit = await isolationGit(root, ['rev-parse', '--verify', `${ref}^{commit}`], signal)
          const token = randomUUID()
          const path = join(dirname(root), `${request.name ?? basename(root)}-worktree-${token}`)
          const description = `${request.description ? request.description + '\n' : ''}Git worktree from ${root} (${ref})${request.workKey ? `; Work ${request.workKey}` : ''}`
          receipt = { backend: 'git-worktree', projectId: this.options.projectId, sourceId: source.id, sourcePath: root, commonDir, commonIdentity, path, branch: `shadow/derived-${token}`, baseBranch: ref, baseCommit, description, ...(request.workKey ? { workKey: request.workKey } : {}) }
          await persist(receipt, 'planned')
        }
        if (receipt.backend !== 'git-worktree' || typeof receipt.path !== 'string' || dirname(receipt.path) !== dirname(root) ||
          typeof receipt.branch !== 'string' || !/^shadow\/derived-[0-9a-f-]{36}$/.test(receipt.branch) ||
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

  async retained(idempotencyKey: string): Promise<DerivedWorkspaceReceipt | undefined> {
    const key = createHash('sha256').update(idempotencyKey).digest('hex')
    try { return JSON.parse(await readFile(join(this.options.directory, `${key}.json`), 'utf8')).receipt }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  }

  async verify(receipt: DerivedWorkspaceReceipt, signal: AbortSignal): Promise<void> {
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
