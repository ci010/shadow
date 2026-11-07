import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { access, lstat, mkdir, open, type FileHandle } from 'node:fs/promises'
import { devNull } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { classifyLayerFSName } from './import-review.ts'

const TTL = 15 * 60_000
const PLAN_BUDGET_MS = 120_000
const PREPARE_BUDGET_MS = 15 * 60_000
const GUIDANCE = 'Only selected Git-tracked WORKING-TREE regular files are copied, not committed versions. Untracked files are excluded. Exclusions are name-based, not a secret scanner or credential-free certification; human content review is required. Metadata checks cannot eliminate filesystem races or detect every content change (Windows read-induced change time and all access times are excluded). Plans expire after 15 minutes; expiry is checked after pre-copy revalidation and before destination creation. Planning and pre-copy metadata revalidation each have a 120-second runtime limit. Once admitted, preparation has a separate runtime limit of up to 15 minutes; plan expiry does not interrupt an admitted copy. Do not mutate the source or destination during preparation. Failed/partial destinations are retained, never returned as ready. The original source is never edited or cleaned.'
export interface LayerFSBaselineFinding { path: string; reason: string }
export interface LayerFSBaselinePlan {
  plan: string
  summary: { files: number; bytes: number; trackedEntries: number; excludedEntries: number; scope: 'selected_tracked_working_tree_files' }
  exclusions: LayerFSBaselineFinding[]
  exclusionsTruncated: boolean
  warnings: LayerFSBaselineFinding[]
  warningsTruncated: boolean
  guidance: string
}
/** Injection is trusted host code, never a tool argument. Tighter limits cannot raise ceilings. */
export interface LayerFSBaselineOptions {
  inventory?: (source: string, signal: AbortSignal) => Promise<readonly string[]>
  maxEntries?: number
  maxBytes?: number
  /** Planning and pre-copy metadata revalidation; default/ceiling 120 seconds. */
  maxDurationMs?: number
  /** Runtime after admission, including final revalidation; default/ceiling 15 minutes. */
  maxPrepareDurationMs?: number
  maxFindings?: number
}
interface Snapshot {
  files: { path: string; metadata: string; bytes: number; mode: number }[]
  digest: string
  summary: LayerFSBaselinePlan['summary']
  exclusions: LayerFSBaselineFinding[]
  exclusionsTruncated: boolean
  warnings: LayerFSBaselineFinding[]
  warningsTruncated: boolean
}
interface Approval { source: string; owner: string; digest: string; expires: number }
function failureCode(error: unknown): string {
  return error instanceof Error && /^baseline_[a-z_]+$/.test(error.message) ? error.message : 'unreadable_unsafe_or_unstable_entry'
}
function limit(value: number | undefined, ceiling: number): number {
  return value === undefined || !Number.isFinite(value) ? ceiling : Math.max(1, Math.min(ceiling, Math.floor(value)))
}
function metadata(s: BigIntStats): string {
  // atime is excluded everywhere. On Windows, read-only opens/reads can also
  // advance NTFS change time (and lstat/fstat may disagree on its cached value).
  // Keep identity, mode, links, size, birthtime and mtime; retain ctime on POSIX.
  return [s.dev, s.ino, s.mode, s.nlink, s.uid, s.gid, s.size, s.mtimeNs, process.platform === 'win32' ? '' : s.ctimeNs, s.birthtimeNs].join(':')
}
function safeName(path: string): string {
  const encoded = path.split('/').map(p => encodeURIComponent(p).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join('/')
  return encoded.length > 240 ? encoded.slice(0, 237) + '...' : encoded
}
function pathValue(path: string): string {
  if (typeof path !== 'string' || !path.trim() || path.includes('\0')) throw new Error('baseline_invalid_path')
  return resolve(path)
}
function inside(parent: string, child: string): boolean {
  const r = relative(parent, child)
  return r === '' || (!r.startsWith(`..${sep}`) && r !== '..' && !isAbsolute(r))
}
function portable(path: string): void {
  if (typeof path !== 'string' || !path || path.length > 4096 || path.includes('\\') || isAbsolute(path)) throw new Error('baseline_unsafe_inventory_path')
  const parts = path.split('/')
  if (parts.length > 128 || parts.some(p => !p || p === '.' || p === '..' || /[\x00-\x1f\x7f<>:"|?*]/.test(p) || /[. ]$/.test(p)
    || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p))) throw new Error('baseline_unsafe_inventory_path')
}
class Budget {
  readonly controller = new AbortController()
  readonly signal = this.controller.signal
  private readonly timer: ReturnType<typeof setTimeout>
  private readonly abort: () => void
  constructor(private readonly outer: AbortSignal, ms: number) {
    this.abort = () => this.controller.abort(new Error('baseline_aborted'))
    outer.addEventListener('abort', this.abort, { once: true })
    this.timer = setTimeout(() => this.controller.abort(new Error('baseline_time_limit')), ms)
    if (outer.aborted) this.abort()
  }
  check(): void { this.signal.throwIfAborted() }
  async run<T>(operation: () => Promise<T>, late?: (value: T) => void): Promise<T> {
    this.check()
    return await new Promise<T>((accept, reject) => {
      let settled = false
      const abort = () => { if (!settled) { settled = true; reject(this.signal.reason) } }
      this.signal.addEventListener('abort', abort, { once: true })
      Promise.resolve().then(() => { this.check(); return operation() }).then(value => {
        this.signal.removeEventListener('abort', abort)
        if (settled) late?.(value)
        else { settled = true; accept(value) }
      }, error => {
        this.signal.removeEventListener('abort', abort)
        if (!settled) { settled = true; reject(error) }
      })
      if (this.signal.aborted) abort()
    })
  }
  dispose(): void { clearTimeout(this.timer); this.outer.removeEventListener('abort', this.abort) }
}

/** Fixed, read-only inventory. No shell, checkout, inherited GIT_* or user/global Git configuration. */
async function gitInventory(source: string, signal: AbortSignal): Promise<readonly string[]> {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (['path', 'systemroot', 'windir', 'temp', 'tmp', 'lang', 'lc_all'].includes(key.toLowerCase())) env[key] = value
  }
  const gitNull = process.platform === 'win32' ? 'NUL' : devNull
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: gitNull, GIT_CONFIG_GLOBAL: gitNull,
    GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_ATTR_NOSYSTEM: '1', GIT_LITERAL_PATHSPECS: '1' })
  return await new Promise((accept, reject) => {
    const child = spawn('git', ['-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${gitNull}`, '-c', 'core.untrackedCache=false', 'ls-files', '--cached', '-z', '--'],
      { cwd: source, env, shell: false, windowsHide: true, signal, stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    let bytes = 0, entries = 0, failed = false
    const fail = () => { failed = true; child.kill() }
    child.stdout.on('data', (data: Buffer) => {
      if (failed) return
      bytes += data.length
      for (const byte of data) if (byte === 0) entries++
      if (bytes > 32 * 1024 * 1024 || entries > 100_000) { fail(); return }
      chunks.push(data)
    })
    // Drain, but never expose Git stderr (may include paths/configuration data).
    child.stderr.on('data', () => {})
    child.on('error', () => { failed = true })
    child.on('close', code => {
      if (failed || code !== 0 || signal.aborted) { reject(new Error('baseline_git_inventory_failed_or_limit')); return }
      try {
        const raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
        if (raw && !raw.endsWith('\0')) throw new Error('invalid_inventory')
        accept(raw ? raw.slice(0, -1).split('\0') : [])
      } catch { reject(new Error('baseline_invalid_git_inventory')) }
    })
  })
}

/** In-memory plans only. Caller enforces trusted owner identity and exact human approval before prepare. */
export class LayerFSBaseline {
  private readonly root: string
  private readonly options: Required<LayerFSBaselineOptions>
  private readonly plans = new Map<string, Approval>()
  constructor(root: string, options: LayerFSBaselineOptions = {}) {
    this.root = pathValue(root)
    this.options = { inventory: options.inventory ?? gitInventory, maxEntries: limit(options.maxEntries, 100_000),
      maxBytes: limit(options.maxBytes, 8 * 1024 ** 3), maxDurationMs: limit(options.maxDurationMs, PLAN_BUDGET_MS),
      maxPrepareDurationMs: limit(options.maxPrepareDurationMs, PREPARE_BUDGET_MS), maxFindings: limit(options.maxFindings, 100) }
  }
  async plan(source: string, owner: string, signal: AbortSignal): Promise<LayerFSBaselinePlan> {
    this.prune()
    const path = this.validate(source, owner)
    const budget = new Budget(signal, this.options.maxDurationMs)
    try {
      const snapshot = await this.scan(path, budget)
      budget.check()
      while (this.plans.size >= 128) this.plans.delete(this.plans.keys().next().value!)
      const token = randomBytes(32).toString('hex')
      this.plans.set(token, { source: path, owner, digest: snapshot.digest, expires: Date.now() + TTL })
      const { digest: _digest, files: _files, ...publicSnapshot } = snapshot
      return { plan: token, ...publicSnapshot, guidance: GUIDANCE }
    } catch (error) { throw new Error(`LayerFS baseline plan failed: ${failureCode(error)}. No baseline was prepared.`) }
    finally { budget.dispose() }
  }
  async prepare(plan: unknown, source: string, owner: string, signal: AbortSignal): Promise<{ path: string; files: number; bytes: number }> {
    this.prune()
    const path = this.validate(source, owner)
    const approval = typeof plan === 'string' ? this.plans.get(plan) : undefined
    if (!approval || approval.source !== path || approval.owner !== owner || signal.aborted) throw new Error('LayerFS baseline requires a fresh source/owner-bound plan token. No preparation started.')
    // Reserve before first await. Even interrupted or failed attempts cannot replay.
    this.plans.delete(plan as string)
    let budget = new Budget(signal, this.options.maxDurationMs)
    try {
      const before = await this.scan(path, budget)
      budget.check()
      if (before.digest !== approval.digest || Date.now() >= approval.expires) throw new Error('baseline_source_changed_or_expired')
      // Admission occurs before any destination-side mutation. Approval freshness
      // gates admission only; an admitted copy has its own bounded runtime.
      budget.dispose()
      budget = new Budget(signal, this.options.maxPrepareDurationMs)
      await this.ensureRoot(budget)
      const destination = join(this.root, `baseline-${randomBytes(24).toString('hex')}`)
      await budget.run(() => mkdir(destination, { mode: 0o700 })) // Exclusive: never recursive here.
      await this.plainAncestors(destination, budget)
      const outputMetadata = new Map<string, string>()
      for (const file of before.files) {
        budget.check()
        const input = join(path, ...file.path.split('/')), output = join(destination, ...file.path.split('/'))
        await this.plainAncestors(dirname(input), budget)
        await this.ensureDirectories(destination, dirname(output), budget)
        outputMetadata.set(file.path, await this.copy(input, output, file, budget))
      }
      const after = await this.scan(path, budget)
      if (after.digest !== before.digest) throw new Error('baseline_source_changed')
      // Destination revalidation catches substituted files/ancestors and checks final sizes.
      await this.plainAncestors(destination, budget)
      for (const file of before.files) {
        const output = join(destination, ...file.path.split('/'))
        await this.plainAncestors(dirname(output), budget)
        const s = await budget.run(() => lstat(output, { bigint: true }))
        if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1n || metadata(s) !== outputMetadata.get(file.path)) throw new Error('baseline_destination_changed')
      }
      budget.check()
      return { path: destination, files: before.summary.files, bytes: before.summary.bytes }
    } catch (error) {
      throw new Error(`LayerFS baseline preparation failed: ${failureCode(error)}. No destination is ready. Any partial destination is retained; obtain a new plan. The original source was not edited.`)
    } finally { budget.dispose() }
  }
  private validate(source: string, owner: string): string {
    const path = pathValue(source)
    if (typeof owner !== 'string' || !owner.trim()) throw new Error('baseline_invalid_owner')
    if (inside(path, this.root) || inside(this.root, path)) throw new Error('baseline_source_destination_overlap')
    if (classifyLayerFSName(basename(path), true).blocker) throw new Error('baseline_excluded_source_root')
    return path
  }
  private prune(): void {
    for (const [token, entry] of this.plans) if (Date.now() >= entry.expires) this.plans.delete(token)
  }
  private async plainAncestors(path: string, budget: Budget): Promise<void> {
    for (let p = path; ; p = dirname(p)) {
      const s = await budget.run(() => lstat(p, { bigint: true }))
      if (s.isSymbolicLink() || !s.isDirectory()) throw new Error('baseline_nonplain_ancestor')
      if (dirname(p) === p) break
    }
  }
  private async ensureRoot(budget: Budget): Promise<void> {
    const missing: string[] = []
    let p = this.root
    for (;;) {
      try {
        await budget.run(() => lstat(p))
        await this.plainAncestors(p, budget)
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        missing.push(p)
        const parent = dirname(p)
        if (parent === p) throw new Error('baseline_invalid_target')
        p = parent
      }
    }
    for (const directory of missing.reverse()) {
      await this.plainAncestors(dirname(directory), budget)
      await budget.run(() => mkdir(directory, { mode: 0o700 }))
      await this.plainAncestors(directory, budget)
    }
  }
  private async ensureDirectories(root: string, target: string, budget: Budget): Promise<void> {
    if (!inside(root, target)) throw new Error('baseline_escaping_destination')
    await this.plainAncestors(root, budget)
    const parts = relative(root, target).split(sep).filter(Boolean)
    let p = root
    for (const part of parts) {
      p = join(p, part)
      const directory = p
      try { await budget.run(() => mkdir(directory, { mode: 0o700 })) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      await this.plainAncestors(p, budget)
    }
  }
  private async inventory(source: string, budget: Budget): Promise<string[]> {
    const paths = await budget.run(() => this.options.inventory(source, budget.signal))
    if (!Array.isArray(paths) || paths.length > this.options.maxEntries) throw new Error('baseline_entry_limit')
    let bytes = 0
    const seen = new Set<string>()
    const normalized = paths.map(path => {
      portable(path)
      bytes += Buffer.byteLength(path, 'utf8') + 1
      if (bytes > 32 * 1024 * 1024) throw new Error('baseline_inventory_byte_limit')
      // Conservative portable collision check, including Windows case aliases.
      const key = path.normalize('NFC').toLowerCase()
      if (seen.has(key)) throw new Error('baseline_duplicate_or_case_collision')
      seen.add(key)
      return path
    })
    return normalized.sort()
  }
  private async scan(source: string, budget: Budget): Promise<Snapshot> {
    await this.plainAncestors(source, budget)
    const paths = await this.inventory(source, budget)
    const files: Snapshot['files'] = [], directories = new Map<string, string>()
    const exclusions: LayerFSBaselineFinding[] = [], warnings: LayerFSBaselineFinding[] = []
    let exclusionsTruncated = false, warningsTruncated = false, excludedEntries = 0, bytes = 0
    const directory = async (p: string) => {
      if (directories.has(p)) return
      if (p !== source && files.length + directories.size > this.options.maxEntries) throw new Error('baseline_entry_limit')
      const s = await budget.run(() => lstat(p, { bigint: true }))
      if (!s.isDirectory() || s.isSymbolicLink()) throw new Error('baseline_nonplain_directory')
      await budget.run(() => access(p, constants.R_OK | constants.X_OK))
      directories.set(p, metadata(s))
    }
    await directory(source)
    for (const path of paths) {
      budget.check()
      const parts = path.split('/')
      let blocker: string | undefined, warning: string | undefined
      for (let i = 0; i < parts.length; i++) {
        const classification = classifyLayerFSName(parts[i], i < parts.length - 1)
        blocker ??= classification.blocker
        warning ??= classification.warning
      }
      if (blocker) {
        excludedEntries++
        if (exclusions.length < this.options.maxFindings) exclusions.push({ path: safeName(path), reason: blocker })
        else exclusionsTruncated = true
        continue // Do not traverse or read excluded credential/dependency trees.
      }
      if (warning) {
        if (warnings.length < this.options.maxFindings) warnings.push({ path: safeName(path), reason: warning })
        else warningsTruncated = true
      }
      let p = source
      for (const part of parts.slice(0, -1)) { p = join(p, part); await directory(p) }
      const full = join(p, parts.at(-1)!)
      if (!inside(source, full)) throw new Error('baseline_escaping_source')
      const s = await budget.run(() => lstat(full, { bigint: true }))
      if (!s.isFile() || s.isSymbolicLink()) throw new Error('baseline_not_regular_file')
      await budget.run(() => access(full, constants.R_OK))
      if (s.size > BigInt(this.options.maxBytes - bytes)) throw new Error('baseline_byte_limit')
      bytes += Number(s.size)
      if (files.length + directories.size > this.options.maxEntries) throw new Error('baseline_entry_limit')
      files.push({ path, metadata: metadata(s), bytes: Number(s.size), mode: Number(s.mode & 0o777n) })
    }
    if (JSON.stringify(await this.inventory(source, budget)) !== JSON.stringify(paths)) throw new Error('baseline_inventory_changed')
    for (const [p, before] of directories) {
      if (metadata(await budget.run(() => lstat(p, { bigint: true }))) !== before) throw new Error('baseline_directory_changed')
    }
    // Recheck every selected file; the final digest covers only this declared scope.
    for (const file of files) {
      const rechecked = metadata(await budget.run(() => lstat(join(source, ...file.path.split('/')), { bigint: true })))
      if (rechecked !== file.metadata) throw new Error('baseline_file_changed_scan')
    }
    await this.plainAncestors(source, budget)
    const digest = createHash('sha256').update(JSON.stringify([paths, [...directories].map(([p, m]) => [relative(source, p), m]).sort(), files])).digest('hex')
    return { files, digest, summary: { files: files.length, bytes, trackedEntries: paths.length, excludedEntries, scope: 'selected_tracked_working_tree_files' },
      exclusions, exclusionsTruncated, warnings, warningsTruncated }
  }
  private async copy(input: string, output: string, file: Snapshot['files'][number], budget: Budget): Promise<string> {
    let reader: FileHandle | undefined, writer: FileHandle | undefined
    const lateClose = (handle: FileHandle) => { void handle.close().catch(() => {}) }
    try {
      reader = await budget.run(() => open(input, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)), lateClose)
      const before = await budget.run(() => reader!.stat({ bigint: true }))
      if (!before.isFile() || metadata(before) !== file.metadata) throw new Error('baseline_file_changed_before_copy')
      writer = await budget.run(() => open(output, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), file.mode & 0o755), lateClose)
      // Bounded chunks and an exact byte ceiling: an expanding source cannot fill disk.
      let copied = 0
      const buffer = Buffer.allocUnsafe(64 * 1024)
      while (copied < file.bytes) {
        const { bytesRead } = await budget.run(() => reader!.read(buffer, 0, Math.min(buffer.length, file.bytes - copied), copied))
        if (bytesRead === 0) throw new Error('baseline_source_shrank')
        let written = 0
        while (written < bytesRead) {
          const { bytesWritten } = await budget.run(() => writer!.write(buffer, written, bytesRead - written, copied + written))
          if (bytesWritten === 0) throw new Error('baseline_short_write')
          written += bytesWritten
        }
        copied += bytesRead
      }
      if (copied !== file.bytes || metadata(await budget.run(() => reader!.stat({ bigint: true }))) !== file.metadata) throw new Error('baseline_file_changed_during_copy')
      const written = await budget.run(() => writer!.stat({ bigint: true }))
      if (!written.isFile() || written.size !== BigInt(file.bytes) || written.nlink !== 1n) throw new Error('baseline_destination_changed')
      return metadata(written)
    } finally {
      await Promise.all([reader?.close(), writer?.close()])
    }
  }
}
