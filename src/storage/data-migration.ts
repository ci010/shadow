import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, toNamespacedPath } from 'node:path'
import { DatabaseSync, backup } from 'node:sqlite'
import { PROJECT_STORAGE_ENTRIES } from '../utils/data-paths.ts'

const fsPath = (path: string) => {
  const absolute = resolve(path)
  // Node/Windows lstat rejects namespaced volume roots (\\\\?\\C:\\).
  return dirname(absolute) === absolute ? absolute : toNamespacedPath(absolute)
}
const roots = ['config', 'cluster', 'workspace', 'workspace.projects']
const targets = ['projects.json', 'devices', 'telemetry', 'projects', 'app.json']
type Fingerprint = { kind: 'file' | 'directory'; mode: number; size: number; mtime: number; hash?: string }
type Inventory = Record<string, Fingerprint>
type Mapping = { source: string; target: string }
export interface MigrationPlan { root: string; preliminary: true; files: number; bytes: number; projects: string[] }
export interface MigrationOptions {
  offline?: boolean
  /** Test/embedding observation hook. Never substitutes for stopped writers. */
  onPhase?: (phase: 'staged' | 'before-publish') => void | Promise<void>
}
async function exists(path: string) {
  try { await lstat(fsPath(path)); return true } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e }
}
async function noLinks(path: string) {
  for (let current = resolve(path); ; current = dirname(current)) {
    if (await exists(current)) {
      const stat = await lstat(fsPath(current))
      if (stat.isSymbolicLink()) throw new Error(`Links/junctions are not supported: ${current}`)
    }
    if (dirname(current) === current) break
  }
}
async function hash(path: string) {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(fsPath(path))) digest.update(chunk)
  return digest.digest('hex')
}
async function fingerprint(path: string): Promise<Fingerprint> {
  await noLinks(path)
  const before = await lstat(fsPath(path))
  if (!before.isFile() && !before.isDirectory()) throw new Error(`Unsupported file type: ${path}`)
  const result: Fingerprint = { kind: before.isDirectory() ? 'directory' : 'file', mode: before.mode & 0o777, size: before.isDirectory() ? 0 : before.size, mtime: before.mtimeMs }
  if (before.isFile()) result.hash = await hash(path)
  const after = await lstat(fsPath(path))
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) throw new Error(`Source changed while reading: ${path}`)
  return result
}
async function inventory(root: string, entries: string[]): Promise<Inventory> {
  const result: Inventory = {}
  async function visit(relative: string) {
    const path = join(root, relative)
    result[relative] = await fingerprint(path)
    if (result[relative]!.kind === 'directory') for (const child of (await readdir(fsPath(path))).sort()) await visit(join(relative, child))
  }
  await noLinks(root)
  for (const entry of entries) if (await exists(join(root, entry))) await visit(entry)
  return result
}
function equal(a: unknown, b: unknown) { return JSON.stringify(a) === JSON.stringify(b) }
function assertSame(a: Inventory, b: Inventory, label: string) {
  if (!equal(a, b)) throw new Error(`${label} changed; refusing migration`)
}
async function json(path: string) { return JSON.parse(await readFile(fsPath(path), 'utf8')) }
async function writeJson(path: string, value: unknown) {
  await mkdir(fsPath(dirname(path)), { recursive: true, mode: 0o700 })
  await writeFile(fsPath(path), JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
}
async function describe(root: string, source: Inventory): Promise<{ mappings: Mapping[]; ids: string[] }> {
  const catalog = await json(join(root, 'workspace.projects', 'projects.v2.json'))
  if (catalog.version !== 2 || !Array.isArray(catalog.projects)) throw new Error('Invalid legacy project catalog')
  const ids: string[] = catalog.projects.map((p: { id?: unknown }) => {
    if (typeof p.id !== 'string' || !/^(?:default|[0-9a-f]{8}-[0-9a-f-]{27})$/.test(p.id)) throw new Error('Invalid project id')
    return p.id
  })
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate project id')
  if (!ids.includes('default')) throw new Error('Default project missing')
  if (!source[join('config', 'bot.config.json')]) throw new Error('Legacy app configuration missing')
  const mappings: Mapping[] = []
  const destinations = new Map<string, Mapping>()
  for (const [path, info] of Object.entries(source)) {
    const parts = path.split(/[\\/]/)
    const [top, second, id, section, ...rest] = parts
    let target: string | undefined
    if (top === 'workspace') {
      if (parts.length > 1) throw new Error('Nonempty legacy single workspace is not supported')
    } else if (top === 'config') {
      if (parts.length > 1 && second !== 'bot.config.json') throw new Error(`Unmapped app config entry: ${path}`)
      if (second === 'bot.config.json') target = 'app.json'
    } else if (top === 'cluster') target = join('devices', ...parts.slice(1))
    else if (top === 'workspace.projects') {
      if (second === 'projects.v2.json') target = 'projects.json'
      else if (second?.startsWith('.host.otel.db') && ['.host.otel.db', '.host.otel.db-wal', '.host.otel.db-shm', '.host.otel.db-journal'].includes(second)) target = join('telemetry', second.replace('.host.otel.db', 'host.db'))
      else if (second === 'projects') {
        if (id && !ids.includes(id)) throw new Error(`Uncatalogued project: ${id}`)
        if (id && section === 'config') target = join('projects', id, 'config', ...rest)
        else if (id && section === 'workspace' && rest.length) {
          const [entry, ...tail] = rest
          target = join('projects', id, ...(Object.hasOwn(PROJECT_STORAGE_ENTRIES, entry!) ? PROJECT_STORAGE_ENTRIES[entry!]! : ['workdirs', entry!]), ...tail)
        } else if (section && section !== 'workspace') throw new Error(`Unknown project entry: ${path}`)
      } else if (second) throw new Error(`Unknown legacy catalog entry: ${path}`)
    }
    if (target) {
      const key = target.toLowerCase()
      const previous = destinations.get(key)
      if (previous && (info.kind !== 'directory' || source[previous.source]!.kind !== 'directory' || info.mode !== source[previous.source]!.mode)) throw new Error(`Migration target conflict: ${target}`)
      if (!previous) {
        const mapping = { source: path, target }
        mappings.push(mapping)
        destinations.set(key, mapping)
      }
    }
  }
  for (const id of ids) if (!source[join('workspace.projects', 'projects', id, 'workspace')]) throw new Error(`Project Home missing: ${id}`)
  return { mappings, ids }
}

/** Read-only, preliminary inventory. A successful plan is NOT proof of quiescence. */
export async function planDataMigration(dataDir: string): Promise<MigrationPlan> {
  const root = resolve(dataDir)
  const source = await inventory(root, roots)
  const { ids } = await describe(root, source)
  return { root, preliminary: true, files: Object.values(source).filter(f => f.kind === 'file').length, bytes: Object.values(source).reduce((n, f) => n + f.size, 0), projects: ids }
}

async function sqliteFile(path: string) {
  const { open } = await import('node:fs/promises')
  const file = await open(fsPath(path), 'r')
  try {
    const header = Buffer.alloc(16)
    const { bytesRead } = await file.read(header, 0, 16, 0)
    return bytesRead === 16 && header.toString('binary') === 'SQLite format 3\0'
  } finally { await file.close() }
}
async function copyChecked(root: string, source: string, dest: string, expected: Fingerprint) {
  const path = join(root, source)
  if (!equal(await fingerprint(path), expected)) throw new Error(`Source changed: ${source}`)
  await mkdir(fsPath(dirname(dest)), { recursive: true, mode: 0o700 })
  await copyFile(fsPath(path), fsPath(dest), 1 /* COPYFILE_EXCL */)
  if (await hash(dest) !== expected.hash || !equal(await fingerprint(path), expected)) throw new Error(`Copy verification failed/source changed: ${source}`)
  await chmod(fsPath(dest), expected.mode)
}
function databaseSummary(db: DatabaseSync) {
  const integrity = db.prepare('PRAGMA integrity_check').all()
  if (integrity.length !== 1 || Object.values(integrity[0]!)[0] !== 'ok') throw new Error('SQLite integrity_check failed')
  const schema = db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all()
  const counts = schema.filter(row => row.type === 'table').map(row => {
    const name = String(row.name).replaceAll('"', '""')
    const statement = db.prepare(`SELECT count(*) AS n FROM "${name}"`)
    statement.setReadBigInts(true)
    return [row.name, String(statement.get()!.n)]
  })
  return { schema, counts }
}
async function recoverDatabase(root: string, mapping: Mapping, source: Inventory, stage: string, scratch: string) {
  const privateDir = join(scratch, randomUUID())
  await mkdir(fsPath(privateDir), { recursive: true, mode: 0o700 })
  const local = join(privateDir, 'database')
  for (const suffix of ['', '-wal', '-journal']) {
    const info = source[mapping.source + suffix]
    if (!info) continue
    if (info.kind !== 'file') throw new Error(`Invalid SQLite companion: ${mapping.source + suffix}`)
    await copyChecked(root, mapping.source + suffix, local + suffix, info)
    await chmod(fsPath(local + suffix), 0o600)
  }
  const dest = join(stage, mapping.target)
  await mkdir(fsPath(dirname(dest)), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(fsPath(local))
  try {
    const before = databaseSummary(db)
    await backup(db, fsPath(dest))
    const output = new DatabaseSync(fsPath(dest))
    try {
      output.exec('PRAGMA journal_mode=DELETE')
      if (!equal(before, databaseSummary(output))) throw new Error('SQLite schema/row-count verification failed')
    } finally { output.close() }
  } finally { db.close() }
  await chmod(fsPath(dest), source[mapping.source]!.mode)
}
/** Change only the workspace token; preserve unknown numbers, secrets and formatting exactly. */
function workspacePatch(text: string, workspace: string): string {
  const parsed: unknown = JSON.parse(text)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Config must be a JSON object')
  type Token = { start: number; end: number; properties?: Map<string, Token> }
  let offset = 0
  const whitespace = () => { while (offset < text.length && /\s/.test(text[offset]!)) offset++ }
  const string = () => {
    const start = offset++
    while (offset < text.length) {
      if (text[offset] === '\\') offset += 2
      else if (text[offset++] === '"') break
    }
    return JSON.parse(text.slice(start, offset)) as string
  }
  const value = (): Token => {
    whitespace()
    const start = offset
    if (text[offset] === '{') {
      offset++; whitespace()
      const properties = new Map<string, Token>()
      while (text[offset] !== '}') {
        const key = string(); whitespace(); offset++
        if (properties.has(key)) throw new Error('Duplicate config JSON property; migration refused')
        properties.set(key, value()); whitespace()
        if (text[offset] !== ',') break
        offset++; whitespace()
      }
      offset++
      return { start, end: offset, properties }
    }
    if (text[offset] === '[') {
      offset++; whitespace()
      while (text[offset] !== ']') {
        value(); whitespace()
        if (text[offset] !== ',') break
        offset++; whitespace()
      }
      offset++
    } else if (text[offset] === '"') string()
    else while (offset < text.length && !/[\s,}\]]/.test(text[offset]!)) offset++
    return { start, end: offset }
  }
  const root = value()
  const agent = root.properties!.get('agent')
  const replacement = JSON.stringify(workspace)
  const insert = (token: Token, property: string) => text.slice(0, token.end - 1) +
    (token.properties!.size ? ',' : '') + property + text.slice(token.end - 1)
  if (!agent) return insert(root, `"agent":{"workspace":${replacement}}`)
  if (!agent.properties) throw new Error('Config agent must be an object')
  const field = agent.properties.get('workspace')
  if (!field) return insert(agent, `"workspace":${replacement}`)
  return text.slice(0, field.start) + replacement + text.slice(field.end)
}
async function patchWorkspace(path: string, workspace: string) {
  if (!await exists(path)) return
  const content = workspacePatch(await readFile(fsPath(path), 'utf8'), workspace)
  const mode = (await lstat(fsPath(path))).mode & 0o777
  await chmod(fsPath(path), mode | 0o200)
  try { await writeFile(fsPath(path), content) }
  finally { await chmod(fsPath(path), mode) }
}

/** Offline, same-root, copy-only migration. Caller must actually stop ALL writers.
 * Never run automatically at startup. An interrupted lock requires operator review;
 * do not remove it until publication/rollback and source consistency are inspected.
 */
export async function copyDataMigration(dataDir: string, options: MigrationOptions = {}): Promise<{ status: 'copied' | 'already-copied'; receipt: string }> {
  if (options.offline !== true) throw new Error('Copy requires explicit offline acknowledgement; stop all writers first')
  const root = resolve(dataDir)
  const control = join(root, '.layout-migration')
  const lock = join(control, 'copy.lock')
  const receiptPath = join(control, 'receipt.json')
  await noLinks(root)
  await noLinks(control)
  await mkdir(fsPath(control), { recursive: true, mode: 0o700 })
  await mkdir(fsPath(lock), { mode: 0o700 }) // exclusive; stale locks deliberately block retries
  const stage = join(control, `stage-${randomUUID()}`)
  const scratch = join(control, `scratch-${randomUUID()}`)
  const published: string[] = []
  let retainLock = false
  try {
    await noLinks(receiptPath)
    const source = await inventory(root, roots)
    if (await exists(receiptPath)) {
      const receipt = await json(receiptPath)
      if (receipt.version !== 1 || receipt.root !== root) throw new Error('Invalid migration receipt')
      assertSame(receipt.source, source, 'Source since receipt')
      assertSame(receipt.target, await inventory(root, targets), 'Target since receipt')
      return { status: 'already-copied', receipt: receiptPath }
    }
    for (const target of targets) {
      await noLinks(join(root, target))
      if (await exists(join(root, target))) throw new Error(`Unknown existing migration target: ${target}`)
    }
    const { mappings, ids } = await describe(root, source)
    await mkdir(fsPath(stage), { mode: 0o700 })
    await mkdir(fsPath(scratch), { mode: 0o700 })
    const databases = new Set<string>()
    for (const m of mappings) if (source[m.source]!.kind === 'file' && await sqliteFile(join(root, m.source))) databases.add(m.source)
    const companions = new Set<string>()
    for (const db of databases) for (const suffix of ['-wal', '-shm', '-journal']) if (source[db + suffix]) {
      if (source[db + suffix]!.kind !== 'file') throw new Error(`Invalid SQLite companion: ${db + suffix}`)
      companions.add(db + suffix)
    }
    for (const m of mappings) {
      if (companions.has(m.source)) continue
      const info = source[m.source]!
      if (info.kind === 'directory') await mkdir(fsPath(join(stage, m.target)), { recursive: true, mode: 0o700 })
      else if (databases.has(m.source)) await recoverDatabase(root, m, source, stage, scratch)
      else await copyChecked(root, m.source, join(stage, m.target), info)
    }
    for (const id of ids) {
      const home = join(root, 'projects', id)
      for (const part of ['config', 'memory', 'state', 'workdirs', 'cache', 'tmp']) await mkdir(fsPath(join(stage, 'projects', id, part)), { recursive: true, mode: 0o700 })
      await patchWorkspace(join(stage, 'projects', id, 'config', 'project.json'), home)
      await writeJson(join(stage, 'projects', id, 'state', 'layout-migration.json'), { version: 1, legacyHome: join(root, 'workspace.projects', 'projects', id, 'workspace') })
    }
    await patchWorkspace(join(stage, 'app.json'), root)
    for (const m of [...mappings].reverse()) if (source[m.source]!.kind === 'directory') await chmod(fsPath(join(stage, m.target)), source[m.source]!.mode)
    // All content is verified before exposing ANY final target. Scan count is bounded,
    // independent of the number of databases or publication steps.
    const staged = await inventory(stage, targets)
    await options.onPhase?.('staged')
    await options.onPhase?.('before-publish')
    assertSame(staged, await inventory(stage, targets), 'Staging')
    assertSame(source, await inventory(root, roots), 'Source')
    for (const target of targets) {
      if (!await exists(join(stage, target))) continue
      await noLinks(join(root, target))
      if (await exists(join(root, target))) throw new Error(`Target appeared during migration: ${target}`)
      await rename(fsPath(join(stage, target)), fsPath(join(root, target)))
      published.push(target)
    }
    const target = await inventory(root, targets)
    assertSame(staged, target, 'Published target')
    assertSame(source, await inventory(root, roots), 'Source after publication')
    await writeJson(receiptPath, { version: 1, root, createdAt: new Date().toISOString(), source, target })
    return { status: 'copied', receipt: receiptPath }
  } catch (error) {
    const failures: unknown[] = []
    for (const target of published.reverse()) {
      try { await rename(fsPath(join(root, target)), fsPath(join(stage, target))) } catch (failure) { failures.push(failure) }
    }
    if (failures.length) {
      retainLock = true
      throw new AggregateError([error, ...failures], 'Migration failed; rollback incomplete. Lock/staging retained for manual recovery')
    }
    throw error
  } finally {
    if (!retainLock) {
      // If cleanup fails retain the lock and evidence rather than claiming completion.
      await rm(fsPath(stage), { recursive: true, force: true })
      await rm(fsPath(scratch), { recursive: true, force: true })
      await rm(fsPath(lock), { recursive: true })
    }
  }
}
