import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { writePrivateFile } from '../config/store.ts'
import type { ProjectRecord, RemoteProjectRecord } from '../projects/contracts.ts'
import { parseWorkdirIdentity, workdirIdentitiesOverlap, type WorkdirIdentityV1 } from '../execution/workdir-identity.ts'
import { isClusterIdentifier } from '../cluster/contracts.ts'
import { parseWorkdirRefV1, type WorkdirRefV1 } from '../sessions/locality.ts'
import { existingDirectory, ProjectError } from '../projects/registry.ts'
import { DEFAULT_ORGANIZATION_ID, organizationPaths, type OrganizationRecord } from './contracts.ts'

interface CatalogData {
  version: 1
  organizations: OrganizationRecord[]
  projects: Array<ProjectRecord & { organizationId: string }>
  remoteClaims?: RemoteOwnershipClaim[]
  retiredProjects?: Array<ProjectRecord & { organizationId: string }>
  retiredRemoteClaims?: RemoteOwnershipClaim[]
  retiredSessions?: Array<{ organizationId: string; sessionId: string }>
  pendingRemoteJobs?: Array<{ organizationId: string; jobId: string }>
}

interface ProjectLifecycle {
  assertIdle: () => void
  invalidate: () => void
  sessionsToRetire?: (project: ProjectRecord, claims: RemoteOwnershipClaim[]) => string[]
}

export interface RemoteOwnershipClaim {
  organizationId: string
  workdir: WorkdirRefV1
  identity?: WorkdirIdentityV1
}

function remoteRef(value: unknown): WorkdirRefV1 {
  const ref = parseWorkdirRefV1(value)
  if (!ref || ref.nodeId === 'local' || !isClusterIdentifier(ref.nodeId) || !isClusterIdentifier(ref.capabilityId)) {
    throw new Error('Invalid remote project reference')
  }
  return ref
}

function name(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 120 || /[\x00-\x1f]/.test(value)) {
    throw new ProjectError('invalid_name', 'Provide an organization name between 1 and 120 characters.')
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

/** Host-owned index; organization services only receive a filtered project view. */
export class OrganizationCatalog {
  readonly hostHome: string
  readonly filePath: string
  #data?: CatalogData
  #writes: Promise<unknown> = Promise.resolve()
  #reservations = new Map<string, { organizationId: string; path: string }>()
  #access = new Map<string, number>()
  #lifecycle = new Map<string, ProjectLifecycle>()

  constructor(hostHome: string, private readonly reservedHomes: readonly string[] = []) {
    this.hostHome = resolve(hostHome)
    this.filePath = join(this.hostHome, 'organizations.v1.json')
  }

  async init(): Promise<void> {
    await mkdir(this.hostHome, { recursive: true })
    try {
      const data: unknown = JSON.parse(await readFile(this.filePath, 'utf8'))
      if (!data || typeof data !== 'object' || !('version' in data) || data.version !== 1 ||
        !('organizations' in data) || !Array.isArray(data.organizations) ||
        !('projects' in data) || !Array.isArray(data.projects)) throw new Error('Invalid organization catalog')
      const ids = new Set<string>()
      for (const record of data.organizations) {
        if (!record || typeof record.id !== 'string' || ids.has(record.id) ||
          name(record.name) !== record.name || typeof record.createdAt !== 'string' ||
          !Number.isFinite(Date.parse(record.createdAt))) throw new Error('Invalid organization catalog')
        organizationPaths(this.hostHome, record.id)
        ids.add(record.id)
      }
      if (!ids.has(DEFAULT_ORGANIZATION_ID)) throw new Error('Default organization is missing')
      const projectIds = new Set<string>()
      for (const project of data.projects) {
        if (!project || !ids.has(project.organizationId) || typeof project.id !== 'string' ||
          projectIds.has(project.id) || typeof project.path !== 'string' ||
          (project.kind !== 'remote' && (!isAbsolute(project.path) || (project.kind !== undefined && project.kind !== 'local'))) ||
          typeof project.name !== 'string' || typeof project.createdAt !== 'string') throw new Error('Invalid organization projects')
        if (project.kind === 'remote') {
          remoteRef(project.workdir)
          parseWorkdirIdentity(project.identity)
        }
        projectIds.add(project.id)
      }
      if ('remoteClaims' in data) {
        if (!Array.isArray(data.remoteClaims)) throw new Error('Invalid remote ownership claims')
        for (const claim of data.remoteClaims) {
          if (!claim || !ids.has(claim.organizationId)) throw new Error('Invalid remote ownership claim')
          remoteRef(claim.workdir)
          if (claim.identity !== undefined) parseWorkdirIdentity(claim.identity)
        }
      }
      for (const key of ['retiredProjects', 'retiredRemoteClaims'] as const) {
        if (!(key in data)) continue
        const records = (data as unknown as Record<string, unknown>)[key]
        if (!Array.isArray(records)) throw new Error('Invalid project retirements')
        for (const record of records) {
          if (!record || !ids.has(record.organizationId)) throw new Error('Invalid project retirement')
          if (key === 'retiredRemoteClaims') {
            remoteRef(record.workdir)
            if (record.identity !== undefined) parseWorkdirIdentity(record.identity)
          } else {
            if (typeof record.id !== 'string' || typeof record.path !== 'string' ||
              (record.kind !== 'remote' && !isAbsolute(record.path))) throw new Error('Invalid retired project')
            if (record.kind === 'remote') {
              remoteRef(record.workdir)
              parseWorkdirIdentity(record.identity)
            }
            if (projectIds.has(record.id)) throw new Error('A retired project cannot be active')
          }
        }
      }
      if ('retiredSessions' in data && (!Array.isArray(data.retiredSessions) ||
        data.retiredSessions.some(record => !record || !ids.has(record.organizationId) ||
          typeof record.sessionId !== 'string' || !record.sessionId))) throw new Error('Invalid retired sessions')
      if ('pendingRemoteJobs' in data && (!Array.isArray(data.pendingRemoteJobs) ||
        data.pendingRemoteJobs.some(record => !record || !ids.has(record.organizationId) ||
          typeof record.jobId !== 'string' || !record.jobId))) throw new Error('Invalid pending remote jobs')
      this.#data = data as CatalogData
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const data: CatalogData = {
        version: 1, organizations: [{ id: DEFAULT_ORGANIZATION_ID, name: 'Default', createdAt: new Date().toISOString() }], projects: [],
      }
      this.#commit(data)
    }
  }

  #current(): CatalogData {
    if (!this.#data) throw new Error('OrganizationCatalog.init() must complete first')
    return this.#data
  }

  #commit(data: CatalogData): void {
    writePrivateFile(this.filePath, JSON.stringify(data, null, 2) + '\n')
    this.#data = data
  }

  #transaction<T>(operation: () => T | Promise<T>): Promise<T> {
    const pending = this.#writes.then(operation)
    this.#writes = pending.catch(() => {})
    return pending
  }

  list(): OrganizationRecord[] {
    return this.#current().organizations.map(record => ({ ...record }))
  }

  get(id: string): OrganizationRecord | undefined {
    return this.list().find(record => record.id === id)
  }

  create(value: unknown): Promise<OrganizationRecord> {
    const displayName = name(value)
    return this.#transaction(() => {
      const record = { id: randomUUID(), name: displayName, createdAt: new Date().toISOString() }
      this.#commit({ ...this.#current(), organizations: [...this.list(), record] })
      return { ...record }
    })
  }

  rename(id: string, value: unknown): Promise<OrganizationRecord> {
    const displayName = name(value)
    return this.#transaction(() => {
      const record = this.get(id)
      if (!record) throw new ProjectError('organization_not_found', 'Organization not found.', 404)
      record.name = displayName
      this.#commit({ ...this.#current(), organizations: this.list().map(item => item.id === id ? record : item) })
      return { ...record }
    })
  }

  projects(organizationId?: string): ProjectRecord[] {
    return this.#current().projects.filter(record => !organizationId || record.organizationId === organizationId).map(record => structuredClone(record))
  }

  configureProjectLifecycle(organizationId: string, lifecycle: ProjectLifecycle): () => void {
    this.#lifecycle.set(organizationId, lifecycle)
    return () => { if (this.#lifecycle.get(organizationId) === lifecycle) this.#lifecycle.delete(organizationId) }
  }

  isRetiredSession(organizationId: string, sessionId: string): boolean {
    return (this.#current().retiredSessions ?? []).some(record => record.organizationId === organizationId && record.sessionId === sessionId)
  }

  recordRemoteJob(organizationId: string, jobId: string, pending: boolean): void {
    const jobs = (this.#current().pendingRemoteJobs ?? []).filter(job => job.organizationId !== organizationId || job.jobId !== jobId)
    if (pending) jobs.push({ organizationId, jobId })
    this.#commit({ ...this.#current(), pendingRemoteJobs: jobs })
  }

  acquireProjectAccess(organizationId: string): () => void {
    this.#access.set(organizationId, (this.#access.get(organizationId) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      this.#access.set(organizationId, (this.#access.get(organizationId) ?? 1) - 1)
    }
  }

  isRetiredWorkdir(organizationId: string, ref: WorkdirRefV1): boolean {
    return (this.#current().retiredProjects ?? []).some(project => project.organizationId === organizationId &&
      (project.kind === 'remote'
        ? project.workdir.nodeId === ref.nodeId && project.workdir.capabilityId === ref.capabilityId
        : ref.nodeId === 'local' && ref.capabilityId === `local-project-v1:${project.id}`)) ||
      (this.#current().retiredRemoteClaims ?? []).some(claim => claim.organizationId === organizationId &&
        claim.workdir.nodeId === ref.nodeId && claim.workdir.capabilityId === ref.capabilityId)
  }

  changeProjectOrganization(organizationId: string, id: string, targetOrganizationId?: string, signal?: AbortSignal): Promise<ProjectRecord | undefined> {
    return this.#transaction(async () => {
      signal?.throwIfAborted()
      const current = this.#current()
      if (!this.get(organizationId) || targetOrganizationId !== undefined && !this.get(targetOrganizationId)) {
        throw new ProjectError('organization_not_found', 'Organization not found.', 404)
      }
      if (targetOrganizationId === organizationId) {
        throw new ProjectError('same_organization', 'Choose a different organization.', 409)
      }
      const project = current.projects.find(item => item.id === id && item.organizationId === organizationId)
      if (!project) throw new ProjectError('project_not_found', 'Project not found.', 404)
      const relatedClaims: RemoteOwnershipClaim[] = []
      let conflict: boolean
      if (project.kind === 'remote') {
        const claims = this.remoteClaims(project.workdir.nodeId)
        if (claims.some(claim => !claim.identity)) {
          throw new ProjectError('legacy_remote_identity_unavailable', 'Reconnect and verify the original remote folder capabilities before changing ownership.', 409)
        }
        relatedClaims.push(...claims.filter(claim => workdirIdentitiesOverlap(claim.identity!, project.identity)))
        conflict = relatedClaims.some(claim => claim.organizationId !== organizationId) ||
          current.projects.some(item => item.id !== id && item.kind === 'remote' &&
            item.workdir.nodeId === project.workdir.nodeId && workdirIdentitiesOverlap(item.identity, project.identity))
      } else {
        const canonical = await canonicalFutureDirectory(project.path)
        const homes = await Promise.all([this.hostHome, ...this.reservedHomes].map(canonicalFutureDirectory))
        if (homes.some(home => overlaps(home, canonical))) {
          throw new ProjectError('folder_overlaps_home', 'Organization Home and host data cannot be removed or moved as a folder project.', 409)
        }
        conflict = current.projects.some(item => item.id !== id && item.kind !== 'remote' &&
          (overlaps(item.path, project.path) || overlaps(item.path, canonical)))
        if ([...this.#reservations.values()].some(item => overlaps(item.path, canonical))) {
          throw new ProjectError('project_busy', 'A clone is using this folder. Wait for it to finish or cancel it.', 409)
        }
      }
      if (conflict) throw new ProjectError('project_overlap_conflict', 'Another registered folder overlaps this project. Remove the overlapping registration before changing ownership.', 409)
      // All activity checks and the durable rename share one synchronous commit point.
      // No new admission can interleave between these checks and revocation.
      if (this.#access.get(organizationId)) throw new ProjectError('project_busy', 'Wait for active organization requests and work to finish, then retry.', 409)
      if (this.#current().pendingRemoteJobs?.some(job => job.organizationId === organizationId)) {
        throw new ProjectError('project_busy', 'A remote job has no confirmed terminal receipt. Folder ownership cannot change while its execution or cleanup is uncertain.', 409)
      }
      this.#lifecycle.get(organizationId)?.assertIdle()
      const retiredSessions = this.#lifecycle.get(organizationId)?.sessionsToRetire?.(project, relatedClaims) ?? []
      signal?.throwIfAborted()
      const moved = targetOrganizationId ? {
        ...structuredClone(project), id: randomUUID(), organizationId: targetOrganizationId, createdAt: new Date().toISOString(),
      } : undefined
      this.#commit({
        ...this.#current(),
        projects: [...current.projects.filter(item => item.id !== id), ...(moved ? [moved] : [])],
        retiredProjects: [...(current.retiredProjects ?? []), project],
        remoteClaims: (current.remoteClaims ?? []).filter(claim => !relatedClaims.some(item =>
          item.workdir.nodeId === claim.workdir.nodeId && item.workdir.capabilityId === claim.workdir.capabilityId)),
        retiredRemoteClaims: [...(current.retiredRemoteClaims ?? []), ...relatedClaims],
        retiredSessions: [...(current.retiredSessions ?? []),
          ...retiredSessions.filter(sessionId => !this.isRetiredSession(organizationId, sessionId)).map(sessionId => ({ organizationId, sessionId }))],
      })
      this.#lifecycle.get(organizationId)?.invalidate()
      return moved ? structuredClone(moved) : undefined
    })
  }

  importProjects(organizationId: string, projects: ProjectRecord[]): Promise<void> {
    return this.#transaction(async () => {
      const current = this.#current()
      const added = projects.filter(project => !current.projects.some(item => item.id === project.id) &&
        !(current.retiredProjects ?? []).some(item => item.id === project.id))
        .map(project => ({ ...project, organizationId }))
      for (const project of added) {
        if (project.kind === 'remote') this.#assertRemoteOwnership(organizationId, project.workdir.nodeId, project.identity)
        else await this.#assertOwnership(organizationId, project.path, true)
      }
      if (added.length) this.#commit({ ...this.#current(), projects: [...current.projects, ...added] })
    })
  }

  async #assertOwnership(organizationId: string, path: string, legacy = false): Promise<void> {
    if (!this.get(organizationId)) throw new ProjectError('organization_not_found', 'Organization not found.', 404)
    if ([...this.#current().projects.filter(project => project.kind !== 'remote'), ...this.#reservations.values()].some(project => project.organizationId !== organizationId && overlaps(project.path, path))) {
      throw new ProjectError('folder_owned_by_another_organization', 'This folder overlaps a project belonging to another organization.', 409)
    }
    if (!legacy) {
      const homes = [this.hostHome, ...this.reservedHomes]
      const canonicalHomes = await Promise.all(homes.map(canonicalFutureDirectory))
      if ([...homes, ...canonicalHomes].some(home => overlaps(home, path))) {
        throw new ProjectError('folder_overlaps_home', 'Organization Home and host data cannot be registered as a folder project.', 409)
      }
    }
  }

  reserveDestination(organizationId: string, path: string): Promise<() => void> {
    return this.#transaction(async () => {
      const canonical = await canonicalFutureDirectory(path)
      await this.#assertOwnership(organizationId, canonical)
      const id = randomUUID()
      this.#reservations.set(id, { organizationId, path: canonical })
      return () => { this.#reservations.delete(id) }
    })
  }

  registerProject(organizationId: string, path: string, signal?: AbortSignal): Promise<ProjectRecord> {
    return this.#transaction(async () => {
      signal?.throwIfAborted()
      const canonical = await existingDirectory(path)
      await this.#assertOwnership(organizationId, canonical)
      const existing = this.projects(organizationId).find(project => project.kind !== 'remote' && overlaps(project.path, canonical) &&
        relative(project.path, canonical) === '')
      if (existing) return existing
      const project = { organizationId, id: randomUUID(), name: basename(canonical) || canonical, path: canonical, createdAt: new Date().toISOString() }
      signal?.throwIfAborted()
      this.#commit({ ...this.#current(), projects: [...this.#current().projects, project] })
      return { ...project }
    })
  }

  remoteClaims(nodeId?: string): RemoteOwnershipClaim[] {
    return structuredClone((this.#current().remoteClaims ?? []).filter(claim => !nodeId || claim.workdir.nodeId === nodeId))
  }

  reserveLegacyRemoteWorkdirs(organizationId: string, refs: readonly WorkdirRefV1[]): Promise<void> {
    return this.#transaction(() => {
      const claims = this.remoteClaims()
      for (const value of refs) {
        const workdir = remoteRef(value)
        if (this.isRetiredWorkdir(organizationId, workdir)) continue
        const existing = claims.find(claim => claim.workdir.nodeId === workdir.nodeId && claim.workdir.capabilityId === workdir.capabilityId)
        if (existing) {
          if (existing.organizationId !== organizationId) throw new Error('Legacy remote workdir already belongs to another organization')
          continue
        }
        claims.push({ organizationId, workdir })
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
        throw new ProjectError('legacy_remote_workdir_changed', 'An existing conversation reserves a different folder for this capability. Restore its original folder before opening new projects on this device.', 409)
      }
      this.#assertRemoteOwnership(claim.organizationId, ref.nodeId, parsed, true)
      claim.identity = parsed
      this.#commit({ ...this.#current(), remoteClaims: claims })
    })
  }

  refreshRemoteProjectIdentity(id: string, identity: WorkdirIdentityV1): Promise<void> {
    return this.#transaction(() => {
      const project = this.#current().projects.find(project => project.id === id)
      if (!project || project.kind !== 'remote') throw new ProjectError('project_not_found', 'Project not found.', 404)
      const verified = parseWorkdirIdentity(identity)
      if (verified.rootId !== project.identity.rootId) {
        throw new ProjectError('remote_workdir_changed', 'A registered folder capability changed its target. Restore the original capability before opening new projects on this device.', 409)
      }
      this.#assertRemoteOwnership(project.organizationId, project.workdir.nodeId, verified)
      this.#commit({ ...this.#current(), projects: this.#current().projects.map(item => item.id === id ? { ...project, identity: verified } : item) })
    })
  }

  #assertRemoteOwnership(organizationId: string, nodeId: string, identity: WorkdirIdentityV1, resolvingLegacy = false): void {
    if (!this.get(organizationId)) throw new ProjectError('organization_not_found', 'Organization not found.', 404)
    const claims = this.remoteClaims(nodeId)
    if (!resolvingLegacy && claims.some(claim => !claim.identity)) {
      throw new ProjectError('legacy_remote_identity_unavailable', 'An existing conversation still reserves a folder on this device. Reconnect and verify its original folder capability before opening another project.', 409)
    }
    if (claims.some(claim => claim.organizationId !== organizationId && claim.identity && workdirIdentitiesOverlap(claim.identity, identity)) ||
      this.#current().projects.some(project => project.kind === 'remote' && project.organizationId !== organizationId &&
        project.workdir.nodeId === nodeId && workdirIdentitiesOverlap(project.identity, identity))) {
      throw new ProjectError('folder_owned_by_another_organization', 'This remote folder overlaps a project belonging to another organization.', 409)
    }
  }

  registerRemoteProject(organizationId: string, value: WorkdirRefV1, identity: WorkdirIdentityV1, signal?: AbortSignal): Promise<RemoteProjectRecord> {
    return this.#transaction(() => {
      signal?.throwIfAborted()
      const workdir = remoteRef(value)
      const verified = parseWorkdirIdentity(identity)
      this.#assertRemoteOwnership(organizationId, workdir.nodeId, verified)
      const existing = this.projects(organizationId).find((project): project is RemoteProjectRecord =>
        project.kind === 'remote' && project.workdir.nodeId === workdir.nodeId && project.identity.rootId === verified.rootId)
      if (existing) {
        const updated = { ...existing, workdir, identity: verified, path: workdir.displayPathSnapshot ?? existing.path }
        this.#commit({ ...this.#current(), projects: this.#current().projects.map(project =>
          project.id === existing.id ? { ...updated, organizationId } : project) })
        return structuredClone(updated)
      }
      const project: RemoteProjectRecord & { organizationId: string } = {
        kind: 'remote', organizationId, id: randomUUID(), name: workdir.displayName || workdir.capabilityId,
        path: workdir.displayPathSnapshot ?? '', workdir, identity: verified, createdAt: new Date().toISOString(),
      }
      this.#commit({ ...this.#current(), projects: [...this.#current().projects, project] })
      return structuredClone(project)
    })
  }
}
