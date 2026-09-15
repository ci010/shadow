import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, readlink,
  realpath, rename, rm, symlink, utimes,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export interface HomeMigrationOptions {
  sourceHome: string
  targetHome: string
  organizationId: string
  /** The host must stop legacy writers and serialize layout migration before calling. */
  sourceIsQuiescent: true
  signal?: AbortSignal
  /** Apply resumable metadata transformations only to the verified staging copy. */
  prepare?: (stagedHome: string) => Promise<void>
}

export interface HomeMigrationResult {
  migrated: boolean
  sourceHome: string
  targetHome: string
}

interface MigrationMarker {
  version: 1
  organizationId: string
  sourceHome: string
  targetHome: string
  nonce: string
  phase: 'copying' | 'ready'
  sourceDigest?: string
}

interface MigrationJournal extends MigrationMarker {
  stagingHome: string
}

interface Entry {
  path: string
  kind: 'directory' | 'file' | 'link'
  mode: number
  size?: number
  digest?: string
  link?: string
  relocatedLink?: string
}

const MARKER = '.organization-home-migration.v1.json'
const active = new Set<string>()

export class HomeMigrationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'HomeMigrationError'
  }
}

function inside(root: string, path: string): boolean {
  const value = relative(root, path)
  return value === '' || (!isAbsolute(value) && value !== '..' && !value.startsWith(`..${sep}`))
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function digestFile(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256')
  const stream = createReadStream(path, { signal })
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest('hex')
}

async function inventory(root: string, relocatedRoot: string, signal?: AbortSignal): Promise<Entry[]> {
  const entries: Entry[] = []
  async function visit(directory: string): Promise<void> {
    for (const name of (await readdir(directory)).sort()) {
      signal?.throwIfAborted()
      const path = join(directory, name)
      const key = relative(root, path)
      if (key === MARKER) throw new HomeMigrationError('reserved-file', 'The legacy Home contains reserved organization migration metadata.')
      const stat = await lstat(path)
      const mode = stat.mode & 0o777
      if (stat.isSymbolicLink()) {
        const target = await realpath(path)
        if (!inside(root, target)) {
          throw new HomeMigrationError('external-link', `Review the external Home link before migration: ${key}`)
        }
        const link = await readlink(path)
        // Absolute links must point at the published Home, not the temporary copy.
        const relocatedLink = isAbsolute(link) ? join(relocatedRoot, relative(root, target)) : link
        if (!isAbsolute(link) && !inside(root, resolve(directory, link))) {
          throw new HomeMigrationError('external-link', `Review the Home link before migration: ${key}`)
        }
        entries.push({ path: key, kind: 'link', mode, link, relocatedLink })
      } else if (stat.isDirectory()) {
        entries.push({ path: key, kind: 'directory', mode })
        await visit(path)
      } else if (stat.isFile()) {
        entries.push({ path: key, kind: 'file', mode, size: stat.size, digest: await digestFile(path, signal) })
      } else {
        throw new HomeMigrationError('unsupported-entry', `Review the non-file Home entry before migration: ${key}`)
      }
    }
  }
  await visit(root)
  return entries
}

function inventoryDigest(entries: Entry[]): string {
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex')
}

function parseMarker(value: unknown, expected: Pick<MigrationMarker, 'organizationId' | 'sourceHome' | 'targetHome'>): MigrationMarker {
  if (typeof value !== 'object' || value === null) throw new HomeMigrationError('invalid-journal', 'Invalid Home migration journal.')
  const item = value as Record<string, unknown>
  if (item.version !== 1 || item.organizationId !== expected.organizationId ||
    item.sourceHome !== expected.sourceHome || item.targetHome !== expected.targetHome ||
    typeof item.nonce !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(item.nonce) ||
    (item.phase !== 'copying' && item.phase !== 'ready') ||
    (item.phase === 'ready' && (typeof item.sourceDigest !== 'string' || !/^[0-9a-f]{64}$/.test(item.sourceDigest)))) {
    throw new HomeMigrationError('invalid-journal', 'Home migration metadata does not match the requested organization and paths.')
  }
  return {
    version: 1, ...expected, nonce: item.nonce, phase: item.phase,
    ...(typeof item.sourceDigest === 'string' ? { sourceDigest: item.sourceDigest } : {}),
  }
}

async function writeJson(path: string, value: unknown, exclusive = false): Promise<void> {
  const temporary = exclusive ? path : `${path}.${randomUUID()}.tmp`
  const file = await open(temporary, 'wx', 0o600)
  let written = false
  try {
    try {
      await file.writeFile(`${JSON.stringify(value)}\n`, 'utf8')
      await file.sync()
    } finally {
      await file.close()
    }
    if (!exclusive) await rename(temporary, path)
    written = true
  } finally {
    if (!exclusive || !written) await rm(temporary, { force: true })
  }
}

/** Copy the complete stopped Home, including SQLite WAL/SHM, without changing its source. */
export async function migrateLegacyHome(options: HomeMigrationOptions): Promise<HomeMigrationResult> {
  if (options.sourceIsQuiescent !== true || !isAbsolute(options.sourceHome) || !isAbsolute(options.targetHome) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(options.organizationId)) {
    throw new HomeMigrationError('invalid-request', 'Home migration requires absolute paths, a valid organization ID, and stopped legacy writers.')
  }
  const activeKey = process.platform === 'win32' ? resolve(options.targetHome).toLowerCase() : resolve(options.targetHome)
  if (active.has(activeKey)) throw new HomeMigrationError('migration-running', 'This Home migration is already running.')
  active.add(activeKey)
  try { return await migrate(options) }
  finally { active.delete(activeKey) }
}

async function migrate(options: HomeMigrationOptions): Promise<HomeMigrationResult> {
  options.signal?.throwIfAborted()
  const sourceHome = await realpath(options.sourceHome)
  if (!(await lstat(sourceHome)).isDirectory()) throw new HomeMigrationError('invalid-source', 'Legacy Home must be a directory.')
  if (inside(sourceHome, resolve(options.targetHome)) || inside(resolve(options.targetHome), sourceHome)) {
    throw new HomeMigrationError('overlapping-homes', 'Source and target Home directories must not overlap.')
  }
  await mkdir(dirname(options.targetHome), { recursive: true })
  const targetHome = join(await realpath(dirname(options.targetHome)), basename(options.targetHome))
  if (inside(sourceHome, targetHome) || inside(targetHome, sourceHome)) {
    throw new HomeMigrationError('overlapping-homes', 'Source and target Home directories must not overlap.')
  }
  const expected = { organizationId: options.organizationId, sourceHome, targetHome }
  const journalPath = `${targetHome}.migration.json`
  const prefix = `${basename(targetHome)}.migration-`
  const result = (migrated: boolean) => ({ migrated, sourceHome, targetHome })

  if (await exists(targetHome)) {
    const target = await lstat(targetHome)
    if (!target.isDirectory() || target.isSymbolicLink() || !await exists(join(targetHome, MARKER))) {
      throw new HomeMigrationError('target-exists', 'The target Home already exists; it will not be overwritten.')
    }
    const marker = parseMarker(JSON.parse(await readFile(join(targetHome, MARKER), 'utf8')), expected)
    if (marker.phase !== 'ready') throw new HomeMigrationError('incomplete-target', 'The target Home is not a completed migration.')
    if (await exists(journalPath)) {
      const journal = parseMarker(JSON.parse(await readFile(journalPath, 'utf8')), expected)
      if (journal.nonce !== marker.nonce) throw new HomeMigrationError('invalid-journal', 'The Home migration journal has a different owner.')
      await rm(journalPath)
    }
    return result(false)
  }

  if (await exists(journalPath)) {
    const raw: unknown = JSON.parse(await readFile(journalPath, 'utf8'))
    const journal = parseMarker(raw, expected)
    const stagingHome = typeof raw === 'object' && raw !== null && 'stagingHome' in raw ? raw.stagingHome : undefined
    if (typeof stagingHome !== 'string' || dirname(stagingHome) !== dirname(targetHome) ||
      !basename(stagingHome).startsWith(prefix) || !await exists(stagingHome) ||
      (await lstat(stagingHome)).isSymbolicLink()) {
      throw new HomeMigrationError('invalid-journal', 'The migration staging directory cannot be verified.')
    }
    const marker = parseMarker(JSON.parse(await readFile(join(stagingHome, MARKER), 'utf8')), expected)
    if (marker.nonce !== journal.nonce) throw new HomeMigrationError('invalid-journal', 'The staging copy has a different migration owner.')
    if (journal.phase === 'ready' && marker.phase === 'ready') {
      const digest = inventoryDigest(await inventory(sourceHome, targetHome, options.signal))
      if (digest !== journal.sourceDigest || digest !== marker.sourceDigest) {
        throw new HomeMigrationError('source-changed', 'Legacy Home changed after migration preparation; review recovery before proceeding.')
      }
      options.signal?.throwIfAborted()
      await rename(stagingHome, targetHome)
      await rm(journalPath)
      return result(true)
    }
    await rm(stagingHome, { recursive: true })
    await rm(journalPath)
  }

  const entries = await inventory(sourceHome, targetHome, options.signal)
  const sourceDigest = inventoryDigest(entries)
  const stagingHome = await mkdtemp(join(dirname(targetHome), prefix))
  const marker: MigrationMarker = { version: 1, ...expected, nonce: randomUUID(), phase: 'copying' }
  let journalOwned = false
  let published = false
  try {
    await writeJson(join(stagingHome, MARKER), marker, true)
    await writeJson(journalPath, { ...marker, stagingHome } satisfies MigrationJournal, true)
    journalOwned = true
    for (const entry of entries) {
      options.signal?.throwIfAborted()
      const source = join(sourceHome, entry.path)
      const target = join(stagingHome, entry.path)
      if (entry.kind === 'directory') {
        await mkdir(target, { mode: entry.mode })
      } else if (entry.kind === 'link') {
        const directory = (await lstat(await realpath(source))).isDirectory()
        await symlink(entry.relocatedLink!, target, directory ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file')
      } else {
        await copyFile(source, target)
        await chmod(target, entry.mode)
        const stat = await lstat(source)
        await utimes(target, stat.atime, stat.mtime)
        if (await digestFile(target, options.signal) !== entry.digest) {
          throw new HomeMigrationError('copy-mismatch', `The Home copy could not be verified: ${entry.path}`)
        }
      }
    }
    if (inventoryDigest(await inventory(sourceHome, targetHome, options.signal)) !== sourceDigest) {
      throw new HomeMigrationError('source-changed', 'Legacy Home changed during migration; stop its writers and retry.')
    }
    await options.prepare?.(stagingHome)
    options.signal?.throwIfAborted()
    if (inventoryDigest(await inventory(sourceHome, targetHome, options.signal)) !== sourceDigest) {
      throw new HomeMigrationError('source-changed', 'Legacy Home changed during migration preparation.')
    }
    const ready: MigrationMarker = { ...marker, phase: 'ready', sourceDigest }
    await writeJson(join(stagingHome, MARKER), ready)
    await writeJson(journalPath, { ...ready, stagingHome } satisfies MigrationJournal)
    if (await exists(targetHome)) throw new HomeMigrationError('target-exists', 'The target Home appeared during migration; it will not be overwritten.')
    options.signal?.throwIfAborted()
    await rename(stagingHome, targetHome)
    published = true
    await rm(journalPath)
    return result(true)
  } catch (error) {
    if (!published) {
      const failures: unknown[] = [error]
      try { await rm(stagingHome, { recursive: true }) } catch (cleanup) { failures.push(cleanup) }
      if (journalOwned) {
        try { await rm(journalPath) } catch (cleanup) { failures.push(cleanup) }
      }
      if (failures.length > 1) throw new AggregateError(failures, 'Home migration failed and staging cleanup needs recovery.')
    }
    throw error
  }
}
