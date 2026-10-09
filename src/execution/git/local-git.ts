import { spawn } from 'node:child_process'
import type { Stats } from 'node:fs'
import { lstat, open, opendir, realpath, stat } from 'node:fs/promises'
import { devNull } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { getSystemErrorMap } from 'node:util'
import { structuredPatch } from 'diff'
import { resolveInWorkspace } from '../filesystem/local-files.ts'
import { isGitFilePath } from './contracts.ts'
import type { GitChangeKind as GitFileStatus, GitChange as GitStatusEntry, GitStatus as GitStatusResult, GitDiff as GitDiffResult, GitErrorStatus } from './contracts.ts'


const MAX_OUTPUT = 2 * 1024 * 1024
const MAX_INDEX_OUTPUT = 64 * 1024 * 1024
export const MAX_GIT_FILE_BYTES = 256 * 1024
const MAX_FILES = 5000
const MAX_PROCESSES = 4
let processes = 0
type GitOperation = 'rev-parse' | 'config' | 'ls-files' | 'status' | 'check-ignore' | 'symbolic-ref' | 'show-ref' | 'ls-tree' | 'cat-file'
interface GitFailureDiagnostic {
  operation: GitOperation
  stage: 'workdir' | 'spawn' | 'execute' | 'exit'
  osCode?: string
  exitCode?: number | null
  cause?: 'unsafe_ownership' | 'permission_denied' | 'invalid_configuration' | 'invalid_repository' | 'unsupported_command' | 'workdir_unavailable'
}
const systemErrorCodes = new Set([...getSystemErrorMap().values()].map(([name]) => name))
export class GitReadError extends Error {
  constructor(readonly code: string, message: string, readonly status: GitErrorStatus = 500,
    readonly diagnostic?: GitFailureDiagnostic) {
    super(diagnostic ? `${message} [${[
      `Git ${diagnostic.operation}`, `stage=${diagnostic.stage}`,
      diagnostic.osCode ? `os=${diagnostic.osCode}` : '',
      diagnostic.exitCode !== undefined ? `exit=${diagnostic.exitCode ?? 'none'}` : '',
      diagnostic.cause ? `cause=${diagnostic.cause}` : '',
    ].filter(Boolean).join('; ')}]` : message)
  }
}
interface GitReadContext { root: string; base: string; prefix: string; signal: AbortSignal; config: string[]; truncated?: true }
interface GitOutput { operation: GitOperation; code: number | null; stdout: Buffer; stderr: string }

function systemErrorCode(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  return typeof code === 'string' && systemErrorCodes.has(code) ? code : 'UNKNOWN'
}
function gitFailureCause(stderr: string): GitFailureDiagnostic['cause'] {
  // Classify diagnostics into fixed labels; never return Git's paths, config
  // values, URLs, or arbitrary stderr in an API response or log.
  if (/detected dubious ownership|unsafe repository/i.test(stderr)) return 'unsafe_ownership'
  if (/permission denied|access is denied|operation not permitted/i.test(stderr)) return 'permission_denied'
  if (/bad config|invalid config|unable to read config/i.test(stderr)) return 'invalid_configuration'
  if (/corrupt|index file smaller|bad signature|invalid gitfile|not a git repository:|bad object|invalid object/i.test(stderr)) return 'invalid_repository'
  if (/unknown option|unknown switch|unrecognized option|usage: git/i.test(stderr)) return 'unsupported_command'
}
function workdirFailure(operation: GitOperation, error: unknown, stage: 'workdir' | 'spawn' = 'workdir'): GitReadError {
  return new GitReadError('git_cwd_unavailable', 'Git working directory is unavailable. Check folder access and retry; no changes were made.', 503,
    { operation, stage, osCode: systemErrorCode(error), cause: 'workdir_unavailable' })
}
async function gitSpawnFailure(cwd: string, operation: GitOperation, error: unknown): Promise<GitReadError> {
  const osCode = systemErrorCode(error)
  if (osCode === 'ENOENT' || osCode === 'ENOTDIR') {
    try {
      if (!(await stat(cwd)).isDirectory()) return workdirFailure(operation, error, 'spawn')
    } catch (cause) {
      if (systemErrorCode(cause) === 'UNKNOWN') throw cause
      return workdirFailure(operation, error, 'spawn')
    }
  }
  return new GitReadError(osCode === 'ENOENT' ? 'git_unavailable' : 'git_failed',
    osCode === 'ENOENT' ? 'Git is not installed or is unavailable on the owning device.'
      : osCode === 'EACCES' || osCode === 'EPERM' ? 'Git inspection could not start. Check executable and folder permissions.'
      : 'Git inspection could not start.', 503,
    { operation, stage: 'spawn', osCode, ...(osCode === 'EACCES' || osCode === 'EPERM' ? { cause: 'permission_denied' as const } : {}) })
}

function failure(code: string, message: string, status: GitReadError['status'] = 500): never {
  throw new GitReadError(code, message, status)
}
function cancelled(signal: AbortSignal): void {
  if (signal.aborted) failure(signal.reason?.name === 'TimeoutError' ? 'git_timeout' : 'request_cancelled',
    signal.reason?.name === 'TimeoutError' ? 'Git inspection timed out. Retry with a smaller workdir.' : 'Git inspection was cancelled.',
    signal.reason?.name === 'TimeoutError' ? 504 : 409)
}
function environment(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')))
  return { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never',
    GIT_LITERAL_PATHSPECS: '1', GIT_NO_LAZY_FETCH: '1', LC_ALL: 'C', LANG: 'C' }
}
async function stopTree(pid: number): Promise<void> {
  if (process.platform !== 'win32') {
    try { process.kill(-pid, 'SIGKILL') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
    return
  }
  await new Promise<void>((done, reject) => {
    const child = spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
      ['/PID', String(pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' })
    child.once('error', reject)
    child.once('close', code => {
      if (code === 0) return done()
      try { process.kill(pid, 0); reject(new Error('Process tree could not be stopped')) }
      catch (error) { (error as NodeJS.ErrnoException).code === 'ESRCH' ? done() : reject(error) }
    })
  })
}
async function git(cwd: string, args: [GitOperation, ...string[]], signal: AbortSignal, config: string[] = [], maxOutput = MAX_OUTPUT, input?: Buffer, consume?: (chunk: Buffer) => void): Promise<GitOutput> {
  cancelled(signal)
  if (processes >= MAX_PROCESSES) failure('git_busy', 'Too many Git inspections are running. Retry shortly.', 503)
  const operation = args[0]
  processes++
  try {
    return await new Promise<GitOutput>((done, reject) => {
      let child: ReturnType<typeof spawn>
      try {
        child = spawn('git', ['--no-pager', '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${devNull}`,
          '-c', 'diff.external=', '-c', 'diff.renames=true', ...config, ...args], {
          cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32',
          env: { ...environment(), ...(args[0] === 'check-ignore' ? { GIT_LITERAL_PATHSPECS: '0' } : {}) },
          stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        })
      } catch (cause) {
        void gitSpawnFailure(cwd, operation, cause).then(reject, reject)
        return
      }
      let error: Error | undefined
      let spawnError: Error | undefined
      let stopping: Promise<void> | undefined
      let total = 0
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      const stop = () => {
        if (child.pid === undefined || stopping) return
        stopping = stopTree(child.pid)
        void stopping.catch(() => {
          error = new GitReadError('git_stop_failed', 'Git inspection could not stop its process tree.', 503, { operation, stage: 'execute' })
          child.kill('SIGKILL')
        })
      }
      const timer = setTimeout(() => {
        error = new GitReadError('git_timeout', 'Git inspection timed out. Retry with a smaller workdir.', 504, { operation, stage: 'execute' })
        stop()
      }, 5000)
      const collect = (list: Buffer[], chunk: Buffer) => {
        total += chunk.length
        if (total > maxOutput) {
          error = new GitReadError('git_output_limit', 'Git inspection exceeded its output limit. Choose a smaller workdir.', 413, { operation, stage: 'execute' })
          stop()
        } else if (list === stdout && consume) {
          try { consume(chunk) } catch (cause) {
            error = cause instanceof Error ? cause : new Error(String(cause))
            stop()
          }
        } else list.push(chunk)
      }
      child.stdout!.on('data', (chunk: Buffer) => collect(stdout, chunk))
      child.stderr!.on('data', (chunk: Buffer) => collect(stderr, chunk))
      if (input) {
        child.stdin!.on('error', () => { /* Exit status or cancellation reports a closed input pipe. */ })
        child.stdin!.end(input)
      }
      child.once('error', cause => {
        spawnError = cause
      })
      signal.addEventListener('abort', stop, { once: true })
      child.once('close', async code => {
        clearTimeout(timer)
        signal.removeEventListener('abort', stop)
        try {
          if (stopping) await stopping
          cancelled(signal)
          if (error) throw error
          if (spawnError) throw await gitSpawnFailure(cwd, operation, spawnError)
          done({ operation, code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString('utf8') })
        } catch (cause) {
          reject(cause instanceof GitReadError ? cause : new GitReadError('git_stop_failed', 'Git inspection could not stop its process tree.', 503))
        }
      })
      if (signal.aborted) stop()
    })
  } finally { processes-- }
}
function text(bytes: Buffer): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { return failure('git_invalid_output', 'Git returned paths that are not valid UTF-8.') }
}
function checked(output: GitOutput): Buffer {
  if (output.code !== 0) throw new GitReadError('git_failed', 'Git inspection failed. Check repository access and integrity; no changes were made.', 500,
    { operation: output.operation, stage: 'exit', exitCode: output.code, cause: gitFailureCause(output.stderr) })
  return output.stdout
}
export function isNonRepositoryResult(output: Pick<GitOutput, 'code' | 'stderr'>): boolean {
  if (output.code !== 128) return false
  // Git can write warnings before its fatal discovery diagnostic. Match the
  // diagnostic, not the start of stderr or the broader "not a git repository:"
  // error used for broken gitdir references.
  const diagnostics = output.stderr.split(/\r?\n/).filter(line => /^(fatal|error):/.test(line))
  return diagnostics.length === 1 && /^fatal: (?:not a git repository \(or any of the parent directories\): \.git|not a git repository \(or any parent up to mount point .+\)|this operation must be run in a work tree)$/.test(diagnostics[0]!)
}
function within(base: string, path: string): boolean {
  const rel = relative(base, path)
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\')
}
function relativeFile(path: string): boolean {
  return isGitFilePath(path)
}
async function context(base: string, inputSignal?: AbortSignal): Promise<GitReadContext | undefined> {
  const signal = AbortSignal.any([...(inputSignal ? [inputSignal] : []), AbortSignal.timeout(15_000)])
  cancelled(signal)
  let canonical: string
  try { canonical = await realpath(base) }
  catch (error) { throw workdirFailure('rev-parse', error) }
  const found = await git(canonical, ['rev-parse', '--show-toplevel'], signal)
  if (isNonRepositoryResult(found)) return
  const root = await realpath(text(checked(found)).replace(/\r?\n$/, ''))
  if (!within(root, canonical)) failure('invalid_path', 'The workdir is outside the Git working tree.', 400)
  const prefix = relative(root, canonical).replaceAll('\\', '/')
  const filters = await git(root, ['config', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|smudge|process|required)$'], signal)
  if (filters.code !== 0 && filters.code !== 1) checked(filters)
  const config: string[] = []
  const names = new Set(text(filters.stdout).split('\0').filter(Boolean).map(key => key.replace(/^filter\./i, '').replace(/\.(clean|smudge|process|required)$/i, '')))
  for (const name of names) {
    for (const operation of ['clean', 'smudge', 'process']) config.push('-c', `filter.${name}.${operation}=`)
    config.push('-c', `filter.${name}.required=false`)
  }
  return { root, base: canonical, prefix: prefix ? `${prefix}/` : '', signal, config }
}
function scoped(ctx: GitReadContext, path: string): string | undefined {
  if (!relativeFile(path) || !path.startsWith(ctx.prefix)) return
  const result = path.slice(ctx.prefix.length)
  return relativeFile(result) ? result : undefined
}
async function statusEntries(ctx: GitReadContext, submodules = { remaining: 16 }): Promise<GitStatusEntry[]> {
  const tracked = new Set<string>()
  const links = new Set<string>()
  let pending = Buffer.alloc(0)
  checked(await git(ctx.root, ['ls-files', '--stage', '-z', '--', ctx.prefix || '.'], ctx.signal, ctx.config,
    MAX_INDEX_OUTPUT, undefined, chunk => {
      const bytes = Buffer.concat([pending, chunk])
      let start = 0
      for (let end = bytes.indexOf(0); end >= 0; end = bytes.indexOf(0, start)) {
        const record = text(bytes.subarray(start, end))
        const path = scoped(ctx, record.slice(record.indexOf('\t') + 1))
        if (path) {
          tracked.add(path)
          if (record.startsWith('160000 ')) links.add(path)
        }
        start = end + 1
      }
      pending = Buffer.from(bytes.subarray(start))
      if (pending.length > MAX_OUTPUT) failure('git_invalid_output', 'Git returned an oversized index record.')
    }))
  if (pending.length) failure('git_invalid_output', 'Git returned an incomplete index record.')
  // Git must not inspect tracked files through a replaced (linked) parent.
  // Validate each distinct parent once, rather than stat every tracked leaf.
  const parents = new Set<string>()
  for (const path of tracked) {
    cancelled(ctx.signal)
    const parent = path.slice(0, Math.max(0, path.lastIndexOf('/')))
    if (parents.has(parent)) continue
    await safeWorktreePath(ctx, path)
    parents.add(parent)
  }
  const output = await git(ctx.root, ['status', '--porcelain=v1', '-z', '--untracked-files=no',
    '--ignore-submodules=dirty', '--renames', '--', ctx.prefix || '.'], ctx.signal, ctx.config)
  const records = text(checked(output)).split('\0')
  const entries = new Map<string, GitStatusEntry>()
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!
    if (!record) continue
    if (record.length < 4 || record[2] !== ' ') failure('git_invalid_output', 'Git returned an invalid status record.')
    const xy = record.slice(0, 2)
    const rawPath = record.slice(3)
    let path = scoped(ctx, rawPath)
    let originalPath: string | undefined
    if (/[RC]/.test(xy)) {
      const original = records[++i]
      if (!original) failure('git_invalid_output', 'Git returned an incomplete rename record.')
      originalPath = scoped(ctx, original)
      if (!path && originalPath) {
        if (entries.has(originalPath) || entries.size < MAX_FILES) entries.set(originalPath, { path: originalPath, status: 'deleted' })
        else ctx.truncated = true
        continue
      }
    }
    if (!path) continue
    const status: GitFileStatus = xy === '??' ? 'untracked'
      : xy.includes('U') || xy === 'AA' || xy === 'DD' ? 'conflicted'
      : xy[1] === 'D' ? 'deleted'
      : xy.includes('R') ? originalPath ? 'renamed' : 'added'
      : xy.includes('A') ? 'added'
      : xy.includes('D') ? 'deleted'
      : xy.includes('T') ? 'typechanged' : 'modified'
    if (!entries.has(path) && entries.size >= MAX_FILES) { ctx.truncated = true; continue }
    const previous = entries.get(path)
    entries.set(path, previous && status === 'untracked' ? { path, status: 'modified' }
      : { path, status, ...(originalPath ? { originalPath } : {}) })
  }
  for (const path of await untrackedFiles(ctx, tracked)) {
    if (!entries.has(path) && entries.size >= MAX_FILES) { ctx.truncated = true; break }
    entries.set(path, { path, status: entries.has(path) ? 'modified' : 'untracked' })
  }
  // Inspect each submodule with its own disabled filter drivers instead of allowing
  // `git status` to recursively run commands configured by another repository.
  for (const path of links) {
    if (--submodules.remaining < 0) failure('git_submodule_limit', 'Git status exceeds the 16-submodule inspection limit.', 413)
    const { target, info } = await safeWorktreePath(ctx, path)
    if (!info?.isDirectory() || info.isSymbolicLink()) continue
    const child = await context(target, ctx.signal)
    if (!child || child.root !== target) continue
    if ((await statusEntries(child, submodules)).length && !entries.has(path)) {
      if (entries.size >= MAX_FILES) ctx.truncated = true
      else entries.set(path, { path, status: 'modified' })
    }
    if (child.truncated) ctx.truncated = true
  }

  async function untrackedFiles(ctx: GitReadContext, tracked: Set<string>): Promise<string[]> {
    let directories = ['']
    let inspected = 0
    const files: string[] = []
    while (directories.length) {
      cancelled(ctx.signal)
      const candidates: { path: string; directory: boolean }[] = []
      for (const directory of directories) {
        if (directory) {
          const { info } = await safeWorktreePath(ctx, directory)
          if (!info?.isDirectory() || info.isSymbolicLink()) failure('invalid_path', 'The Git workdir changed during inspection. Refresh and retry.', 400)
        }
        const handle = await opendir(resolve(ctx.base, directory))
        for await (const entry of handle) {
          if (entry.name.toLowerCase() === '.git') continue
          const path = directory ? `${directory}/${entry.name}` : entry.name
          if (!relativeFile(path)) failure('invalid_path', 'The workdir contains a filename unsupported by Git inspection.', 400)
          if (tracked.has(path) && (!entry.isDirectory() || links.has(path))) continue
          if (++inspected > MAX_FILES) { ctx.truncated = true; break }
          candidates.push({ path, directory: entry.isDirectory() && !entry.isSymbolicLink() })
        }
        if (inspected > MAX_FILES) break
      }
      directories = []
      if (!candidates.length) continue
      const paths = candidates.map(entry => `${ctx.prefix}${entry.path}${entry.directory ? '/' : ''}`)
      const ignored = await git(ctx.root, ['check-ignore', '-z', '--stdin'], ctx.signal, ctx.config,
        MAX_OUTPUT, Buffer.from(`${paths.join('\0')}\0`))
      if (ignored.code !== 0 && ignored.code !== 1) checked(ignored)
      const excluded = new Set(text(ignored.stdout).split('\0'))
      candidates.forEach((entry, index) => {
        if (excluded.has(paths[index]!)) return
        if (entry.directory) directories.push(entry.path)
        else files.push(entry.path)
      })
      if (inspected > MAX_FILES) break
    }
    return files
  }
  return [...entries.values()].sort((a, b) => a.path.localeCompare(b.path))
}

export async function localGitStatus(base: string, signal?: AbortSignal): Promise<GitStatusResult> {
  try {
    const ctx = await context(base, signal)
    if (!ctx) return { available: false, reason: 'not_repository', entries: [] }
    const entries = await statusEntries(ctx)
    return { available: true, entries, ...(ctx.truncated ? { truncated: true } : {}) }
  } catch (error) {
    if (error instanceof GitReadError && error.code === 'git_unavailable') return { available: false, reason: 'git_unavailable', entries: [] }
    throw error
  }
}

async function safeWorktreePath(ctx: GitReadContext, path: string): Promise<{ target: string; info?: Stats }> {
  const target = resolveInWorkspace(ctx.base, path)
  if (!target || !relativeFile(path)) failure('invalid_path', 'Choose a file inside the workdir.', 400)
  const parts = path.split('/')
  for (let i = 0; i < parts.length; i++) {
    const current = resolve(ctx.base, ...parts.slice(0, i + 1))
    let info
    try { info = await lstat(current) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { target }
      throw error
    }
    if (info.isSymbolicLink()) {
      if (i !== parts.length - 1) failure('invalid_path', 'Git diff cannot follow a linked folder outside its file scope.', 400)
      return { target, info }
    }
    if (!within(ctx.base, await realpath(current))) failure('invalid_path', 'Choose a file inside the workdir.', 400)
    if (i === parts.length - 1) {
      return { target, info }
    }
  }
  return { target }
}
async function worktreeFile(ctx: GitReadContext, path: string): Promise<{ bytes?: Buffer; notice?: string; truncated?: boolean }> {
  const { target, info } = await safeWorktreePath(ctx, path)
  if (!info) return { bytes: Buffer.alloc(0) }
  if (info.isSymbolicLink()) return { notice: 'Symbolic links are not previewed.' }
  if (!info.isFile()) return { notice: 'Submodules and non-regular files are not previewed.' }
  if (info.size > MAX_GIT_FILE_BYTES) return { notice: 'File exceeds the 256 KiB per-side diff limit.', truncated: true }
  const file = await open(target, 'r')
  try {
    const buffer = Buffer.alloc(MAX_GIT_FILE_BYTES + 1)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    cancelled(ctx.signal)
    return bytesRead > MAX_GIT_FILE_BYTES ? { notice: 'File exceeds the 256 KiB per-side diff limit.', truncated: true }
      : { bytes: buffer.subarray(0, bytesRead) }
  } finally { await file.close() }
}
async function headFile(ctx: GitReadContext, path: string): Promise<{ base: 'HEAD' | 'empty'; bytes?: Buffer; notice?: string; truncated?: boolean }> {
  const head = await git(ctx.root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], ctx.signal, ctx.config)
  if (head.code === 1) {
    const symbolic = await git(ctx.root, ['symbolic-ref', '--quiet', 'HEAD'], ctx.signal, ctx.config)
    const branch = text(checked(symbolic)).trim()
    if (!branch.startsWith('refs/heads/')) failure('git_failed', 'Git HEAD does not identify a local branch or commit.')
    const ref = await git(ctx.root, ['show-ref', '--verify', '--quiet', branch], ctx.signal, ctx.config)
    if (ref.code === 1) return { base: 'empty', bytes: Buffer.alloc(0) }
    failure('git_failed', 'Git HEAD could not be read. Check repository integrity.')
  }
  const commit = text(checked(head)).trim()
  if (!/^[a-f0-9]{40,64}$/.test(commit)) failure('git_invalid_output', 'Git returned an invalid HEAD object.')
  const fullPath = `${ctx.prefix}${path}`
  const records = text(checked(await git(ctx.root, ['ls-tree', '-z', commit, '--', fullPath], ctx.signal, ctx.config))).split('\0').filter(Boolean)
  const record = records.find(record => record.slice(record.indexOf('\t') + 1) === fullPath)
  if (!record) return { base: 'empty', bytes: Buffer.alloc(0) }
  const match = /^(\d{6}) (blob|commit|tree) ([a-f0-9]{40,64})\t/.exec(record)
  if (!match) failure('git_invalid_output', 'Git returned an invalid tree record.')
  if (match[1] === '120000') return { base: 'HEAD', notice: 'Symbolic links are not previewed.' }
  if (match[2] !== 'blob') return { base: 'HEAD', notice: 'Submodules and non-regular files are not previewed.' }
  const size = Number(text(checked(await git(ctx.root, ['cat-file', '-s', match[3]!], ctx.signal, ctx.config))).trim())
  if (!Number.isSafeInteger(size) || size < 0) failure('git_invalid_output', 'Git returned an invalid blob size.')
  if (size > MAX_GIT_FILE_BYTES) return { base: 'HEAD', notice: 'File exceeds the 256 KiB per-side diff limit.', truncated: true }
  const bytes = checked(await git(ctx.root, ['cat-file', 'blob', match[3]!], ctx.signal, ctx.config, MAX_GIT_FILE_BYTES + 1024))
  if (bytes.length !== size) failure('git_failed', 'The Git object changed during inspection. Refresh and retry.')
  return { base: 'HEAD', bytes }
}
/** Read raw HEAD blobs and regular workdir files; never invoke Git diff/textconv drivers. */
export async function localGitDiff(base: string, path: string, signal?: AbortSignal): Promise<GitDiffResult> {
  if (!relativeFile(path)) failure('invalid_path', 'Choose a relative file path inside the workdir.', 400)
  const ctx = await context(base, signal)
  if (!ctx) failure('not_repository', 'This workdir is not a Git working tree.', 409)
  const entry = (await statusEntries(ctx)).find(entry => entry.path === path)
  if (!entry && ctx.truncated) failure('git_output_limit', 'Git changes are incomplete. Choose a smaller workdir to inspect this file.', 413)
  if (!entry) failure('git_change_not_found', 'This file no longer has a Git change. Refresh Changes.', 404)
  const current = await worktreeFile(ctx, path)
  const before = await headFile(ctx, entry.originalPath ?? path)
  const result: GitDiffResult = { ...entry, base: before.base, binary: false, truncated: !!(before.truncated || current.truncated), hunks: [] }
  if (before.notice || current.notice) return { ...result, notice: before.notice ?? current.notice }
  const oldBytes = before.bytes!
  const newBytes = current.bytes!
  let oldContent: string
  let newContent: string
  try {
    if (oldBytes.includes(0) || newBytes.includes(0)) throw new Error('binary')
    oldContent = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(oldBytes)
    newContent = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(newBytes)
  } catch { return { ...result, binary: true, notice: 'Binary or non-UTF-8 files do not have an inline text diff.' } }
  if (oldContent.split('\n').length + newContent.split('\n').length > 10_000) {
    return { ...result, truncated: true, notice: 'File exceeds the 10,000-line diff limit.' }
  }
  const patch = structuredPatch(entry.originalPath ?? path, path, oldContent, newContent, '', '', {
    context: 3, maxEditLength: 2048, timeout: 100,
  })
  if (!patch) return { ...result, truncated: true, notice: 'Diff exceeded its computation limit.' }
  return { ...result, oldContent, newContent, hunks: patch.hunks,
    ...(!patch.hunks.length ? { notice: 'No text differences between HEAD and the current workdir; the index or file metadata may still differ.' } : {}) }
}
