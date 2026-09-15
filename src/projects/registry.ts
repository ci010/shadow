import { randomUUID } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises'
import { basename, isAbsolute, join, normalize, parse } from 'node:path'
import type { WorkdirCapabilityState, WorkdirRefV1 } from '../sessions/locality.ts'
import type { ProjectRecord } from './contracts.ts'
import type { OrganizationCatalog } from '../organizations/catalog.ts'
import type { RemoteProjectOwnership } from './remote-ownership.ts'
import type { RemoteProjectRecord } from './contracts.ts'

const PROJECT_PREFIX = 'local-project-v1:'
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export class ProjectError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 404 | 409 | 500 | 503 = 400,
  ) {
    super(message)
    this.name = 'ProjectError'
  }
}

export function absoluteDirectoryPath(value: unknown): string {
  if (
    typeof value !== 'string' || !value || value.length > 10_000 ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    !isAbsolute(value) ||
    (process.platform === 'win32' && parse(normalize(value)).root === '\\')
  ) {
    throw new ProjectError('invalid_path', 'Choose an absolute folder path.')
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
    throw new ProjectError(
      'folder_unavailable',
      'The folder is unavailable. Restore it or open an existing folder.',
      409,
    )
  }
}

function parseRecords(value: unknown): ProjectRecord[] {
  const invalid = () => new ProjectError(
    'invalid_registry',
    'The saved project registry is invalid. Restore the registry before continuing.',
    500,
  )
  if (
    !value || typeof value !== 'object' ||
    !('version' in value) || value.version !== 1 ||
    !('projects' in value) || !Array.isArray(value.projects)
  ) throw invalid()
  const ids = new Set<string>()
  const paths = new Set<string>()
  return value.projects.map((record: unknown) => {
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

export class ProjectRegistry {
  readonly filePath: string
  #records: ProjectRecord[] = []
  #initialization?: Promise<void>
  #ready = false
  #writes: Promise<unknown> = Promise.resolve()
  #remoteOwnership?: RemoteProjectOwnership

  constructor(workspace: string, private readonly scope?: { organizationId: string; catalog: OrganizationCatalog }) {
    this.filePath = join(absoluteDirectoryPath(workspace), 'projects.v1.json')
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
      throw new ProjectError('invalid_registry', 'The saved project registry is invalid.', 500)
    }
    this.#records = parseRecords(data)
    this.#ready = true
  }

  #assertReady(): void {
    if (!this.#ready) throw new Error('ProjectRegistry.init() must complete first')
  }

  list(): ProjectRecord[] {
    this.#assertReady()
    if (this.scope) return this.scope.catalog.projects(this.scope.organizationId)
    return this.#records.map((record) => ({ ...record }))
  }

  get(id: string): ProjectRecord | undefined {
    this.#assertReady()
    if (this.scope) return this.list().find(record => record.id === id)
    const record = this.#records.find((record) => record.id === id)
    return record ? { ...record } : undefined
  }

  async register(path: string, signal?: AbortSignal): Promise<ProjectRecord> {
    this.#assertReady()
    if (this.scope) return this.scope.catalog.registerProject(this.scope.organizationId, path, signal)
    const pending = this.#writes.then(async () => {
      signal?.throwIfAborted()
      const canonical = await existingDirectory(path)
      signal?.throwIfAborted()
      const existing = this.#records.find((record) => pathKey(record.path) === pathKey(canonical))
      if (existing) return { ...existing }
      const project: ProjectRecord = {
        id: randomUUID(),
        name: basename(canonical) || canonical,
        path: canonical,
        createdAt: new Date().toISOString(),
      }

      const next = [...this.#records, project]
      await this.#persist(next, signal)
      this.#records = next
      return { ...project }
    })
    this.#writes = pending.catch(() => {})
    return pending
  }

  reserveDestination(path: string): Promise<() => void> {
    return this.scope ? this.scope.catalog.reserveDestination(this.scope.organizationId, path) : Promise.resolve(() => {})
  }

  configureRemote(ownership: RemoteProjectOwnership): void {
    this.#remoteOwnership = ownership
  }

  acquireAccess(): () => void {
    return this.scope?.catalog.acquireProjectAccess(this.scope.organizationId) ?? (() => {})
  }

  async changeOrganization(id: string, targetOrganizationId?: string, signal = new AbortController().signal): Promise<ProjectRecord | undefined> {
    this.#assertReady()
    if (!this.scope) throw new ProjectError('organizations_unavailable', 'Organization project ownership is not configured.', 503)
    const project = this.get(id)
    if (!project) throw new ProjectError('project_not_found', 'Project not found.', 404)
    if (project.kind === 'remote' || targetOrganizationId !== undefined) await this.requireAvailable(id, signal)
    return this.scope.catalog.changeProjectOrganization(this.scope.organizationId, id, targetOrganizationId, signal)
  }

  assertSessionProject(state: { sessionId?: string; projectId?: string; workdir?: WorkdirRefV1 }): void {
    if (!this.scope) return
    if (state.sessionId && this.scope.catalog.isRetiredSession(this.scope.organizationId, state.sessionId) ||
      (state.projectId ? !this.get(state.projectId) : state.workdir &&
        this.scope.catalog.isRetiredWorkdir(this.scope.organizationId, state.workdir))) {
      throw new ProjectError('project_access_revoked', 'This conversation’s folder was removed or moved to another organization. Its history is preserved; open a new conversation from the current folder owner.', 409)
    }
  }

  isRetiredWorkdir(ref: WorkdirRefV1): boolean {
    return this.scope?.catalog.isRetiredWorkdir(this.scope.organizationId, ref) ?? false
  }

  registerRemote(ref: WorkdirRefV1, signal: AbortSignal): Promise<RemoteProjectRecord> {
    this.#assertReady()
    if (!this.#remoteOwnership) throw new ProjectError('remote_projects_unavailable', 'Remote project ownership is not configured.', 503)
    return this.#remoteOwnership.register(ref, signal)
  }

  ownsRemoteWorkdir(ref: WorkdirRefV1): boolean {
    return this.list().some(project => project.kind === 'remote' && project.workdir.nodeId === ref.nodeId &&
      project.workdir.capabilityId === ref.capabilityId)
  }

  async #persist(records: ProjectRecord[], signal?: AbortSignal): Promise<void> {
    const temporary = `${this.filePath}.${randomUUID()}.tmp`
    let created = false
    try {
      signal?.throwIfAborted()
      const file = await open(temporary, 'wx', 0o600)
      created = true
      try {
        await file.writeFile(`${JSON.stringify({ version: 1, projects: records }, null, 2)}\n`, {
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

  async requireAvailable(id: string, signal: AbortSignal = new AbortController().signal): Promise<ProjectRecord> {
    const project = this.get(id)
    if (!project) throw new ProjectError('project_not_found', 'Project not found.', 404)
    if (project.kind === 'remote') {
      if (!this.#remoteOwnership) throw new ProjectError('remote_projects_unavailable', 'Remote project ownership is not configured.', 503)
      return this.#remoteOwnership.requireAvailable(project, signal)
    }
    const canonical = await existingDirectory(project.path)
    if (pathKey(canonical) !== pathKey(project.path)) {
      throw new ProjectError('folder_unavailable', 'The project folder changed. Open the folder again.', 409)
    }
    return project
  }

  lookupWorkdir(ref: WorkdirRefV1): WorkdirCapabilityState | undefined {
    if (ref.version !== 1 || ref.nodeId !== 'local' || !ref.capabilityId.startsWith(PROJECT_PREFIX)) {
      return undefined
    }
    const project = this.get(ref.capabilityId.slice(PROJECT_PREFIX.length))
    if (!project || project.kind === 'remote') return { node: 'online' }
    let online = false
    try {
      online = statSync(project.path).isDirectory() &&
        pathKey(realpathSync(project.path)) === pathKey(project.path)
    } catch {
      // Missing or inaccessible folders remain registered, but are never recreated.
    }
    const capability = { kind: 'workdir', online, ...(online ? { path: project.path } : {}) }
    return { node: 'online', capability }
  }
}
