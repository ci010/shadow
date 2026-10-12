import { projectStoragePath } from '../utils/data-paths.ts'
import { randomUUID } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { mkdir, open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, normalize, parse } from 'node:path'
import type { WorkdirCapabilityState, WorkdirRefV1 } from '../sessions/locality.ts'
import type { FolderRecord } from './contracts.ts'
import type { ProjectCatalog } from '../projects/catalog.ts'
import type { RemoteFolderOwnership } from './remote-ownership.ts'
import type { RemoteFolderRecord } from './contracts.ts'
import { isManagedWorkdir, ownsManagedWorkdir } from '../execution/managed-workdir.ts'

// A rename must not mint new capability identities for existing directory grants.
const FOLDER_PREFIX = 'local-project-v1:'
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export class FolderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 404 | 409 | 500 | 503 = 400,
  ) {
    super(message)
    this.name = 'FolderError'
  }
}

export function absoluteDirectoryPath(value: unknown): string {
  if (
    typeof value !== 'string' || !value || value.length > 10_000 ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    !isAbsolute(value) ||
    (process.platform === 'win32' && parse(normalize(value)).root === '\\')
  ) {
    throw new FolderError('invalid_path', 'Choose an absolute folder path.')
  }
  return normalize(value)
}

function pathKey(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value
}

export async function existingDirectory(value: unknown): Promise<string> {
  const path = absoluteDirectoryPath(value)
  try {
    const canonical = await realpath(path)
    if (!(await stat(canonical)).isDirectory()) throw new Error('not directory')
    return canonical
  } catch {
    throw new FolderError(
      'folder_unavailable',
      'The folder is unavailable. Restore it or open an existing folder.',
      409,
    )
  }
}

function parseRecords(value: unknown): FolderRecord[] {
  const invalid = () => new FolderError(
    'invalid_registry',
    'The saved folder registry is invalid. Restore the registry before continuing.',
    500,
  )
  if (
    !value || typeof value !== 'object' ||
    !('version' in value) || value.version !== 2 || Object.keys(value).some(key => !['version', 'folders'].includes(key)) ||
    !('folders' in value) || !Array.isArray(value.folders)
  ) throw invalid()
  const ids = new Set<string>()
  const paths = new Set<string>()
  return value.folders.map((record: unknown) => {
    if (!record || typeof record !== 'object') throw invalid()
    const item = record as Record<string, unknown>
    if (
      typeof item.id !== 'string' || !UUID_PATTERN.test(item.id) ||
      typeof item.name !== 'string' || !item.name.trim() ||
      typeof item.createdAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(item.createdAt) ||
      !Number.isFinite(Date.parse(item.createdAt)) ||
      new Date(item.createdAt).toISOString() !== item.createdAt
    ) throw invalid()
    let path: string
    try {
      path = absoluteDirectoryPath(item.path)
    } catch {
      throw invalid()
    }
    if (ids.has(item.id.toLowerCase()) || paths.has(pathKey(path))) throw invalid()
    ids.add(item.id.toLowerCase())
    paths.add(pathKey(path))
    return { id: item.id, name: item.name, path, createdAt: item.createdAt }
  })
}

export class FolderRegistry {
  readonly filePath: string
  #records: FolderRecord[] = []
  #initialization?: Promise<void>
  #ready = false
  #writes: Promise<unknown> = Promise.resolve()
  #remoteOwnership?: RemoteFolderOwnership

  constructor(workspace: string, private readonly scope?: { projectId: string; catalog: ProjectCatalog }) {
    this.filePath = projectStoragePath(absoluteDirectoryPath(workspace), 'folders.v2.json')
  }

  init(): Promise<void> {
    return this.#initialization ??= this.#load()
  }

  async #load(): Promise<void> {
    let content: string
    try {
      content = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.#ready = true
      return
    }
    let data: unknown
    try {
      data = JSON.parse(content)
    } catch {
      throw new FolderError('invalid_registry', 'The saved folder registry is invalid.', 500)
    }
    this.#records = parseRecords(data)
    this.#ready = true
  }

  #assertReady(): void {
    if (!this.#ready) throw new Error('FolderRegistry.init() must complete first')
  }

  list(): FolderRecord[] {
    this.#assertReady()
    if (this.scope) return this.scope.catalog.folders(this.scope.projectId)
    return this.#records.map((record) => ({ ...record }))
  }

  get(id: string): FolderRecord | undefined {
    this.#assertReady()
    if (this.scope) return this.list().find(record => record.id === id)
    const record = this.#records.find((record) => record.id === id)
    return record ? { ...record } : undefined
  }

  async register(path: string, signal?: AbortSignal): Promise<FolderRecord> {
    this.#assertReady()
    if (this.scope) return this.scope.catalog.registerFolder(this.scope.projectId, path, signal)
    const pending = this.#writes.then(async () => {
      signal?.throwIfAborted()
      const canonical = await existingDirectory(path)
      signal?.throwIfAborted()
      const existing = this.#records.find((record) => pathKey(record.path) === pathKey(canonical))
      if (existing) return { ...existing }
      const folder: FolderRecord = {
        id: randomUUID(),
        name: basename(canonical) || canonical,
        path: canonical,
        createdAt: new Date().toISOString(),
      }

      const next = [...this.#records, folder]
      await this.#persist(next, signal)
      this.#records = next
      return { ...folder }
    })
    this.#writes = pending.catch(() => {})
    return pending
  }

  reserveDestination(path: string): Promise<() => void> {
    return this.scope ? this.scope.catalog.reserveDestination(this.scope.projectId, path) : Promise.resolve(() => {})
  }

  configureRemote(ownership: RemoteFolderOwnership): void {
    this.#remoteOwnership = ownership
  }

  acquireAccess(): () => void {
    return this.scope?.catalog.acquireFolderAccess(this.scope.projectId) ?? (() => {})
  }

  async changeProject(id: string, targetProjectId?: string, signal = new AbortController().signal): Promise<FolderRecord | undefined> {
    this.#assertReady()
    if (!this.scope) throw new FolderError('projects_unavailable', 'Project folder ownership is not configured.', 503)
    const folder = this.get(id)
    if (!folder) throw new FolderError('folder_not_found', 'Folder not found.', 404)
    if (folder.kind === 'remote' || targetProjectId !== undefined) await this.requireAvailable(id, signal)
    return this.scope.catalog.changeFolderProject(this.scope.projectId, id, targetProjectId, signal)
  }

  assertSessionFolder(state: { sessionId?: string; folderId?: string; workdir?: WorkdirRefV1 }): void {
    if (!this.scope) return
    if (state.workdir && isManagedWorkdir(state.workdir.capabilityId) &&
      (state.folderId || state.workdir.nodeId === 'local' || !ownsManagedWorkdir(this.scope.projectId, state.workdir.capabilityId))) {
      throw new FolderError('folder_access_revoked', 'This managed session workdir does not belong to this project.', 409)
    }
    if (state.sessionId && this.scope.catalog.isRetiredSession(this.scope.projectId, state.sessionId) ||
      (state.folderId ? !this.get(state.folderId) : state.workdir &&
        this.scope.catalog.isRetiredWorkdir(this.scope.projectId, state.workdir))) {
      throw new FolderError('folder_access_revoked', 'This conversation’s folder was removed or moved to another project. Its history is preserved; open a new conversation from the current folder owner.', 409)
    }
  }

  isRetiredWorkdir(ref: WorkdirRefV1): boolean {
    return this.scope?.catalog.isRetiredWorkdir(this.scope.projectId, ref) ?? false
  }

  registerRemote(ref: WorkdirRefV1, signal: AbortSignal): Promise<RemoteFolderRecord> {
    this.#assertReady()
    if (isManagedWorkdir(ref.capabilityId)) throw new FolderError('managed_workdir_not_folder', 'Managed session workdirs cannot be registered as project folders.')
    if (!this.#remoteOwnership) throw new FolderError('remote_folders_unavailable', 'Remote folder ownership is not configured.', 503)
    return this.#remoteOwnership.register(ref, signal)
  }

  ownsRemoteWorkdir(ref: WorkdirRefV1): boolean {
    return this.list().some(folder => folder.kind === 'remote' && folder.workdir.nodeId === ref.nodeId &&
      folder.workdir.capabilityId === ref.capabilityId)
  }

  async #persist(records: FolderRecord[], signal?: AbortSignal): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const temporary = `${this.filePath}.${randomUUID()}.tmp`
    let created = false
    try {
      signal?.throwIfAborted()
      const file = await open(temporary, 'wx', 0o600)
      created = true
      try {
        await file.writeFile(`${JSON.stringify({ version: 2, folders: records }, null, 2)}\n`, {
          encoding: 'utf8',
          signal,
        })
        await file.sync()
      } finally {
        await file.close()
      }
      signal?.throwIfAborted()
      // Rename is the commit point; a later abort must not report an uncommitted record.
      await rename(temporary, this.filePath)
      created = false
    } finally {
      if (created) await unlink(temporary)
    }
  }

  async requireAvailable(id: string, signal: AbortSignal = new AbortController().signal): Promise<FolderRecord> {
    const folder = this.get(id)
    if (!folder) throw new FolderError('folder_not_found', 'Folder not found.', 404)
    if (folder.kind === 'remote') {
      if (!this.#remoteOwnership) throw new FolderError('remote_folders_unavailable', 'Remote folder ownership is not configured.', 503)
      return this.#remoteOwnership.requireAvailable(folder, signal)
    }
    const canonical = await existingDirectory(folder.path)
    if (pathKey(canonical) !== pathKey(folder.path)) {
      throw new FolderError('folder_unavailable', 'The registered folder changed. Open the folder again.', 409)
    }
    return folder
  }

  lookupWorkdir(ref: WorkdirRefV1): WorkdirCapabilityState | undefined {
    if (ref.version !== 1 || ref.nodeId !== 'local' || !ref.capabilityId.startsWith(FOLDER_PREFIX)) {
      return undefined
    }
    const folder = this.get(ref.capabilityId.slice(FOLDER_PREFIX.length))
    if (!folder || folder.kind === 'remote') return { node: 'online' }
    let online = false
    try {
      online = statSync(folder.path).isDirectory() &&
        pathKey(realpathSync(folder.path)) === pathKey(folder.path)
    } catch {
      // Missing or inaccessible folders remain registered, but are never recreated.
    }
    const capability = { kind: 'workdir', online, ...(online ? { path: folder.path } : {}) }
    return { node: 'online', capability }
  }
}
