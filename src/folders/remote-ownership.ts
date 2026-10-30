import type { WorkdirAdvertisement } from '../execution/workdir-contracts.ts'
import type { Executor } from '../execution/executor.ts'
import { executeRemoteWorkdirIdentity, RemoteWorkdirIdentityError } from '../execution/remote-workdir-identity-client.ts'
import { WORKDIR_IDENTITY_OPERATION, type WorkdirIdentityV1 } from '../execution/workdir-identity.ts'
import type { ProjectCatalog } from '../projects/catalog.ts'
import { type WorkdirLookup, type WorkdirRefV2, type WorkdirUnavailableReason } from '../sessions/locality.ts'
import type { RemoteFolderRecord } from './contracts.ts'
import { FolderError } from './registry.ts'

export interface RemoteFolderOwnershipOptions {
  projectId: string
  catalog: ProjectCatalog
  executor: Executor
  lookup: WorkdirLookup
  workdir: (ref: WorkdirRefV2) => WorkdirAdvertisement | undefined
}

export class RemoteFolderWorkdirUnavailableError extends FolderError {
  constructor(readonly workdir: WorkdirRefV2, readonly reason: WorkdirUnavailableReason) {
    super('remote_workdir_unavailable', reason === 'incompatible'
      ? 'Upgrade both devices to the resource execution protocol, then reconnect.'
      : 'The owning node or its folder resource is unavailable. Restore access and check again.', 503)
  }
}

/** Authenticated Child facts only: Main never canonicalizes remote display paths. */
export class RemoteFolderOwnership {
  constructor(private readonly options: RemoteFolderOwnershipOptions) {}

  async #identity(ref: WorkdirRefV2, signal: AbortSignal): Promise<WorkdirIdentityV1> {
    const state = this.options.lookup(ref)
    if (state.incompatible || state.node !== 'online' || !state.workdir?.online) {
      const reason: WorkdirUnavailableReason = state.incompatible ? 'incompatible'
        : state.node === 'offline' ? 'node-offline'
        : state.node === 'missing' ? 'node-missing'
        : state.node === 'revoked' ? 'workdir-revoked'
        : !state.workdir ? 'workdir-missing'
        : 'workdir-offline'
      throw new RemoteFolderWorkdirUnavailableError(ref, reason)
    }
    if (!this.options.workdir(ref)?.support.operations.includes(WORKDIR_IDENTITY_OPERATION)) {
      throw new FolderError('remote_workdir_identity_unsupported', 'Update the owning node to support verified folder ownership, then reconnect.', 409)
    }
    try {
      return await executeRemoteWorkdirIdentity({
        executor: this.options.executor, nodeId: ref.nodeId, workdirId: ref.workdirId,
        sessionId: `folder-identity:${this.options.projectId}`, turnId: crypto.randomUUID(), signal,
      })
    } catch (error) {
      if (error instanceof RemoteWorkdirIdentityError) throw new FolderError(error.code, error.message, error.status)
      throw error
    }
  }

  async #refreshOwnership(nodeId: string, signal: AbortSignal): Promise<void> {
    // Recheck ancestry as directories can move between registrations. Unavailable or
    // retargeted resources fail closed rather than silently losing ownership.
    for (const claim of this.options.catalog.remoteClaims(nodeId)) {
      const identity = await this.#identity(claim.workdir, signal)
      await this.options.catalog.resolveRemoteClaim(claim.workdir, identity)
    }
    for (const folder of this.options.catalog.folders()) {
      if (folder.kind !== 'remote' || folder.workdir.nodeId !== nodeId) continue
      await this.options.catalog.refreshRemoteFolderIdentity(folder.id, await this.#identity(folder.workdir, signal))
    }
  }

  async register(ref: WorkdirRefV2, signal: AbortSignal): Promise<RemoteFolderRecord> {
    await this.#refreshOwnership(ref.nodeId, signal)
    const identity = await this.#identity(ref, signal)
    const resource = this.options.workdir(ref)
    if (!resource || resource.nodeId !== ref.nodeId || resource.workdirId !== ref.workdirId || !resource.online) {
      throw new RemoteFolderWorkdirUnavailableError(ref, 'workdir-missing')
    }
    return this.options.catalog.registerRemoteFolder(this.options.projectId, {
      ...ref, displayName: resource.displayName, displayPathSnapshot: resource.displayPath,
    }, identity, signal)
  }

  /** Verify an existing exact target without making unrelated resources a liveness dependency. */
  async requireExecutionAvailable(folder: RemoteFolderRecord, signal: AbortSignal): Promise<RemoteFolderRecord> {
    const identity = await this.#identity(folder.workdir, signal)
    // Keeps the saved root binding and checks current ancestry against retained
    // ownership facts; registration still refreshes the whole device separately.
    await this.options.catalog.refreshRemoteFolderIdentity(folder.id, identity)
    signal.throwIfAborted()
    const current = this.options.catalog.folders(this.options.projectId).find(item => item.id === folder.id)
    if (!current || current.kind !== 'remote') throw new FolderError('folder_access_revoked', 'This folder is no longer available to this project.', 409)
    return current
  }

  async requireAvailable(folder: RemoteFolderRecord, signal: AbortSignal): Promise<RemoteFolderRecord> {
    await this.#refreshOwnership(folder.workdir.nodeId, signal)
    const identity = await this.#identity(folder.workdir, signal)
    if (identity.rootId !== folder.identity.rootId) {
      throw new FolderError('remote_workdir_changed', 'The remote folder resource now points to a different folder. Open it again before continuing.', 409)
    }
    const current = this.options.catalog.folders(this.options.projectId).find(item => item.id === folder.id)
    if (!current || current.kind !== 'remote') throw new FolderError('folder_access_revoked', 'This folder is no longer available to this project.', 409)
    return current
  }
}
