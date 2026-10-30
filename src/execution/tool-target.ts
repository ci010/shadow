import { resolveSessionLocations, type SessionLocalityState, type WorkdirCapabilityLookup } from '../sessions/locality.ts'
import type { Executor } from './executor.ts'
import type { ExecutionContext } from '../tools/context.ts'

/** Uses the Project-scoped lookup and executor, never the global device registry. */
export function resolveExplicitToolTarget(
  workspace: string, state: SessionLocalityState, lookup: WorkdirCapabilityLookup | undefined,
  executor: Executor | undefined, nodeId: string, capabilityId: string,
): Pick<ExecutionContext, 'cwd' | 'remoteWorkdir'> {
  const ref = { version: 1 as const, nodeId, capabilityId }
  // Mandatory even for local managed-session IDs: locality has a legacy shortcut.
  const checked = lookup?.(ref)
  if (checked?.node !== 'online' || checked.capability?.kind !== 'workdir' || !checked.capability.online) {
    throw new Error('Execution target unavailable or not authorized by this Project (node/capability missing, offline, revoked or incompatible). No fallback is allowed.')
  }
  const resolved = resolveSessionLocations(workspace, { ...state, workdir: ref }, undefined, lookup).workdir
  if (!resolved.available) throw new Error(`Execution target unavailable: ${resolved.reason}`)
  if (resolved.locality === 'local') return { cwd: resolved.path, remoteWorkdir: undefined }
  if (!executor) throw new Error('Remote executor unavailable. No Main fallback is allowed.')
  return { cwd: undefined, remoteWorkdir: { nodeId, capabilityId, executor } }
}
