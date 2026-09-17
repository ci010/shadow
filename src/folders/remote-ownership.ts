import type { CapabilityDescriptorV1 } from '../cluster/contracts.ts'
import type { Executor } from '../execution/executor.ts'
import { executeRemoteWorkdirIdentity, RemoteWorkdirIdentityError } from '../execution/remote-workdir-identity-client.ts'
import { WORKDIR_IDENTITY_OPERATION, type WorkdirIdentityV1 } from '../execution/workdir-identity.ts'
import type { ProjectCatalog } from '../projects/catalog.ts'
import { type WorkdirCapabilityLookup, type WorkdirRefV1, type WorkdirUnavailableReason } from '../sessions/locality.ts'
import type { RemoteFolderRecord } from './contracts.ts'
import { FolderError } from './registry.ts'

export interface RemoteFolderOwnershipOptions {
  projectId: string
  catalog: ProjectCatalog
  executor: Executor
  lookup: WorkdirCapabilityLookup
  capability: (ref: WorkdirRefV1) => CapabilityDescriptorV1 | undefined
}

export class RemoteFolderWorkdirUnavailableError extends FolderError {
  constructor(readonly workdir: WorkdirRefV1, readonly reason: WorkdirUnavailableReason) {
    super('remote_workdir_unavailable', 'The owning node or its folder capability is unavailable. Restore access and check again.', 503)
  }
}

/** Authenticated Child facts only: Main never canonicalizes remote display paths. */
export class RemoteFolderOwnership {
  constructor(private readonly options: RemoteFolderOwnershipOptions) {}

  async #identity(ref: WorkdirRefV1, signal: AbortSignal): Promise<WorkdirIdentityV1> {
    const state = this.options.lookup(ref)
    if (state.node !== 'online' || state.capability?.kind !== 'workdir' || !state.capability.online) {
      const reason: WorkdirUnavailableReason = state.node === 'offline' ? 'node-offline'
        : state.node === 'missing' ? 'node-missing'
        : state.node === 'revoked' ? 'capability-revoked'
        : !state.capability ? 'capability-missing'
        : state.capability.kind !== 'workdir' ? 'incompatible' : 'capability-offline'
      throw new RemoteFolderWorkdirUnavailableError(ref, reason)
    }
    if (!this.options.capability(ref)?.permissions.includes(WORKDIR_IDENTITY_OPERATION)) {
      throw new FolderError('remote_workdir_identity_unsupported', 'Update the owning node to support verified folder ownership, then reconnect. Existing conversations remain available.', 409)
    }
    try {
      return await executeRemoteWorkdirIdentity({
        executor: this.options.executor, nodeId: ref.nodeId, capabilityId: ref.capabilityId,
        sessionId: `folder-identity:${this.options.projectId}`, turnId: crypto.randomUUID(), signal,
      })
    } catch (error) {
      if (error instanceof RemoteWorkdirIdentityError) throw new FolderError(error.code, error.message, error.status)
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
    for (const folder of this.options.catalog.folders()) {
      if (folder.kind !== 'remote' || folder.workdir.nodeId !== nodeId) continue
      await this.options.catalog.refreshRemoteFolderIdentity(folder.id, await this.#identity(folder.workdir, signal))
    }
  }

  async register(ref: WorkdirRefV1, signal: AbortSignal): Promise<RemoteFolderRecord> {
    await this.#refreshOwnership(ref.nodeId, signal)
    const identity = await this.#identity(ref, signal)
    const capability = this.options.capability(ref)!
    return this.options.catalog.registerRemoteFolder(this.options.projectId, {
      ...ref, displayName: capability.displayName, displayPathSnapshot: capability.displayPath,
    }, identity, signal)
  }

  async requireAvailable(folder: RemoteFolderRecord, signal: AbortSignal): Promise<RemoteFolderRecord> {
    await this.#refreshOwnership(folder.workdir.nodeId, signal)
    const identity = await this.#identity(folder.workdir, signal)
    if (identity.rootId !== folder.identity.rootId) {
      throw new FolderError('remote_workdir_changed', 'The remote folder capability now points to a different folder. Open it again before continuing.', 409)
    }
    const current = this.options.catalog.folders(this.options.projectId).find(item => item.id === folder.id)
    if (!current || current.kind !== 'remote') throw new FolderError('folder_access_revoked', 'This folder is no longer available to this project.', 409)
    return current
  }
}
