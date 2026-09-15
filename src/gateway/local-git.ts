import { spawn } from 'node:child_process'
import type { Stats } from 'node:fs'
import { lstat, open, opendir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { structuredPatch } from 'diff'
import type { Context } from 'hono'
import { resolveInWorkspace } from './local-files.ts'
import { isGitFilePath } from './git-contracts.ts'
import type { GitChangeKind as GitFileStatus, GitChange as GitStatusEntry, GitStatus as GitStatusResult, GitDiff as GitDiffResult } from './git-contracts.ts'
export type { GitChangeKind as GitFileStatus, GitChange as GitStatusEntry, GitStatus as GitStatusResult, GitDiff as GitDiffResult } from './git-contracts.ts'


const MAX_OUTPUT = 2 * 1024 * 1024
export const MAX_GIT_FILE_BYTES = 256 * 1024
const MAX_FILES = 5000
const MAX_PROCESSES = 4
let processes = 0
export class GitReadError extends Error {
  constructor(readonly code: string, message: string, readonly status: 400 | 404 | 409 | 413 | 500 | 503 | 504 = 500) {
    super(message)
  }
}
interface GitReadContext { root: string; base: string; prefix: string; signal: AbortSignal; config: string[] }
interface GitOutput { code: number; stdout: Buffer; stderr: string }

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
async function git(cwd: string, args: string[], signal: AbortSignal, config: string[] = [], maxOutput = MAX_OUTPUT, input?: Buffer): Promise<GitOutput> {
  cancelled(signal)
  if (processes >= MAX_PROCESSES) failure('git_busy', 'Too many Git inspections are running. Retry shortly.', 503)
  processes++
  try {
    return await new Promise<GitOutput>((done, reject) => {
      const child = spawn('git', ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=',
        '-c', 'diff.external=', '-c', 'diff.renames=true', ...config, ...args], {
        cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32',
        env: { ...environment(), ...(args[0] === 'check-ignore' ? { GIT_LITERAL_PATHSPECS: '0' } : {}) },
        stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      })
      let error: Error | undefined
      let stopping: Promise<void> | undefined
      let total = 0
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      const stop = () => {
        if (child.pid === undefined || stopping) return
        stopping = stopTree(child.pid)
        void stopping.catch(() => {
          error = new GitReadError('git_stop_failed', 'Git inspection could not stop its process tree.', 503)
          child.kill('SIGKILL')
        })
      }
      const timer = setTimeout(() => {
        error = new GitReadError('git_timeout', 'Git inspection timed out. Retry with a smaller workdir.', 504)
        stop()
      }, 5000)
      const collect = (list: Buffer[], chunk: Buffer) => {
        total += chunk.length
        if (total > maxOutput) {
          error = new GitReadError('git_output_limit', 'Git inspection exceeded its output limit. Choose a smaller workdir.', 413)
          stop()
        } else list.push(chunk)
      }
      child.stdout!.on('data', (chunk: Buffer) => collect(stdout, chunk))
      child.stderr!.on('data', (chunk: Buffer) => collect(stderr, chunk))
      if (input) {
        child.stdin!.on('error', () => { /* Exit status or cancellation reports a closed input pipe. */ })
        child.stdin!.end(input)
      }
      child.once('error', cause => {
        error = (cause as NodeJS.ErrnoException).code === 'ENOENT'
          ? new GitReadError('git_unavailable', 'Git is not installed or is unavailable on the owning device.', 503)
          : new GitReadError('git_failed', 'Git inspection could not start.', 503)
      })
      signal.addEventListener('abort', stop, { once: true })
      child.once('close', async code => {
        clearTimeout(timer)
        signal.removeEventListener('abort', stop)
        try {
          if (stopping) await stopping
          cancelled(signal)
          if (error) throw error
          done({ code: code ?? -1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString('utf8') })
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
  if (output.code !== 0) failure('git_failed', 'Git inspection failed. Check repository access and integrity; no changes were made.')
  return output.stdout
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
  const canonical = await realpath(base)
  const found = await git(canonical, ['rev-parse', '--show-toplevel'], signal)
  if (found.code !== 0 && /^fatal: (not a git repository\b|this operation must be run in a work tree)/.test(found.stderr)) return
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
  const index = text(checked(await git(ctx.root, ['ls-files', '--stage', '-z', '--', ctx.prefix || '.'], ctx.signal, ctx.config)))
  const tracked = new Set(index.split('\0').filter(Boolean)
    .map(record => scoped(ctx, record.slice(record.indexOf('\t') + 1))).filter((path): path is string => !!path))
  const links = new Set(index.split('\0').filter(record => record.startsWith('160000 '))
    .map(record => scoped(ctx, record.slice(record.indexOf('\t') + 1))).filter((path): path is string => !!path))
  if (tracked.size > MAX_FILES) failure('git_output_limit', 'Git inspection exceeds the 5,000-file limit. Choose a smaller workdir.', 413)
  for (const path of tracked) await safeWorktreePath(ctx, path)
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
        entries.set(originalPath, { path: originalPath, status: 'deleted' })
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
    const previous = entries.get(path)
    entries.set(path, previous && status === 'untracked' ? { path, status: 'modified' }
      : { path, status, ...(originalPath ? { originalPath } : {}) })
    if (entries.size > MAX_FILES) failure('git_output_limit', 'Git status exceeds the 5,000-file limit. Choose a smaller workdir.', 413)
  }
  for (const path of await untrackedFiles(ctx, tracked)) {
    entries.set(path, { path, status: entries.has(path) ? 'modified' : 'untracked' })
  }
  if (entries.size > MAX_FILES) failure('git_output_limit', 'Git status exceeds the 5,000-file limit. Choose a smaller workdir.', 413)
  // Inspect each submodule with its own disabled filter drivers instead of allowing
  // `git status` to recursively run commands configured by another repository.
  for (const path of links) {
    if (--submodules.remaining < 0) failure('git_submodule_limit', 'Git status exceeds the 16-submodule inspection limit.', 413)
    const { target, info } = await safeWorktreePath(ctx, path)
    if (!info?.isDirectory() || info.isSymbolicLink()) continue
    const child = await context(target, ctx.signal)
    if (!child || child.root !== target) continue
    if ((await statusEntries(child, submodules)).length && !entries.has(path)) entries.set(path, { path, status: 'modified' })
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
          if (++inspected > MAX_FILES) failure('git_output_limit', 'Git inspection exceeds the 5,000-entry workdir limit. Choose a smaller workdir.', 413)
          const path = directory ? `${directory}/${entry.name}` : entry.name
          if (!relativeFile(path)) failure('invalid_path', 'The workdir contains a filename unsupported by Git inspection.', 400)
          if (tracked.has(path) && (!entry.isDirectory() || links.has(path))) continue
          candidates.push({ path, directory: entry.isDirectory() && !entry.isSymbolicLink() })
        }
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
    }
    return files
  }
  return [...entries.values()].sort((a, b) => a.path.localeCompare(b.path))
}

export async function localGitStatus(base: string, signal?: AbortSignal): Promise<GitStatusResult> {
  try {
    const ctx = await context(base, signal)
    return ctx ? { available: true, entries: await statusEntries(ctx) } : { available: false, reason: 'not_repository', entries: [] }
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

/** The caller resolves the registered project or local session workdir before invoking this. */
export async function serveLocalGit(c: Context, base: string, operation: 'status' | 'diff', scope?: 'home'): Promise<Response> {
  try {
    const result = operation === 'status' ? await localGitStatus(base, c.req.raw.signal)
      : await localGitDiff(base, c.req.query('path') ?? '', c.req.raw.signal)
    return c.json(scope === 'home' && 'path' in result
      ? { ...result, sourcePath: resolve(base, result.path) } : result)
  } catch (error) {
    if (error instanceof GitReadError) return c.json({ error: error.code, message: error.message }, error.status)
    return c.json({ error: 'git_files_unavailable', message: 'Git files are unavailable. Check workdir access and retry.' }, 503)
  }
}
