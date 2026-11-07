import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, lstat, realpath } from 'node:fs/promises'
import { dirname, join, relative, isAbsolute, sep } from 'node:path'
import { createHash } from 'node:crypto'

const run = promisify(execFile)
/** Never inherit an agent/tool Git index, cwd override, or object-directory override. */
export async function isolationGit(cwd: string, args: string[], signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
  const { stdout } = await run('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', cwd, ...args],
    { env: { ...env, GIT_TERMINAL_PROMPT: '0' }, signal, timeout: 60000, maxBuffer: 1024 * 1024 })
  return stdout.trim()
}

/**
 * LayerFS's publish is an internal branch operation, not a proven real Git remote/PR
 * bridge (bridge.ts). Use a real independent Git worktree at committed HEAD instead.
 * No stash, copying dirty files, checkout in source, merge or deletion is performed.
 */
export async function prepareWorktree(home: string, projectId: string, source: string, executionId: string, signal: AbortSignal, verifyOnly = false) {
  const token = createHash('sha256').update(`${projectId}\0${executionId}`).digest('hex').slice(0, 40)
  const branch = `shadow/work-${token}`
  const sourceRoot = await isolationGit(source, ['rev-parse', '--show-toplevel'], signal)
  if (await realpath(sourceRoot) !== await realpath(source)) throw new Error('Automatic Work requires a registered repository root, not a subdirectory.')
  const path = join(await realpath(home), 'work-executions', token)
  const insideSource = (candidate: string) => { const rel = relative(sourceRoot, candidate); return !rel || rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) }
  if (insideSource(path)) throw new Error('Isolated worktrees must not be nested inside the source repository.')
  const parent = dirname(path)
  try { if ((await lstat(parent)).isSymbolicLink()) throw new Error('Execution directory must not be a symbolic link.') }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const common = await realpath(await isolationGit(source, ['rev-parse', '--path-format=absolute', '--git-common-dir'], signal))
  let exists = false
  try { const stat = await lstat(path); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe existing execution path.'); exists = true }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  if (!exists) {
    if (verifyOnly) throw new Error('Retained isolated worktree is missing; refusing to recreate or reset it during recovery.')
    await mkdir(dirname(path), { recursive: true })
    if (insideSource(await realpath(dirname(path)))) throw new Error('Execution directory resolves inside the source repository.')
    const head = await isolationGit(source, ['rev-parse', '--verify', 'HEAD^{commit}'], signal)
    // -b is intentional: an existing branch without its expected worktree needs
    // inspection, not a reset or silent reuse of unrelated branch contents.
    await isolationGit(source, ['worktree', 'add', '-b', branch, '--', path, head], signal)
  }
  if (await realpath(await isolationGit(path, ['rev-parse', '--path-format=absolute', '--git-common-dir'], signal)) !== common
    || await isolationGit(path, ['symbolic-ref', '--short', 'HEAD'], signal) !== branch
    || await realpath(await isolationGit(path, ['rev-parse', '--show-toplevel'], signal)) !== await realpath(path)) {
    throw new Error('Existing execution worktree identity does not match; retained for inspection.')
  }
  return { path, branch }
}
