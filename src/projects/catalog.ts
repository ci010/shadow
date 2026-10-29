import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { appDataPaths } from '../utils/data-paths.ts'
import { writePrivateFile } from '../config/store.ts'
import type { FolderRecord, RemoteFolderRecord } from '../folders/contracts.ts'
import { parseWorkdirIdentity, workdirIdentitiesOverlap, type WorkdirIdentityV1 } from '../execution/workdir-identity.ts'
import { isClusterIdentifier } from '../cluster/contracts.ts'
import { parseWorkdirRefV1, type WorkdirRefV1 } from '../sessions/locality.ts'
import { existingDirectory, folderDescription, FolderError } from '../folders/registry.ts'
import { DEFAULT_PROJECT_ID, projectPaths, type ProjectRecord } from './contracts.ts'
import { isManagedWorkdir } from '../execution/managed-workdir.ts'

function onlyFields(value: object, fields: readonly string[]): boolean {
  return !Array.isArray(value) && Object.keys(value).every(key => fields.includes(key))
}

const folderFields = ['id', 'projectId', 'name', 'path', 'description', 'createdAt', 'kind', 'workdir', 'identity']
const claimFields = ['projectId', 'workdir', 'identity']

interface CatalogData {
  version: 2
  projects: ProjectRecord[]
  folders: Array<FolderRecord & { projectId: string }>
  remoteClaims?: RemoteOwnershipClaim[]
  retiredFolders?: Array<FolderRecord & { projectId: string }>
  retiredRemoteClaims?: RemoteOwnershipClaim[]
  retiredSessions?: Array<{ projectId: string; sessionId: string }>
  pendingRemoteJobs?: Array<{ projectId: string; jobId: string }>
  deletingProjects?: string[]
}

interface FolderLifecycle {
  assertIdle: () => void
  invalidate: () => void
  sessionsToRetire?: (folder: FolderRecord, claims: RemoteOwnershipClaim[]) => string[]
}

export interface RemoteOwnershipClaim {
  projectId: string
  workdir: WorkdirRefV1
  identity?: WorkdirIdentityV1
}

function remoteRef(value: unknown): WorkdirRefV1 {
  const ref = parseWorkdirRefV1(value)
  if (!ref || ref.nodeId === 'local' || !isClusterIdentifier(ref.nodeId) || !isClusterIdentifier(ref.capabilityId)) {
    throw new Error('Invalid remote folder reference')
  }
  if (isManagedWorkdir(ref.capabilityId)) {
    throw new FolderError('managed_workdir_not_folder', 'Managed session workdirs cannot be registered as project folders.')
  }
  return ref
}

function name(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 120 || /[\x00-\x1f]/.test(value)) {
    throw new FolderError('invalid_name', 'Provide a project name between 1 and 120 characters.')
  }
  return value.trim()
}

function overlaps(a: string, b: string): boolean {
  const key = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path
  const contains = (parent: string, child: string) => {
    const path = relative(key(parent), key(child))
    return !path || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))
  }
  return contains(a, b) || contains(b, a)
}

async function canonicalFutureDirectory(value: string): Promise<string> {
  let path = resolve(value)
  const missing: string[] = []
  for (;;) {
    try {
      await lstat(path)
    } catch (error) {
      const parent = dirname(path)
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === path) throw error
      missing.unshift(basename(path))
      path = parent
      continue
    }
    return join(await existingDirectory(path), ...missing)
  }
}

/** Host-owned index; project services only receive a filtered folder view. */
export class ProjectCatalog {
  readonly hostHome: string
  readonly filePath: string
  #data?: CatalogData
  #writes: Promise<unknown> = Promise.resolve()
  #reservations = new Map<string, { projectId: string; path: string }>()
  #access = new Map<string, number>()
  #lifecycle = new Map<string, FolderLifecycle>()
  #observers = new Set<() => void>()
  #unverifiedSessionProjects = new Set<string>()

  constructor(hostHome: string, private readonly reservedHomes: readonly string[] = []) {
    this.hostHome = resolve(hostHome)
    this.filePath = appDataPaths(this.hostHome).catalog
  }

  async init(): Promise<void> {
    await mkdir(this.hostHome, { recursive: true })
    try {
      const data: unknown = JSON.parse(await readFile(this.filePath, 'utf8'))
      if (!data || typeof data !== 'object' || !('version' in data) || data.version !== 2 ||
        !onlyFields(data, ['version', 'projects', 'folders', 'remoteClaims', 'retiredFolders', 'retiredRemoteClaims', 'retiredSessions', 'pendingRemoteJobs', 'deletingProjects']) ||
        !('projects' in data) || !Array.isArray(data.projects) ||
        !('folders' in data) || !Array.isArray(data.folders)) throw new Error('Invalid project catalog')
      const ids = new Set<string>()
      for (const record of data.projects) {
        if (!record || !onlyFields(record, ['id', 'name', 'createdAt']) || typeof record.id !== 'string' || ids.has(record.id) ||
          name(record.name) !== record.name || typeof record.createdAt !== 'string' ||
          !Number.isFinite(Date.parse(record.createdAt))) throw new Error('Invalid project catalog')
        projectPaths(this.hostHome, record.id)
        ids.add(record.id)
      }
      if (!ids.has(DEFAULT_PROJECT_ID)) throw new Error('Default project is missing')
      const folderIds = new Set<string>()
      for (const folder of data.folders) {
        if (!folder || !onlyFields(folder, folderFields) || !ids.has(folder.projectId) || typeof folder.id !== 'string' ||
          folderIds.has(folder.id) || typeof folder.path !== 'string' ||
          (folder.kind !== 'remote' && (!isAbsolute(folder.path) || (folder.kind !== undefined && folder.kind !== 'local'))) ||
          (folder.description !== undefined && typeof folder.description !== 'string') ||
          typeof folder.name !== 'string' || typeof folder.createdAt !== 'string') throw new Error('Invalid project folders')
        if (folder.kind === 'remote') {
          remoteRef(folder.workdir)
          parseWorkdirIdentity(folder.identity)
        }
        folderIds.add(folder.id)
      }
      if ('remoteClaims' in data) {
        if (!Array.isArray(data.remoteClaims)) throw new Error('Invalid remote ownership claims')
        for (const claim of data.remoteClaims) {
          if (!claim || !onlyFields(claim, claimFields) || !ids.has(claim.projectId)) throw new Error('Invalid remote ownership claim')
          remoteRef(claim.workdir)
          if (claim.identity !== undefined) parseWorkdirIdentity(claim.identity)
        }
      }
      for (const key of ['retiredFolders', 'retiredRemoteClaims'] as const) {
        if (!(key in data)) continue
        const records = (data as unknown as Record<string, unknown>)[key]
        if (!Array.isArray(records)) throw new Error('Invalid folder retirements')
        for (const record of records) {
          if (!record || !onlyFields(record, key === 'retiredFolders' ? folderFields : claimFields) || !ids.has(record.projectId)) throw new Error('Invalid folder retirement')
          if (key === 'retiredRemoteClaims') {
            remoteRef(record.workdir)
            if (record.identity !== undefined) parseWorkdirIdentity(record.identity)
          } else {
            if ((record.description !== undefined && typeof record.description !== 'string') ||
              typeof record.id !== 'string' || typeof record.path !== 'string' ||
              (record.kind !== 'remote' && !isAbsolute(record.path))) throw new Error('Invalid retired folder')
            if (record.kind === 'remote') {
              remoteRef(record.workdir)
              parseWorkdirIdentity(record.identity)
            }
            if (folderIds.has(record.id)) throw new Error('A retired folder cannot be active')
          }
        }
      }
      if ('retiredSessions' in data && (!Array.isArray(data.retiredSessions) ||
        data.retiredSessions.some(record => !record || !onlyFields(record, ['projectId', 'sessionId']) || !ids.has(record.projectId) ||
          typeof record.sessionId !== 'string' || !record.sessionId))) throw new Error('Invalid retired sessions')
      if ('pendingRemoteJobs' in data && (!Array.isArray(data.pendingRemoteJobs) ||
        data.pendingRemoteJobs.some(record => !record || !onlyFields(record, ['projectId', 'jobId']) || !ids.has(record.projectId) ||
          typeof record.jobId !== 'string' || !record.jobId))) throw new Error('Invalid pending remote jobs')
      if ('deletingProjects' in data && (!Array.isArray(data.deletingProjects) ||
        data.deletingProjects.some(id => typeof id !== 'string' || !ids.has(id) || id === DEFAULT_PROJECT_ID) ||
        new Set(data.deletingProjects).size !== data.deletingProjects.length)) throw new Error('Invalid project deletions')
      this.#data = data as CatalogData
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const data: CatalogData = {
        version: 2, projects: [{ id: DEFAULT_PROJECT_ID, name: 'Default', createdAt: new Date().toISOString() }], folders: [],
      }
      this.#commit(data)
    }
  }

  #current(): CatalogData {
    if (!this.#data) throw new Error('ProjectCatalog.init() must complete first')
    return this.#data
  }

  #commit(data: CatalogData): void {
    const projectsChanged = this.#data?.projects !== data.projects
    writePrivateFile(this.filePath, JSON.stringify(data, null, 2) + '\n')
    this.#data = data
    if (projectsChanged) for (const observer of this.#observers) observer()
  }

  observeProjects(observer: () => void): () => void {
    this.#observers.add(observer)
    return () => { this.#observers.delete(observer) }
  }

  #transaction<T>(operation: () => T | Promise<T>): Promise<T> {
    const pending = this.#writes.then(operation)
    this.#writes = pending.catch(() => {})
    return pending
  }

  list(): ProjectRecord[] {
    return this.#current().projects.map(record => ({ ...record }))
  }

  get(id: string): ProjectRecord | undefined {
    return this.list().find(record => record.id === id)
  }

  isDeleting(id: string): boolean {
    return this.#current().deletingProjects?.includes(id) ?? false
  }

  remove(id: string, stop: () => Promise<void> = async () => {}): Promise<void> {
    return this.#transaction(async () => {
      if (!this.get(id)) throw new FolderError('project_not_found', 'Project not found.', 404)
      if (id === DEFAULT_PROJECT_ID) throw new FolderError('default_project_required', 'The Default project is required and cannot be deleted.', 409)
      if (this.#access.get(id) || [...this.#reservations.values()].some(item => item.projectId === id)) {
        throw new FolderError('project_busy', 'Wait for project requests and clones to finish, then retry.', 409)
      }
      if (this.#current().pendingRemoteJobs?.some(job => job.projectId === id)) {
        throw new FolderError('project_busy', 'A remote job has no confirmed terminal receipt. Reconcile its execution and cleanup before deleting this project.', 409)
      }
      if (!this.isDeleting(id)) this.#lifecycle.get(id)?.assertIdle()
      const root = projectPaths(this.hostHome, id).root
      for (const path of [dirname(root), root]) {
        try {
          if ((await lstat(path)).isSymbolicLink()) {
            throw new FolderError('project_home_linked', 'Project storage is linked to another directory. Restore its original location before deleting it.', 409)
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
      if (this.#access.get(id) || [...this.#reservations.values()].some(item => item.projectId === id) ||
        this.#current().pendingRemoteJobs?.some(job => job.projectId === id)) {
        throw new FolderError('project_busy', 'Project work started while checking storage. Stop it before retrying.', 409)
      }
      if (!this.isDeleting(id)) this.#lifecycle.get(id)?.assertIdle()
      // Persist admission revocation before shutdown or disk cleanup; a restart
      // must finish deletion, never start a runtime over partially deleted data.
      if (!this.isDeleting(id)) {
        this.#commit({ ...this.#current(), deletingProjects: [...(this.#current().deletingProjects ?? []), id] })
      }
      await stop()
      await rm(root, { recursive: true, force: true })
      const current = this.#current()
      this.#commit({
        ...current, projects: current.projects.filter(project => project.id !== id),
        folders: current.folders.filter(folder => folder.projectId !== id),
        remoteClaims: current.remoteClaims?.filter(claim => claim.projectId !== id),
        retiredFolders: current.retiredFolders?.filter(folder => folder.projectId !== id),
        retiredRemoteClaims: current.retiredRemoteClaims?.filter(claim => claim.projectId !== id),
        retiredSessions: current.retiredSessions?.filter(session => session.projectId !== id),
        pendingRemoteJobs: current.pendingRemoteJobs?.filter(job => job.projectId !== id),
        deletingProjects: current.deletingProjects?.filter(projectId => projectId !== id),
      })
      this.#lifecycle.delete(id)
      this.#access.delete(id)
      this.#unverifiedSessionProjects.delete(id)
    })
  }

  create(value: unknown): Promise<ProjectRecord> {
    const displayName = name(value)
    return this.#transaction(() => {
      const record = { id: randomUUID(), name: displayName, createdAt: new Date().toISOString() }
      this.#commit({ ...this.#current(), projects: [...this.list(), record] })
      return { ...record }
    })
  }

  rename(id: string, value: unknown): Promise<ProjectRecord> {
    const displayName = name(value)
    return this.#transaction(() => {
      const record = this.get(id)
      if (!record) throw new FolderError('project_not_found', 'Project not found.', 404)
      if (this.isDeleting(id)) throw new FolderError('project_deleting', 'Project deletion is pending. Retry deleting it.', 409)
      record.name = displayName
      this.#commit({ ...this.#current(), projects: this.list().map(item => item.id === id ? record : item) })
      return { ...record }
    })
  }

  folders(projectId?: string): FolderRecord[] {
    return this.#current().folders.filter(record => !projectId || record.projectId === projectId).map(record => structuredClone(record))
  }

  configureFolderLifecycle(projectId: string, lifecycle: FolderLifecycle): () => void {
    this.#lifecycle.set(projectId, lifecycle)
    return () => { if (this.#lifecycle.get(projectId) === lifecycle) this.#lifecycle.delete(projectId) }
  }

  isRetiredSession(projectId: string, sessionId: string): boolean {
    return (this.#current().retiredSessions ?? []).some(record => record.projectId === projectId && record.sessionId === sessionId)
  }

  recordRemoteJob(projectId: string, jobId: string, pending: boolean): void {
    const jobs = (this.#current().pendingRemoteJobs ?? []).filter(job => job.projectId !== projectId || job.jobId !== jobId)
    if (pending) jobs.push({ projectId, jobId })
    this.#commit({ ...this.#current(), pendingRemoteJobs: jobs })
  }

  acquireFolderAccess(projectId: string): () => void {
    if (!this.get(projectId) || this.isDeleting(projectId)) throw new FolderError('project_unavailable', 'Project is unavailable.', 409)
    this.#access.set(projectId, (this.#access.get(projectId) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      this.#access.set(projectId, (this.#access.get(projectId) ?? 1) - 1)
    }
  }

  isRetiredWorkdir(projectId: string, ref: WorkdirRefV1): boolean {
    return (this.#current().retiredFolders ?? []).some(folder => folder.projectId === projectId &&
      (folder.kind === 'remote'
        ? folder.workdir.nodeId === ref.nodeId && folder.workdir.capabilityId === ref.capabilityId
        : ref.nodeId === 'local' && ref.capabilityId === `local-project-v1:${folder.id}`)) ||
      (this.#current().retiredRemoteClaims ?? []).some(claim => claim.projectId === projectId &&
        claim.workdir.nodeId === ref.nodeId && claim.workdir.capabilityId === ref.capabilityId)
  }

  changeFolderProject(projectId: string, id: string, targetProjectId?: string, signal?: AbortSignal): Promise<FolderRecord | undefined> {
    return this.#transaction(async () => {
      signal?.throwIfAborted()
      const current = this.#current()
      if (!this.get(projectId) || targetProjectId !== undefined && !this.get(targetProjectId)) {
        throw new FolderError('project_not_found', 'Project not found.', 404)
      }
      if (this.isDeleting(projectId) || targetProjectId !== undefined && this.isDeleting(targetProjectId)) {
        throw new FolderError('project_deleting', 'Project deletion is pending.', 409)
      }
      if (targetProjectId === projectId) {
        throw new FolderError('same_project', 'Choose a different project.', 409)
      }
      const folder = current.folders.find(item => item.id === id && item.projectId === projectId)
      if (!folder) throw new FolderError('folder_not_found', 'Folder not found.', 404)
      const relatedClaims: RemoteOwnershipClaim[] = []
      let conflict: boolean
      if (folder.kind === 'remote') {
        this.#assertSessionOwnershipAvailable()
        const claims = this.remoteClaims(folder.workdir.nodeId)
        if (claims.some(claim => !claim.identity)) {
          throw new FolderError('remote_claim_identity_unavailable', 'Reconnect and verify the original remote folder capabilities before changing ownership.', 409)
        }
        relatedClaims.push(...claims.filter(claim => workdirIdentitiesOverlap(claim.identity!, folder.identity)))
        conflict = relatedClaims.some(claim => claim.projectId !== projectId) ||
          current.folders.some(item => item.id !== id && item.kind === 'remote' &&
            item.workdir.nodeId === folder.workdir.nodeId && workdirIdentitiesOverlap(item.identity, folder.identity))
      } else {
        const canonical = await canonicalFutureDirectory(folder.path)
        const homes = await Promise.all([this.hostHome, ...this.reservedHomes].map(canonicalFutureDirectory))
        if (homes.some(home => overlaps(home, canonical))) {
          throw new FolderError('folder_overlaps_home', 'Project Home and host data cannot be removed or moved as a registered folder.', 409)
        }
        conflict = current.folders.some(item => item.id !== id && item.kind !== 'remote' &&
          (overlaps(item.path, folder.path) || overlaps(item.path, canonical)))
        if ([...this.#reservations.values()].some(item => overlaps(item.path, canonical))) {
          throw new FolderError('folder_busy', 'A clone is using this folder. Wait for it to finish or cancel it.', 409)
        }
      }
      // Removing a registration cannot introduce cross-project ownership overlap.
      // Keep the overlap guard for moves, but allow nested registrations to be removed.
      if (targetProjectId !== undefined && conflict) throw new FolderError('folder_overlap_conflict', 'Another registered folder overlaps this folder. Remove the overlapping registration before changing ownership.', 409)
      // All activity checks and the durable rename share one synchronous commit point.
      // No new admission can interleave between these checks and revocation.
      if (this.#access.get(projectId)) throw new FolderError('folder_busy', 'Wait for active project requests and work to finish, then retry.', 409)
      if (this.#current().pendingRemoteJobs?.some(job => job.projectId === projectId)) {
        throw new FolderError('folder_busy', 'A remote job has no confirmed terminal receipt. Folder ownership cannot change while its execution or cleanup is uncertain.', 409)
      }
      this.#lifecycle.get(projectId)?.assertIdle()
      const retiredSessions = this.#lifecycle.get(projectId)?.sessionsToRetire?.(folder, relatedClaims) ?? []
      signal?.throwIfAborted()
      const moved = targetProjectId ? {
        ...structuredClone(folder), id: randomUUID(), projectId: targetProjectId, createdAt: new Date().toISOString(),
      } : undefined
      this.#commit({
        ...this.#current(),
        folders: [...current.folders.filter(item => item.id !== id), ...(moved ? [moved] : [])],
        retiredFolders: [...(current.retiredFolders ?? []), folder],
        remoteClaims: (current.remoteClaims ?? []).filter(claim => !relatedClaims.some(item =>
          item.workdir.nodeId === claim.workdir.nodeId && item.workdir.capabilityId === claim.workdir.capabilityId)),
        retiredRemoteClaims: [...(current.retiredRemoteClaims ?? []), ...relatedClaims],
        retiredSessions: [...(current.retiredSessions ?? []),
          ...retiredSessions.filter(sessionId => !this.isRetiredSession(projectId, sessionId)).map(sessionId => ({ projectId, sessionId }))],
      })
      this.#lifecycle.get(projectId)?.invalidate()
      return moved ? structuredClone(moved) : undefined
    })
  }

  async #assertOwnership(projectId: string, path: string): Promise<void> {
    if (!this.get(projectId)) throw new FolderError('project_not_found', 'Project not found.', 404)
    if (this.isDeleting(projectId)) throw new FolderError('project_deleting', 'Project deletion is pending.', 409)
    if ([...this.#current().folders.filter(folder => folder.kind !== 'remote'), ...this.#reservations.values()].some(folder => folder.projectId !== projectId && overlaps(folder.path, path))) {
      throw new FolderError('folder_owned_by_another_project', 'This folder overlaps a folder belonging to another project.', 409)
    }
    const homes = [this.hostHome, ...this.reservedHomes]
    const canonicalHomes = await Promise.all(homes.map(canonicalFutureDirectory))
    if ([...homes, ...canonicalHomes].some(home => overlaps(home, path))) {
      throw new FolderError('folder_overlaps_home', 'Project Home and host data cannot be registered as a folder.', 409)
    }
  }

  reserveDestination(projectId: string, path: string): Promise<() => void> {
    return this.#transaction(async () => {
      const canonical = await canonicalFutureDirectory(path)
      await this.#assertOwnership(projectId, canonical)
      const id = randomUUID()
      this.#reservations.set(id, { projectId, path: canonical })
      return () => { this.#reservations.delete(id) }
    })
  }

  registerFolder(projectId: string, path: string, signal?: AbortSignal, description?: string): Promise<FolderRecord> {
    return this.#transaction(async () => {
      signal?.throwIfAborted()
      description = folderDescription(description)
      const canonical = await existingDirectory(path)
      await this.#assertOwnership(projectId, canonical)
      const existing = this.folders(projectId).find(folder => folder.kind !== 'remote' && overlaps(folder.path, canonical) &&
        relative(folder.path, canonical) === '')
      if (existing) return existing
      const folder = { projectId, id: randomUUID(), name: basename(canonical) || canonical, path: canonical, ...(description !== undefined ? { description } : {}), createdAt: new Date().toISOString() }
      signal?.throwIfAborted()
      this.#commit({ ...this.#current(), folders: [...this.#current().folders, folder] })
      return { ...folder }
    })
  }

  remoteClaims(nodeId?: string): RemoteOwnershipClaim[] {
    return structuredClone((this.#current().remoteClaims ?? []).filter(claim => !nodeId || claim.workdir.nodeId === nodeId))
  }

  /** Rebuilt at startup; incomplete session scans cannot release unseen remote reservations. */
  setSessionOwnershipAvailable(projectId: string, available: boolean): void {
    if (available) this.#unverifiedSessionProjects.delete(projectId)
    else this.#unverifiedSessionProjects.add(projectId)
  }

  #assertSessionOwnershipAvailable(): void {
    if (this.#unverifiedSessionProjects.size) {
      throw new FolderError('session_ownership_unavailable',
        'Project session storage could not be verified. Repair it and retry the project before changing remote folder ownership.', 409)
    }
  }

  reserveRemoteWorkdirs(projectId: string, refs: readonly WorkdirRefV1[]): Promise<void> {
    return this.#transaction(() => {
      if (!this.get(projectId)) throw new FolderError('project_not_found', 'Project not found.', 404)
      if (this.isDeleting(projectId)) throw new FolderError('project_deleting', 'Project deletion is pending.', 409)
      const claims = this.remoteClaims()
      for (const value of refs) {
        const workdir = remoteRef(value)
        if (this.isRetiredWorkdir(projectId, workdir)) continue
        const existing = claims.find(claim => claim.workdir.nodeId === workdir.nodeId && claim.workdir.capabilityId === workdir.capabilityId)
        if (existing) {
          if (existing.projectId !== projectId) throw new Error('Remote workdir already belongs to another project')
          continue
        }
        claims.push({ projectId, workdir })
      }
      this.#commit({ ...this.#current(), remoteClaims: claims })
    })
  }

  resolveRemoteClaim(ref: WorkdirRefV1, identity: WorkdirIdentityV1): Promise<void> {
    return this.#transaction(() => {
      const parsed = parseWorkdirIdentity(identity)
      const claims = this.remoteClaims()
      const claim = claims.find(item => item.workdir.nodeId === ref.nodeId && item.workdir.capabilityId === ref.capabilityId)
      if (!claim) throw new Error('Remote ownership claim is missing')
      if (claim.identity && claim.identity.rootId !== parsed.rootId) {
        throw new FolderError('remote_claim_workdir_changed', 'An existing conversation reserves a different folder for this capability. Restore its original folder before opening new folders on this device.', 409)
      }
      this.#assertRemoteOwnership(claim.projectId, ref.nodeId, parsed, true)
      claim.identity = parsed
      this.#commit({ ...this.#current(), remoteClaims: claims })
    })
  }

  refreshRemoteFolderIdentity(id: string, identity: WorkdirIdentityV1): Promise<void> {
    return this.#transaction(() => {
      const folder = this.#current().folders.find(folder => folder.id === id)
      if (!folder || folder.kind !== 'remote') throw new FolderError('folder_not_found', 'Folder not found.', 404)
      const verified = parseWorkdirIdentity(identity)
      if (verified.rootId !== folder.identity.rootId) {
        throw new FolderError('remote_workdir_changed', 'A registered folder capability changed its target. Restore the original capability before opening new folders on this device.', 409)
      }
      this.#assertRemoteOwnership(folder.projectId, folder.workdir.nodeId, verified)
      this.#commit({ ...this.#current(), folders: this.#current().folders.map(item => item.id === id ? { ...folder, identity: verified } : item) })
    })
  }

  #assertRemoteOwnership(projectId: string, nodeId: string, identity: WorkdirIdentityV1, resolvingClaim = false): void {
    this.#assertSessionOwnershipAvailable()
    if (!this.get(projectId)) throw new FolderError('project_not_found', 'Project not found.', 404)
    if (this.isDeleting(projectId)) throw new FolderError('project_deleting', 'Project deletion is pending.', 409)
    const claims = this.remoteClaims(nodeId)
    if (!resolvingClaim && claims.some(claim => !claim.identity)) {
      throw new FolderError('remote_claim_identity_unavailable', 'An existing conversation still reserves a folder on this device. Reconnect and verify its original folder capability before opening another folder.', 409)
    }
    if (claims.some(claim => claim.projectId !== projectId && claim.identity && workdirIdentitiesOverlap(claim.identity, identity)) ||
      this.#current().folders.some(folder => folder.kind === 'remote' && folder.projectId !== projectId &&
        folder.workdir.nodeId === nodeId && workdirIdentitiesOverlap(folder.identity, identity))) {
      throw new FolderError('folder_owned_by_another_project', 'This remote folder overlaps a folder belonging to another project.', 409)
    }
  }

  registerRemoteFolder(projectId: string, value: WorkdirRefV1, identity: WorkdirIdentityV1, signal?: AbortSignal): Promise<RemoteFolderRecord> {
    return this.#transaction(() => {
      signal?.throwIfAborted()
      const workdir = remoteRef(value)
      const verified = parseWorkdirIdentity(identity)
      this.#assertRemoteOwnership(projectId, workdir.nodeId, verified)
      const existing = this.folders(projectId).find((folder): folder is RemoteFolderRecord =>
        folder.kind === 'remote' && folder.workdir.nodeId === workdir.nodeId && folder.identity.rootId === verified.rootId)
      if (existing) {
        const updated = { ...existing, workdir, identity: verified, path: workdir.displayPathSnapshot ?? existing.path }
        this.#commit({ ...this.#current(), folders: this.#current().folders.map(folder =>
          folder.id === existing.id ? { ...updated, projectId } : folder) })
        return structuredClone(updated)
      }
      const folder: RemoteFolderRecord & { projectId: string } = {
        kind: 'remote', projectId, id: randomUUID(), name: workdir.displayName || workdir.capabilityId,
        path: workdir.displayPathSnapshot ?? '', workdir, identity: verified, createdAt: new Date().toISOString(),
      }
      this.#commit({ ...this.#current(), folders: [...this.#current().folders, folder] })
      return structuredClone(folder)
    })
  }
}
