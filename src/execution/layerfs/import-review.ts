import { importSelection } from './import-selection.ts'
import { createHash } from 'node:crypto'
import { constants, type BigIntStats, type Dir } from 'node:fs'
import { access, lstat, opendir } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { ToolNoEffectError } from '../../tools/tool.ts'

const WARNING = 'Names and metadata only, not a secret scan. Includes tracked working files (even if ignored), nonignored untracked files and standalone .git metadata. Not an exact clone: local changes and untracked files are included; deleted files stay deleted. Linux-source node_modules are included even when ignored for reuse. Other or unknown source OS excludes node_modules for the Linux target, even tracked ones (Git may show deletions). Same OS does not guarantee ABI/architecture compatibility. No installs.'
const NEXT = 'Preview is advisory, not approval. Create imports a freshly selected safe tree without a content-review token. Non-Git folders include all safe entries; .gitignore is not interpreted outside a repository.'
export type LayerFSImportPolicy = 'git' | 'curated' | 'whole_tree'
export function importPolicy(value: unknown = 'git'): LayerFSImportPolicy {
  if (!['git', 'curated', 'whole_tree'].includes(String(value))) throw new ToolNoEffectError('Invalid importPolicy; use git. Legacy names are equivalent aliases.')
  return 'git'
}

export interface LayerFSImportPreview {
  sourcePlatform: string
  dependencyPolicy: string
  policy: LayerFSImportPolicy
  scope: 'git_working_tree_or_all_safe_files'
  status: 'ready' | 'blocked'
  reviewToken?: string
  /** Counts exclude the source root. Bytes count regular files only. */
  summary: { entries: number; files: number; directories: number; bytes: number; complete: boolean }
  blockers: { path: string; reason: string }[]
  blockersTruncated: boolean
  warnings: { path: string; reason: string }[]
  warningsTruncated: boolean
  warning: string
  next: string
}
interface Scan { result: LayerFSImportPreview; digest: string }

/** Optional tighter limits are useful for callers/tests; they cannot raise the hard ceilings. */
export interface LayerFSImportReviewLimits {
  maxEntries?: number
  maxDurationMs?: number
  maxFindings?: number
}
function limit(value: number | undefined, ceiling: number): number {
  return value === undefined || !Number.isFinite(value) ? ceiling : Math.max(1, Math.min(ceiling, Math.floor(value)))
}
export interface LayerFSNameClassification { blocker?: string; warning?: string }
/** Classify a single path component, not contents. Check every ancestor as a directory. */
export function classifyLayerFSName(name: string, directory = false, ..._legacy: unknown[]): LayerFSNameClassification {
  return name.toLowerCase() === '.git' && !directory ? { blocker: 'unsupported_git_file_topology_external_metadata_not_imported' } : {}
}
/** Percent encoding prevents control characters, bidi, separators and markup in findings. */
function safeName(relative: string): string {
  const encoded = relative.split('/').map(part => encodeURIComponent(part).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join('/')
  return encoded.length > 240 ? encoded.slice(0, 237) + '...' : encoded
}
function metadata(s: BigIntStats): string {
  // atime is intentionally excluded: reading directory metadata must not invalidate approval.
  return [s.dev, s.ino, s.mode, s.nlink, s.uid, s.gid, s.size, s.mtimeNs, s.ctimeNs, s.birthtimeNs].join(':')
}
function sourcePath(source: string): string {
  if (typeof source !== 'string' || !source.trim() || source.includes('\0')) throw new Error('invalid_source')
  return resolve(source)
}

/** Advisory metadata plan and mandatory safety preflight. No content approval or secret reads. */
export class LayerFSImportReview {
  private readonly maxEntries: number
  private readonly maxDurationMs: number
  private readonly maxFindings: number
  constructor(limits: LayerFSImportReviewLimits = {}) {
    this.maxEntries = limit(limits.maxEntries, 100_000)
    this.maxDurationMs = limit(limits.maxDurationMs, 120_000)
    this.maxFindings = limit(limits.maxFindings, 100)
  }

  async preview(source: string, owner: string, signal: AbortSignal, policyValue: unknown = 'git'): Promise<LayerFSImportPreview> {
    const policy = importPolicy(policyValue)
    let path: string
    try {
      path = sourcePath(source)
      if (typeof owner !== 'string' || !owner.trim()) throw new Error('invalid_owner')
    } catch {
      return { sourcePlatform: process.platform, dependencyPolicy: process.platform === 'linux' ? 'reuse_node_modules_even_ignored' : 'exclude_node_modules_even_tracked_for_linux_target', policy, scope: 'git_working_tree_or_all_safe_files', status: 'blocked', summary: { entries: 0, files: 0, directories: 0, bytes: 0, complete: false },
        blockers: [{ path: '.', reason: 'invalid_source_or_owner' }], blockersTruncated: false, warnings: [], warningsTruncated: false, warning: WARNING, next: NEXT }
    }
    const { result } = await this.scan(path, signal, policy)
    return result
  }

  async fingerprint(source: string, signal: AbortSignal): Promise<string> {
    const scan = await this.scan(sourcePath(source), signal, 'git')
    if (scan.result.status === 'blocked') throw new ToolNoEffectError('Import source safety preflight blocked: ' + JSON.stringify(scan.result.blockers))
    return scan.digest
  }

  /** Legacy consume API: ignores old tokens/acknowledgements; freshly validates safety only. */
  async consume(token: unknown, source: string, owner: string, reviewed: unknown, signal: AbortSignal, policyValue: unknown = 'git'): Promise<void> {
    const result = await this.preview(source, owner, signal, policyValue)
    if (result.status === 'blocked') throw new ToolNoEffectError('Import source safety preflight blocked: ' + JSON.stringify(result.blockers))
  }

  private async scan(source: string, signal: AbortSignal, policy: LayerFSImportPolicy): Promise<Scan> {
    const result: LayerFSImportPreview = { sourcePlatform: process.platform, dependencyPolicy: process.platform === 'linux' ? 'reuse_node_modules_even_ignored' : 'exclude_node_modules_even_tracked_for_linux_target', policy, scope: 'git_working_tree_or_all_safe_files', status: 'ready', summary: { entries: 0, files: 0, directories: 0, bytes: 0, complete: true },
      blockers: [], blockersTruncated: false, warnings: [], warningsTruncated: false, warning: WARNING, next: NEXT }
    // Fixed-size record hashes bound retained digest data even for long paths.
    const records: string[] = []
    const record = (relative: string, stats: BigIntStats) => {
      records.push(createHash('sha256').update(JSON.stringify([relative, metadata(stats)])).digest('hex'))
    }
    const deadline = performance.now() + this.maxDurationMs
    let current = '.'
    const block = (path: string, reason: string) => {
      result.status = 'blocked'
      if (result.blockers.length < this.maxFindings) result.blockers.push({ path: safeName(path), reason })
      else result.blockersTruncated = true
    }
    const check = () => {
      if (signal.aborted) throw new Error('scan_aborted')
      if (performance.now() >= deadline) throw new Error('scan_time_limit')
    }
    // Filesystem promises are not all abortable. Stop waiting at the deadline; no
    // background traversal continues. A late opendir result is explicitly closed.
    const bounded = async <T>(operation: () => Promise<T>, late?: (value: T) => void): Promise<T> => {
      check()
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      let abort: (() => void) | undefined
      try {
        return await new Promise<T>((accept, reject) => {
          const fail = (reason: string) => { if (!settled) { settled = true; reject(new Error(reason)) } }
          abort = () => fail('scan_aborted')
          signal.addEventListener('abort', abort, { once: true })
          timer = setTimeout(() => fail('scan_time_limit'), Math.max(1, deadline - performance.now()))
          operation().then(value => {
            if (settled) late?.(value)
            else { settled = true; accept(value) }
          }, error => { if (!settled) { settled = true; reject(error) } })
          if (signal.aborted) abort()
        })
      } finally {
        if (timer) clearTimeout(timer)
        if (abort) signal.removeEventListener('abort', abort)
      }
    }
    const close = (dir: Dir) => { void dir.close().catch(() => {}) }
    let digest = ''
    try {
      // Reject symlink/junction ancestors as well as symlinks in the source tree.
      // This is a conservative preflight, not a race-free filesystem sandbox.
      for (let ancestor = source; ; ancestor = dirname(ancestor)) {
        const s = await bounded(() => lstat(ancestor, { bigint: true }))
        if (s.isSymbolicLink() || !s.isDirectory()) { block('.', 'source_or_ancestor_not_plain_directory'); result.summary.complete = false; return { result, digest: '' } }
        if (dirname(ancestor) === ancestor) break
      }
      const selection = await importSelection(source)
      const rootReason = classifyLayerFSName(basename(source), true, policy).blocker
      if (rootReason) { block('.', rootReason); result.summary.complete = false; return { result, digest: '' } }
      const pending = [{ path: source, relative: '.', depth: 0, gitAncestor: basename(source).toLowerCase() === '.git', credentialAncestor: classifyLayerFSName(basename(source), true, policy).warning === 'credential_related_name_requires_content_review' }]
      while (pending.length) {
        check()
        const directory = pending.pop()!
        current = directory.relative
        const before = await bounded(() => lstat(directory.path, { bigint: true }))
        if (before.isSymbolicLink() || !before.isDirectory()) throw new Error('directory_changed')
        record(directory.relative, before)
        await bounded(() => access(directory.path, constants.R_OK | constants.X_OK))
        const dir = await bounded(() => opendir(directory.path), close)
        try {
          for (;;) {
            check()
            const entry = await bounded(() => dir.read())
            if (!entry) break
            const selectedPath = directory.relative === '.' ? entry.name : `${directory.relative}/${entry.name}`
            if (!selection.includes(selectedPath)) {
              if (entry.name === 'node_modules' && result.warnings.length < this.maxFindings) result.warnings.push({ path: safeName(selectedPath), reason: 'excluded_non_linux_source_dependencies_tracked_entries_may_appear_deleted' })
              continue
            }
            if (result.summary.entries >= this.maxEntries) throw new Error('scan_entry_limit')
            result.summary.entries++
            // Backslashes are valid POSIX filename characters, not portable relative names.
            if (entry.name.includes('\\') || entry.name === '..' || entry.name === '.') throw new Error('nonportable_name')
            const relative = directory.relative === '.' ? entry.name : `${directory.relative}/${entry.name}`
            current = relative
            const path = join(directory.path, entry.name)
            const s = await bounded(() => lstat(path, { bigint: true }))
            record(relative, s)
            if (s.isSymbolicLink()) { block(relative, 'symbolic_link'); result.summary.complete = false; continue }
            if (!s.isDirectory() && !s.isFile()) { block(relative, 'special_file'); result.summary.complete = false; continue }
            if ((s.mode & 0o6000n) !== 0n || (s.isFile() && ((s.mode & 0o1000n) !== 0n || s.nlink !== 1n))) { block(relative, 'unsafe_mode_or_hardlink'); result.summary.complete = false; continue }
            if (s.isDirectory()) result.summary.directories++
            else {
              result.summary.files++
              if (s.size > BigInt(Number.MAX_SAFE_INTEGER - result.summary.bytes)) throw new Error('scan_byte_count_limit')
              result.summary.bytes += Number(s.size)
              if (result.summary.bytes > 16 * 1024 ** 3) throw new Error('scan_byte_count_limit')
            }
            const classification = classifyLayerFSName(entry.name, s.isDirectory(), policy, directory.credentialAncestor, directory.gitAncestor)
            if (classification.blocker) { block(relative, classification.blocker); if (s.isDirectory()) result.summary.complete = false; continue }
            if (classification.warning) {
              if (result.warnings.length < this.maxFindings) result.warnings.push({ path: safeName(relative), reason: classification.warning })
              else result.warningsTruncated = true
            }
            await bounded(() => access(path, constants.R_OK | (s.isDirectory() ? constants.X_OK : 0)))
            if (s.isDirectory()) {
              if (directory.depth >= 128) throw new Error('scan_depth_limit')
              pending.push({ path, relative, depth: directory.depth + 1, gitAncestor: directory.gitAncestor || entry.name.toLowerCase() === '.git', credentialAncestor: directory.credentialAncestor || classification.warning === 'credential_related_name_requires_content_review' })
            }
          }
        } finally { close(dir) }
        current = directory.relative
        const after = await bounded(() => lstat(directory.path, { bigint: true }))
        if (metadata(before) !== metadata(after)) throw new Error('directory_changed')
      }
      check()
      // Sorting makes the digest independent of OS directory enumeration order.
      if (result.status !== 'blocked') digest = createHash('sha256').update(JSON.stringify([policy, records.sort()])).digest('hex')
      check()
    } catch (error) {
      result.summary.complete = false
      const reason = error instanceof Error && ['scan_aborted', 'scan_time_limit', 'scan_entry_limit', 'scan_depth_limit', 'scan_byte_count_limit', 'directory_changed', 'nonportable_name', 'unsupported_git_submodule_topology'].includes(error.message)
        ? error.message : 'unreadable_or_unstable_entry'
      block(current, reason)
    }
    return { result, digest: result.status === 'blocked' ? '' : digest }
  }
}
