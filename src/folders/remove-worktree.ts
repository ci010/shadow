import { lstat, realpath } from 'node:fs/promises'
import { dirname, join, relative, isAbsolute, sep } from 'node:path'
import { isolationGit } from '../cron/work-isolation.ts'
import type { FolderRecord } from './contracts.ts'

async function realDirectory(path: string): Promise<string> {
  for (let current = path; ; current = dirname(current)) {
    const info = await lstat(current)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Linked or non-directory Workspace path; retained.')
    if (dirname(current) === current) break
  }
  return realpath(path)
}
const contains = (parent: string, child: string) => {
  const rel = relative(parent, child)
  return !rel || !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)
}

/** Called only under catalog admission exclusion. Never removes branches or forces Git. */
export async function removeDerivedWorktree(folder: FolderRecord, parent: FolderRecord, integratedRef: string, signal: AbortSignal): Promise<{ branch: string; tip: string; integratedCommit: string }> {
  if (folder.kind && folder.kind !== 'local' || parent.kind && parent.kind !== 'local') throw new Error('Only local Git worktrees are supported; no remote or LayerFS fallback.')
  if (folder.lineage?.ownership !== 'shadow-derived' || folder.lineage.backend !== 'git-worktree' || folder.lineage.parentId !== parent.id) throw new Error('Verified Shadow-derived Git lineage required.')
  if (!/^refs\/(heads|remotes)\/[^\s\x00-\x1f]+$/.test(integratedRef)) throw new Error('Provide an explicit refs/heads/... or refs/remotes/... integration target.')
  const target = await realDirectory(folder.path)
  const source = await realDirectory(parent.path)
  if (contains(source, target) || contains(target, source)) throw new Error('Overlapping source and target paths; retained.')
  const git = (cwd: string, args: string[]) => isolationGit(cwd, args, signal)
  if (await realpath(await git(target, ['rev-parse', '--show-toplevel'])) !== target || await realpath(await git(source, ['rev-parse', '--show-toplevel'])) !== source) throw new Error('Workspace must be an exact repository root.')
  const common = await realpath(await git(source, ['rev-parse', '--path-format=absolute', '--git-common-dir']))
  const targetCommon = await realpath(await git(target, ['rev-parse', '--path-format=absolute', '--git-common-dir']))
  const gitDir = await realpath(await git(target, ['rev-parse', '--absolute-git-dir']))
  if (common !== targetCommon || gitDir === common || dirname(gitDir) !== join(common, 'worktrees') || !(await lstat(join(target, '.git'))).isFile()) throw new Error('Not a verified linked Git worktree; primary checkouts cannot be removed.')
  const branch = await git(target, ['symbolic-ref', 'HEAD'])
  if (branch === integratedRef) throw new Error('Integration target cannot be the removed worktree branch.')
  const tip = await git(target, ['rev-parse', '--verify', 'HEAD^{commit}'])
  await git(source, ['check-ref-format', integratedRef])
  const integratedCommit = await git(source, ['show-ref', '--verify', '--hash', integratedRef])
  await git(source, ['merge-base', '--is-ancestor', tip, integratedCommit])
  // --ignored is intentional: Git otherwise silently deletes ignored user data.
  if (await git(target, ['status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching', '--ignore-submodules=none'])) throw new Error('Worktree has tracked, untracked, ignored files or submodule changes; retained. Remove/move them explicitly before retrying (including node_modules/build outputs).')
  // Sparse/skip-worktree indexes can conceal user modifications from status.
  if ((await git(target, ['ls-files', '-v'])).split('\n').some(line => line && !line.startsWith('H '))) throw new Error('Nonstandard index flags or submodules require manual inspection; retained.')
  await git(source, ['worktree', 'remove', '--', target])
  return { branch, tip, integratedCommit }
}
