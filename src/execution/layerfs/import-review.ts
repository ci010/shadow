import { createHash, randomBytes } from 'node:crypto'
import { constants, type BigIntStats, type Dir } from 'node:fs'
import { access, lstat, opendir } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { ToolNoEffectError } from '../../tools/tool.ts'

const TTL_MS = 15 * 60_000
const WARNING = 'Metadata and names only: no file contents were read. This is not a credential-free certification. Human content review is required. The source remains a mutable tree, not a snapshot; a metadata rescan cannot eliminate races or detect every content change.'
const NEXT = 'Prepare a separate curated, registered baseline containing only files approved for import. Never delete or move blocked files from the original checkout to make preview pass. Run import_preview on that separate baseline, then, after human content review, use create with sourceReview: <reviewToken> and sourceReviewed: true.'

export interface LayerFSImportPreview {
  status: 'review_required' | 'blocked'
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
interface Review { source: string; owner: string; digest: string; expires: number }

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
export function classifyLayerFSName(name: string, directory = false): LayerFSNameClassification {
  const n = name.toLowerCase()
  if (['.git', '.hg', '.svn', '.venv', 'venv', 'node_modules', 'vendor', '__pycache__', '.tox', '.mypy_cache', '.pytest_cache'].includes(n)) return { blocker: 'excluded_dependency_or_repository_directory' }
  if (n.startsWith('.env') && !['.env.example', '.env.sample'].includes(n)) return { blocker: 'environment_configuration' }
  if (['bot.config.json', '.ssh', '.aws', '.azure', '.gnupg', '.kube', '.docker', '.dockercfg', 'gcloud', '.npmrc', '.pypirc', '.netrc', '_netrc', '.git-credentials', '.htpasswd', '.pgpass'].includes(n)
    || /^id_(?:rsa|dsa|ecdsa|ed25519)(?:[._-].*)?$/.test(n)
    || /\.(?:pem|key|p12|pfx|ppk|pkcs8|keytab|keystore|jks)$/.test(n)) return { blocker: 'possible_credentials_or_private_key' }
  const heuristic = /(?:^|[._-])(?:credentials?|secrets?)(?:[._-]|$)/.test(n) || /(?:private[._-]?key|service[._-]?account)/.test(n)
  if (!heuristic) return {}
  // Code, tests, documentation and visual assets often discuss credentials. Their
  // names warrant content review, not a claim that they contain credentials.
  const reviewable = /\.(?:[cm]?[jt]sx?|vue|svelte|py|pyi|rs|go|java|kt|kts|c|h|cc|cpp|hpp|cs|rb|php|swift|sh|ps1|sql|md|mdx|rst|adoc|html?|css|scss|sass|less|svg|png|jpe?g|gif|webp|ico|snap)$/.test(n)
  const configuration = /\.(?:json|jsonc|ya?ml|toml|ini|conf|config|xml|properties|env)$/.test(n)
    || /^\.?(?:credentials?|secrets?)(?:\.(?:txt|csv|tsv|bak|log))?$/.test(n)
    || /^(?:private[._-]?key|service[._-]?account)\.txt$/.test(n)
  if (directory || (!reviewable && configuration)) return { blocker: 'possible_credentials_or_private_key' }
  return { warning: 'credential_related_name_requires_content_review' }
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

/** In-memory, owner-scoped approvals. No SDK, workers, persistence or file-content reads. */
export class LayerFSImportReview {
  private readonly reviews = new Map<string, Review>()
  private readonly maxEntries: number
  private readonly maxDurationMs: number
  private readonly maxFindings: number
  constructor(limits: LayerFSImportReviewLimits = {}) {
    this.maxEntries = limit(limits.maxEntries, 100_000)
    this.maxDurationMs = limit(limits.maxDurationMs, 120_000)
    this.maxFindings = limit(limits.maxFindings, 100)
  }

  async preview(source: string, owner: string, signal: AbortSignal): Promise<LayerFSImportPreview> {
    this.prune()
    let path: string
    try {
      path = sourcePath(source)
      if (typeof owner !== 'string' || !owner.trim()) throw new Error('invalid_owner')
    } catch {
      return { status: 'blocked', summary: { entries: 0, files: 0, directories: 0, bytes: 0, complete: false },
        blockers: [{ path: '.', reason: 'invalid_source_or_owner' }], blockersTruncated: false, warnings: [], warningsTruncated: false, warning: WARNING, next: NEXT }
    }
    const { result, digest } = await this.scan(path, signal)
    if (result.status === 'review_required') {
      // Bound retained approvals too. Eviction fails closed for old callers.
      while (this.reviews.size >= 128) this.reviews.delete(this.reviews.keys().next().value!)
      const token = randomBytes(32).toString('hex')
      this.reviews.set(token, { source: path, owner, digest, expires: Date.now() + TTL_MS })
      result.reviewToken = token
    }
    return result
  }

  /** owner must be the caller's trusted project/session identity, not a model-supplied argument. */
  async consume(token: unknown, source: string, owner: string, reviewed: unknown, signal: AbortSignal): Promise<void> {
    this.prune()
    const review = typeof token === 'string' ? this.reviews.get(token) : undefined
    let path: string | undefined
    try { path = sourcePath(source) } catch { /* fail closed below */ }
    if (reviewed !== true || !review || review.owner !== owner || review.source !== path || signal.aborted) {
      throw new ToolNoEffectError('LayerFS import requires a fresh preview token for this project/session and source, and explicit human review (sourceReviewed: true). No import started.')
    }
    // Reserve synchronously before awaiting: concurrent consumption cannot reuse the token.
    this.reviews.delete(token as string)
    const scan = await this.scan(path!, signal)
    if (signal.aborted || Date.now() >= review.expires || scan.result.status === 'blocked' || scan.digest !== review.digest) {
      throw new ToolNoEffectError('LayerFS import review expired, was interrupted, or source metadata changed/was blocked. Preview the curated registered baseline again. No import started.')
    }
  }

  private prune(): void {
    const now = Date.now()
    for (const [token, review] of this.reviews) if (now >= review.expires) this.reviews.delete(token)
  }

  private async scan(source: string, signal: AbortSignal): Promise<Scan> {
    const result: LayerFSImportPreview = { status: 'review_required', summary: { entries: 0, files: 0, directories: 0, bytes: 0, complete: true },
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
      const rootReason = classifyLayerFSName(basename(source), true).blocker
      if (rootReason) { block('.', rootReason); result.summary.complete = false; return { result, digest: '' } }
      const pending = [{ path: source, relative: '.', depth: 0 }]
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
            if (s.isDirectory()) result.summary.directories++
            else {
              result.summary.files++
              if (s.size > BigInt(Number.MAX_SAFE_INTEGER - result.summary.bytes)) throw new Error('scan_byte_count_limit')
              result.summary.bytes += Number(s.size)
            }
            const classification = classifyLayerFSName(entry.name, s.isDirectory())
            if (classification.blocker) { block(relative, classification.blocker); if (s.isDirectory()) result.summary.complete = false; continue }
            if (classification.warning) {
              if (result.warnings.length < this.maxFindings) result.warnings.push({ path: safeName(relative), reason: classification.warning })
              else result.warningsTruncated = true
            }
            await bounded(() => access(path, constants.R_OK | (s.isDirectory() ? constants.X_OK : 0)))
            if (s.isDirectory()) {
              if (directory.depth >= 128) throw new Error('scan_depth_limit')
              pending.push({ path, relative, depth: directory.depth + 1 })
            }
          }
        } finally { close(dir) }
        current = directory.relative
        const after = await bounded(() => lstat(directory.path, { bigint: true }))
        if (metadata(before) !== metadata(after)) throw new Error('directory_changed')
      }
      check()
      // Sorting makes the digest independent of OS directory enumeration order.
      if (result.status !== 'blocked') digest = createHash('sha256').update(records.sort().join('\n')).digest('hex')
      check()
    } catch (error) {
      result.summary.complete = false
      const reason = error instanceof Error && ['scan_aborted', 'scan_time_limit', 'scan_entry_limit', 'scan_depth_limit', 'scan_byte_count_limit', 'directory_changed', 'nonportable_name'].includes(error.message)
        ? error.message : 'unreadable_or_unstable_entry'
      block(current, reason)
    }
    return { result, digest: result.status === 'blocked' ? '' : digest }
  }
}
