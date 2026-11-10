import { lstat, mkdir, readdir, realpath } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { DerivedWorkspaces } from '../folders/derived-workspace.ts'
import type { LocalFolderRecord } from '../folders/contracts.ts'
import { isolationGit } from '../cron/work-isolation.ts'
import {
  parseDerivedWorkspaceArgs, parseDerivedWorkspaceInspectResult, parseDerivedWorkspaceResult,
  type DerivedWorkspaceInspectResult, type DerivedWorkspaceResult,
} from './derived-workspace-contract.ts'
import type { WorkdirAdvertisement } from './workdir-contracts.ts'

export const DERIVED_WORKSPACE_DIRECTORY = '.derived-workspaces-v1'

async function directory(path: string): Promise<void> {
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) throw new Error('Invalid Child derived workspace metadata directory')
}

/** Reserved Child-owned receipts, not an advertised filesystem/workdir binding. */
export async function validateChildDerivedWorkspaceDirectory(path: string): Promise<void> {
  await directory(path)
  for (const scope of await readdir(path)) {
    if (!/^[0-9a-f]{32}$/.test(scope)) throw new Error('Invalid Child derived workspace project scope')
    const scoped = join(path, scope)
    await directory(scoped)
    for (const entry of await readdir(scoped)) {
      if (!/^[0-9a-f]{64}(?:\.json(?:\.[0-9a-f-]{36}\.tmp)?|\.json\.lock\.sqlite(?:-journal|-wal|-shm)?)$/.test(entry)) throw new Error('Invalid Child derived workspace metadata entry')
      const info = await lstat(join(scoped, entry))
      if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) throw new Error('Invalid Child derived workspace metadata file')
    }
  }
}

/** All paths are derived on Child from a verified binding, never from wire args. */
export async function executeChildDerivedWorkspace(options: {
  root: string
  nodeId: string
  projectScope: string
  source: { workdirId: string; rootPath: string }
  args: unknown
  assertSource: () => Promise<void>
  register: (path: string, signal: AbortSignal) => Promise<WorkdirAdvertisement>
  describe: (workdirId: string, signal: AbortSignal) => Promise<WorkdirAdvertisement>
}, signal: AbortSignal): Promise<DerivedWorkspaceInspectResult | DerivedWorkspaceResult> {
  const args = parseDerivedWorkspaceArgs(options.args)
  if (!/^[0-9a-f]{32}$/.test(options.projectScope)) throw new TypeError('Derived workspace requires a host Project scope')
  signal.throwIfAborted()
  await options.assertSource()
  const root = await realpath(options.source.rootPath)
  if (await realpath(await isolationGit(root, ['rev-parse', '--show-toplevel'], signal)) !== root) throw new Error('Source must be a bound repository root')
  const envelope = { version: 1 as const, nodeId: options.nodeId, sourceWorkdirId: options.source.workdirId }
  if (args.action === 'inspect') {
    return parseDerivedWorkspaceInspectResult({ ...envelope, branch: await isolationGit(root, ['symbolic-ref', '--short', 'HEAD'], signal) })
  }
  const metadata = join(options.root, DERIVED_WORKSPACE_DIRECTORY)
  const scoped = join(metadata, options.projectScope)
  if (args.action === 'create') {
    for (const path of [metadata, scoped]) {
      try { await mkdir(path, { mode: 0o700 }) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      await directory(path)
    }
  } else {
    // Recovery may inspect only existing records. No mkdir, checkout or registration.
    await directory(metadata)
    await directory(scoped)
  }
  await validateChildDerivedWorkspaceDirectory(metadata)
  const source: LocalFolderRecord = {
    kind: 'local', id: options.source.workdirId, name: basename(root), path: root,
    projectId: options.projectScope, createdAt: new Date(0).toISOString(),
  }
  const service = new DerivedWorkspaces({
    projectId: options.projectScope, directory: scoped, validateWork: () => { throw new Error('Child derivation accepts no Work keys') },
    folders: {
      list: () => [source],
      requireExecutionAvailable: async (id, s) => {
        s?.throwIfAborted()
        if (id !== source.id) throw new Error('Unbound Child source workdir')
        await options.assertSource()
        return source
      },
      acquireAccess: () => () => {},
      // Generated UUID destinations are exclusive; picked registration enforces the
      // same durable identity baseline as owner.folder.select before advertisement.
      reserveDestination: async () => () => {},
      register: async (path, s) => {
        const workdir = await options.register(path, s ?? signal)
        return { kind: 'local', id: workdir.workdirId, name: workdir.displayName, path: workdir.displayPath!, createdAt: new Date(0).toISOString() }
      },
    },
  })
  const receipt = args.action === 'create'
    ? await service.createDerivedWorkspace({ source: source.id, branch: args.branch, idempotencyKey: args.key,
      ...(args.description !== undefined ? { description: args.description } : {}), ...(args.name !== undefined ? { name: args.name } : {}) }, signal)
    : await service.retained(args.key)
  if (!receipt?.workspaceId || receipt.projectId !== options.projectScope || receipt.sourceId !== source.id ||
    receipt.sourcePath !== root || dirname(receipt.path) !== dirname(root)) throw new Error('No matching registered Child derived workspace receipt')
  const workdir = await options.describe(receipt.workspaceId, signal)
  const parsed = parseDerivedWorkspaceResult({ ...envelope, workdir, receipt })
  if (workdir.displayPath !== receipt.path) throw new Error('Retained Child workdir binding identity mismatch')
  const info = await lstat(receipt.path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Retained Child worktree is unavailable or retargeted')
  await service.verify(parsed.receipt, signal)
  signal.throwIfAborted()
  return parsed
}
