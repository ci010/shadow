import { localFolderWorkdirRef, resolveSessionLocations, type SessionLocalityState, type WorkdirLookup, type WorkdirRefV2 } from '../sessions/locality.ts'
import type { FolderRecord } from '../folders/contracts.ts'
import type { Executor } from './executor.ts'
import type { ResolvedToolTarget } from '../tools/context.ts'

/** The Folder was selected and checked in the current Project, never the global device inventory. */
export function resolveExplicitToolTarget(
  workspace: string, state: SessionLocalityState, lookup: WorkdirLookup | undefined,
  executor: Executor | undefined, folder: FolderRecord, operation: string,
): ResolvedToolTarget {
  const ref = folder.kind === 'remote' ? folder.workdir : localFolderWorkdirRef(folder.id)
  return { ...resolveWorkdirToolTarget(workspace, state, lookup, executor, ref, operation),
    fileChangeTarget: { nodeId: ref.nodeId, workdirId: ref.workdirId, folderId: folder.id } }
}

/** Host-only resource resolution also used to reconcile the exact target of a saved call. */
export function resolveWorkdirToolTarget(
  workspace: string, state: SessionLocalityState, lookup: WorkdirLookup | undefined,
  executor: Executor | undefined, ref: WorkdirRefV2, operation: string,
): ResolvedToolTarget {
  // Mandatory even for local managed-session IDs: locality has an absent-state compatibility shortcut.
  const checked = lookup?.(ref, operation)
  if (checked?.incompatible) throw new Error('Execution target requires a compatible Main and Child upgrade. No fallback is allowed.')
  if (checked?.node !== 'online' || !checked.workdir?.online) {
    throw new Error('Execution target unavailable or operation not authorized by this Project (node/resource missing, offline, revoked or incompatible). No fallback is allowed.')
  }
  const resolved = resolveSessionLocations(workspace, { ...state, workdir: ref }, undefined, lookup).workdir
  if (!resolved.available) throw new Error(`Execution target unavailable: ${resolved.reason}`)
  const fileChangeTarget = { nodeId: ref.nodeId, workdirId: ref.workdirId }
  if (resolved.locality === 'local') return { cwd: resolved.path, remoteWorkdir: undefined, fileChangeTarget }
  if (!executor) throw new Error('Remote executor unavailable. No Main fallback is allowed.')
  return { cwd: undefined, remoteWorkdir: { nodeId: ref.nodeId, workdirId: ref.workdirId, executor }, fileChangeTarget }
}
