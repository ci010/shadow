import { projectStoragePath } from '../utils/data-paths.ts'
import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { lstat, mkdir, readFile, readdir, realpath, rename, rm } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { writePrivateFile } from '../config/store.ts'
import { appIcon } from './icon.ts'
import { appId, appManifestSchema, appRecordSchema, bundleSchema, MAX_BUNDLE_BYTES, MAX_FILE_BYTES, MicroAppError,
  appStateSchema, MAX_STATE_BYTES, type AppState, type AppBundle, type AppRecord, type AppWorkScope } from './contracts.ts'

export const bundleRevision = (bundle: AppBundle) => createHash('sha256').update(JSON.stringify({
  manifest: bundle.manifest, files: Object.fromEntries(Object.entries(bundle.files).sort(([a], [b]) => a.localeCompare(b))),
})).digest('hex')

export async function readAppBundle(directory: string, manifestValue: unknown, signal: AbortSignal): Promise<AppBundle> {
  signal.throwIfAborted()
  const manifest = appManifestSchema.parse(manifestValue)
  const source = await realpath(directory)
  const files: Record<string, string> = {}
  let size = 0
  for (const name of manifest.files) {
    signal.throwIfAborted()
    let path = source
    for (const part of name.split('/')) {
      path = join(path, part)
      if ((await lstat(path)).isSymbolicLink()) throw new MicroAppError('linked_file', `Publish regular app files, not symbolic links: ${name}`)
    }
    const stat = await lstat(path)
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new MicroAppError('invalid_file', `File is not regular or exceeds 4 MiB: ${name}`)
    const actual = await realpath(path)
    if (actual !== source && !actual.startsWith(source + sep)) throw new MicroAppError('outside_bundle', 'App files must stay within the source directory')
    const bytes = await readFile(actual, { signal })
    size += bytes.length
    if (bytes.length > MAX_FILE_BYTES || size > MAX_BUNDLE_BYTES) throw new MicroAppError('bundle_too_large', 'App files exceed the 16 MiB bundle limit', 413)
    files[name] = bytes.toString('base64')
  }
  const bundle = { manifest, files }
  appIcon(bundle)
  signal.throwIfAborted()
  return bundle
}

export class MicroAppStore {
  readonly root: string
  private records = new Map<string, AppRecord>()
  constructor(home: string) { this.root = projectStoragePath(home, '.microapps') }

  async init() {
    await mkdir(this.root, { recursive: true })
    for (const name of await readdir(this.root)) {
      if (!appId.safeParse(name).success) continue
      const record = appRecordSchema.parse(JSON.parse(await readFile(join(this.root, name, 'record.json'), 'utf8')))
      if (record.id !== name) throw new Error('Micro App record identity mismatch')
      if (record.lastRun && ['starting', 'running'].includes(record.lastRun.status)) {
        record.lastRun = { ...record.lastRun, status: 'interrupted', error: 'The previous runtime ended. Review any external effects before starting again.' }
      }
      if (record.acceptance && ['asking', 'dispatching', 'notified', 'running', 'testing'].includes(record.acceptance.status)) {
        record.acceptance.status = 'interrupted'
        record.acceptance.error = 'The runtime restarted. Inspect previous effects, then ask again in Apps; testing does not resume automatically.'
      }
      this.save(record)
    }
  }

  list(): AppRecord[] { return [...this.records.values()].map(record => structuredClone(record)) }
  get(id: string): AppRecord {
    const record = this.records.get(appId.parse(id))
    if (!record) throw new MicroAppError('app_not_found', 'App not found in this Project', 404)
    return structuredClone(record)
  }
  save(record: AppRecord) {
    const parsed = appRecordSchema.parse(record)
    if (parsed.acceptance && (parsed.acceptance.revision !== parsed.revision ||
      parsed.approval && parsed.acceptance.approvalAt !== parsed.approval.at)) throw new Error('Micro App acceptance identity mismatch')
    if (parsed.acceptance) writePrivateFile(join(this.root, parsed.id, `acceptance-${parsed.acceptance.id}.json`), JSON.stringify(parsed.acceptance))
    writePrivateFile(join(this.root, parsed.id, 'record.json'), JSON.stringify(parsed))
    this.records.set(parsed.id, parsed)
  }
  dataPath(id: string) { return join(this.root, appId.parse(id), 'data') }

  loadState(id: string): AppState {
    this.get(id)
    const path = join(this.root, id, 'state.json')
    let raw: string
    try {
      const stat = lstatSync(path)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STATE_BYTES) {
        throw new MicroAppError('invalid_app_state', 'Stored app state is not a bounded regular file', 409)
      }
      raw = readFileSync(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 0, values: {} }
      throw error
    }
    if (Buffer.byteLength(raw) > MAX_STATE_BYTES) throw new MicroAppError('invalid_app_state', 'Stored app state exceeds its limit', 409)
    let value: unknown
    try { value = JSON.parse(raw) }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      throw new MicroAppError('invalid_app_state', 'Stored app state is invalid; it was not reset or overwritten', 409)
    }
    const parsed = appStateSchema.safeParse(value)
    if (!parsed.success) throw new MicroAppError('invalid_app_state', 'Stored app state is invalid; it was not reset or overwritten', 409)
    return parsed.data
  }

  saveState(id: string, input: unknown): AppState {
    const requested = appStateSchema.parse(input)
    const current = this.loadState(id)
    if (requested.version !== current.version) {
      throw new MicroAppError('app_state_conflict', 'App state changed. Reload and reconcile before saving; do not blindly retry.', 409)
    }
    const next = appStateSchema.parse({ version: current.version + 1, values: requested.values })
    const content = JSON.stringify(next)
    if (Buffer.byteLength(content) > MAX_STATE_BYTES) throw new MicroAppError('app_state_too_large', 'App state exceeds 64 KiB', 413)
    // One runtime owns this Project; synchronous compare-and-replace cannot interleave.
    writePrivateFile(join(this.root, id, 'state.json'), content)
    return next
  }

  async bundle(record: AppRecord): Promise<AppBundle> {
    const path = join(this.root, record.id, `${record.revision}.json`)
    if ((await lstat(path)).size > MAX_BUNDLE_BYTES * 2) throw new MicroAppError('bundle_too_large', 'Stored app bundle exceeds its limit', 413)
    const raw = await readFile(path)
    if (raw.length > MAX_BUNDLE_BYTES * 2) throw new MicroAppError('bundle_too_large', 'Stored app bundle exceeds its limit', 413)
    const bundle = bundleSchema.parse(JSON.parse(raw.toString('utf8')))
    if (Object.keys(bundle.files).length !== bundle.manifest.files.length
      || bundle.manifest.files.some(name => !Object.hasOwn(bundle.files, name))) {
      throw new MicroAppError('invalid_bundle', 'Bundle files do not match its manifest', 409)
    }
    let size = 0
    for (const base64 of Object.values(bundle.files)) {
      const bytes = Buffer.from(base64, 'base64')
      size += bytes.length
      if (bytes.toString('base64') !== base64 || bytes.length > MAX_FILE_BYTES || size > MAX_BUNDLE_BYTES) {
        throw new MicroAppError('invalid_bundle', 'Bundle contents exceed limits or are not valid encoded files', 409)
      }
    }
    if (bundleRevision(bundle) !== record.revision || JSON.stringify(bundle.manifest) !== JSON.stringify(record.manifest)) {
      throw new MicroAppError('bundle_changed', 'App bundle changed after publication; publish and review a new revision', 409)
    }
    appIcon(bundle)
    return bundle
  }

  async publish(directory: string, manifestValue: unknown, sessionId: string, signal: AbortSignal, id?: string, expectedRevision?: string, work?: AppWorkScope[]) {
    const previous = id ? this.get(id) : undefined
    if (previous && previous.revision !== expectedRevision) throw new MicroAppError('revision_changed', 'Reload the app before publishing changes', 409)
    const bundle = await readAppBundle(directory, manifestValue, signal)
    const { manifest } = bundle, revision = bundleRevision(bundle)
    if (previous && this.get(previous.id).revision !== expectedRevision) throw new MicroAppError('revision_changed', 'Another publication changed this app', 409)
    if (previous?.revision === revision) return previous
    const now = new Date().toISOString()
    const record: AppRecord = {
      version: 1, id: previous?.id ?? randomUUID(), revision, manifest,
      createdBy: previous?.createdBy ?? sessionId, createdAt: previous?.createdAt ?? now, updatedAt: now, calls: 0,
      ...(work?.length ? { work } : {}),
    }
    if (previous) {
      writePrivateFile(join(this.root, record.id, `${revision}.json`), JSON.stringify(bundle))
      this.save(record)
    } else {
      const staging = join(this.root, `.publish-${record.id}`)
      await mkdir(staging)
      try {
        writePrivateFile(join(staging, `${revision}.json`), JSON.stringify(bundle))
        writePrivateFile(join(staging, 'record.json'), JSON.stringify(record))
        signal.throwIfAborted()
        await rename(staging, join(this.root, record.id))
        this.records.set(record.id, record)
      } finally { await rm(staging, { recursive: true, force: true }) }
    }
    return record
  }
}

export async function localAppDirectory(cwd: string, directory: string) {
  const base = await realpath(cwd), path = await realpath(resolve(base, directory))
  const rel = relative(base, path)
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`) || resolve(base, rel) !== path) {
    throw new MicroAppError('outside_workdir', 'Publish from the effective local workdir; do not copy another directory into the app')
  }
  return path
}
