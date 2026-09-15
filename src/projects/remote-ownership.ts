import type { CapabilityDescriptorV1 } from '../cluster/contracts.ts'
import type { Executor } from '../execution/executor.ts'
import { executeRemoteWorkdirIdentity, RemoteWorkdirIdentityError } from '../execution/remote-workdir-identity-client.ts'
import { WORKDIR_IDENTITY_OPERATION, type WorkdirIdentityV1 } from '../execution/workdir-identity.ts'
import type { OrganizationCatalog } from '../organizations/catalog.ts'
import { type WorkdirCapabilityLookup, type WorkdirRefV1 } from '../sessions/locality.ts'
import type { RemoteProjectRecord } from './contracts.ts'
import { ProjectError } from './registry.ts'

export interface RemoteProjectOwnershipOptions {
  organizationId: string
  catalog: OrganizationCatalog
  executor: Executor
  lookup: WorkdirCapabilityLookup
  capability: (ref: WorkdirRefV1) => CapabilityDescriptorV1 | undefined
}

/** Authenticated Child facts only: Main never canonicalizes remote display paths. */
export class RemoteProjectOwnership {
  constructor(private readonly options: RemoteProjectOwnershipOptions) {}

  async #identity(ref: WorkdirRefV1, signal: AbortSignal): Promise<WorkdirIdentityV1> {
    const state = this.options.lookup(ref)
    if (state.node !== 'online' || state.capability?.kind !== 'workdir' || !state.capability.online) {
      throw new ProjectError('remote_workdir_unavailable', 'Reconnect the owning device and restore its folder capability before opening a new conversation.', 503)
    }
    if (!this.options.capability(ref)?.permissions.includes(WORKDIR_IDENTITY_OPERATION)) {
      throw new ProjectError('remote_workdir_identity_unsupported', 'Update the owning node to support verified folder ownership, then reconnect. Existing conversations remain available.', 409)
    }
    try {
      return await executeRemoteWorkdirIdentity({
        executor: this.options.executor, nodeId: ref.nodeId, capabilityId: ref.capabilityId,
        sessionId: `project-identity:${this.options.organizationId}`, turnId: crypto.randomUUID(), signal,
      })
    } catch (error) {
      if (error instanceof RemoteWorkdirIdentityError) throw new ProjectError(error.code, error.message, error.status)
      throw error
    }
  }

  async #refreshOwnership(nodeId: string, signal: AbortSignal): Promise<void> {
    // Recheck ancestry as directories can move between registrations. Unavailable or
    // retargeted old capabilities fail closed rather than silently losing ownership.
    for (const claim of this.options.catalog.remoteClaims(nodeId)) {
      const identity = await this.#identity(claim.workdir, signal)
      await this.options.catalog.resolveRemoteClaim(claim.workdir, identity)
    }
    for (const project of this.options.catalog.projects()) {
      if (project.kind !== 'remote' || project.workdir.nodeId !== nodeId) continue
      await this.options.catalog.refreshRemoteProjectIdentity(project.id, await this.#identity(project.workdir, signal))
    }
  }

  async register(ref: WorkdirRefV1, signal: AbortSignal): Promise<RemoteProjectRecord> {
    await this.#refreshOwnership(ref.nodeId, signal)
    const identity = await this.#identity(ref, signal)
    const capability = this.options.capability(ref)!
    return this.options.catalog.registerRemoteProject(this.options.organizationId, {
      ...ref, displayName: capability.displayName, displayPathSnapshot: capability.displayPath,
    }, identity, signal)
  }

  async requireAvailable(project: RemoteProjectRecord, signal: AbortSignal): Promise<RemoteProjectRecord> {
    await this.#refreshOwnership(project.workdir.nodeId, signal)
    const identity = await this.#identity(project.workdir, signal)
    if (identity.rootId !== project.identity.rootId) {
      throw new ProjectError('remote_workdir_changed', 'The remote folder capability now points to a different folder. Open it again before continuing.', 409)
    }
    const current = this.options.catalog.projects(this.options.organizationId).find(item => item.id === project.id)
    if (!current || current.kind !== 'remote') throw new ProjectError('project_access_revoked', 'This folder is no longer available to this organization.', 409)
    return current
  }
}
