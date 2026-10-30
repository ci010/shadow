import { normalizeStoredWorkdirIdentity } from '../execution/workdir-storage.ts'
import { isAbsolute, resolve } from 'node:path'
import { sessionWorkspacePath } from '../utils/paths.ts'

export const LOCAL_NODE_ID = 'local'

/** Historical storage DTO only. Execution and new writes use WorkdirRefV2. */
export interface WorkdirRefV1 {
  version: 1
  nodeId: string
  capabilityId: string
  displayName?: string
  displayPathSnapshot?: string
}

export interface WorkdirRefV2 {
  version: 2
  nodeId: string
  workdirId: string
  displayName?: string
  displayPathSnapshot?: string
}

export type WorkdirUnavailableReason =
  | 'node-missing'
  | 'node-offline'
  | 'workdir-missing'
  | 'workdir-revoked'
  | 'workdir-offline'
  | 'incompatible'

export interface WorkdirState {
  readonly node: 'online' | 'offline' | 'missing' | 'revoked'
  readonly workdir?: {
    readonly online: boolean
    /** Trusted local directory supplied by the resource registry, never a display path. */
    readonly path?: string
  }
  readonly incompatible?: boolean
}

export type WorkdirLookup = (
  workdir: WorkdirRefV2,
  operation?: string,
) => WorkdirState

export type WorkdirResolution =
  | { available: true; locality: 'local'; workdir: WorkdirRefV2; path: string }
  | { available: true; locality: 'remote'; workdir: WorkdirRefV2 }
  | { available: false; workdir: WorkdirRefV2; reason: WorkdirUnavailableReason }

export interface SessionLocalityState {
  sessionId: string
  workspaceRoot?: string
  workdir?: WorkdirRefV2
}

export interface ResolvedSessionLocations {
  home: string
  sessionDataDir: string
  workdir: WorkdirResolution
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read boundary for supported persisted formats. Resource identity is byte-preserving. */
export function parseWorkdirRef(value: unknown): WorkdirRefV2 | null {
  if (!isRecord(value) || (value.version !== 1 && value.version !== 2) ||
    typeof value.nodeId !== 'string' || value.nodeId.length === 0 ||
    (value.displayName !== undefined && typeof value.displayName !== 'string') ||
    (value.displayPathSnapshot !== undefined && typeof value.displayPathSnapshot !== 'string')) return null
  const normalized = normalizeStoredWorkdirIdentity(value)
  if (!normalized || Object.keys(normalized).some(key => !['version', 'nodeId', 'workdirId', 'displayName', 'displayPathSnapshot'].includes(key))) return null
  if (value.version === 1 && (!Object.hasOwn(value, 'capabilityId') || Object.hasOwn(value, 'workdirId') || Object.hasOwn(value, 'resourceId'))) return null
  if (value.version === 2 && Object.hasOwn(value, 'capabilityId')) return null
  const workdirId = normalized.workdirId as string
  return {
    version: 2, nodeId: value.nodeId, workdirId,
    ...(value.displayName === undefined ? {} : { displayName: value.displayName }),
    ...(value.displayPathSnapshot === undefined ? {} : { displayPathSnapshot: value.displayPathSnapshot }),
  }
}

/** Live response validation: retired field names are storage-only, never a wire adapter. */
export function parseLiveWorkdirRef(value: unknown): WorkdirRefV2 | null {
  if (!isRecord(value) || value.version !== 2 || !Object.hasOwn(value, 'workdirId') ||
    Object.keys(value).some(key => !['version', 'nodeId', 'workdirId', 'displayName', 'displayPathSnapshot'].includes(key))) return null
  return parseWorkdirRef(value)
}

/** @deprecated Historical V1 DTO readers only; core callers must use parseWorkdirRef. */
export function parseWorkdirRefV1(value: unknown): WorkdirRefV1 | null {
  if (!isRecord(value) || value.version !== 1) return null
  const parsed = parseWorkdirRef(value)
  if (!parsed) return null
  const { workdirId, ...rest } = parsed
  return { ...rest, version: 1, capabilityId: workdirId }
}

export function managedSessionWorkdirRef(ownerSessionId: string, localNodeId = LOCAL_NODE_ID): WorkdirRefV2 {
  return { version: 2, nodeId: localNodeId, workdirId: `managed-session-v1:${encodeURIComponent(ownerSessionId)}` }
}

export function localFolderWorkdirRef(folderId: string): WorkdirRefV2 {
  return { version: 2, nodeId: LOCAL_NODE_ID, workdirId: `local-project-v1:${folderId}` }
}

export function normalizeSessionLocality<T extends SessionLocalityState>(
  state: T,
  localNodeId = LOCAL_NODE_ID,
): T & { workdir: WorkdirRefV2 } {
  if (state.workdir === undefined) return {
    ...state, workdir: managedSessionWorkdirRef(state.workspaceRoot ?? state.sessionId, localNodeId),
  }
  const workdir = parseWorkdirRef(state.workdir)
  if (!workdir) throw new Error('Invalid or unsupported session workdir reference')
  return { ...state, workdir }
}

export function resolveSessionLocations(
  workspace: string,
  state: SessionLocalityState,
  localNodeId = LOCAL_NODE_ID,
  lookup?: WorkdirLookup,
): ResolvedSessionLocations {
  const normalized = normalizeSessionLocality(state, localNodeId)
  const ownerSessionId = state.workspaceRoot ?? state.sessionId
  const compatibilityRef = managedSessionWorkdirRef(ownerSessionId, localNodeId)
  const home = resolve(workspace)
  const sessionDataDir = sessionWorkspacePath(workspace, ownerSessionId)
  const ref = normalized.workdir
  const local = ref.nodeId === localNodeId || ref.nodeId === LOCAL_NODE_ID

  const nativeManaged = local && ref.workdirId === compatibilityRef.workdirId
  // An absent legacy target has this one host-owned default. Explicit refs still
  // honor authoritative refusal; the native owner directory needs no advertised
  // descriptor or display path to retain its existing identity.
  const resourceState = nativeManaged && state.workdir === undefined ? undefined : lookup?.(ref)
  if (nativeManaged) {
    if (resourceState?.incompatible) return unavailable('incompatible')
    if (resourceState?.node === 'revoked') return unavailable('workdir-revoked')
    if (resourceState?.node === 'offline') return unavailable('node-offline')
    if (resourceState?.node === 'missing') return unavailable('node-missing')
    if (resourceState?.workdir && !resourceState.workdir.online) return unavailable('workdir-offline')
    return { home, sessionDataDir, workdir: { available: true, locality: 'local', workdir: ref, path: sessionDataDir } }
  }

  if (resourceState?.incompatible) return unavailable('incompatible')
  if (resourceState?.node === 'offline') return unavailable('node-offline')
  if (resourceState?.node === 'revoked') return unavailable('workdir-revoked')
  if (!resourceState || resourceState.node === 'missing') return unavailable(local ? 'workdir-missing' : 'node-missing')
  const resource = resourceState.workdir
  if (!resource) return unavailable('workdir-missing')
  if (!resource.online) return unavailable('workdir-offline')
  if (!local) return { home, sessionDataDir, workdir: { available: true, locality: 'remote', workdir: ref } }
  if (typeof resource.path !== 'string' || !isAbsolute(resource.path)) return unavailable('incompatible')
  return { home, sessionDataDir, workdir: { available: true, locality: 'local', workdir: ref, path: resolve(resource.path) } }

  function unavailable(reason: WorkdirUnavailableReason): ResolvedSessionLocations {
    return { home, sessionDataDir, workdir: { available: false, workdir: ref, reason } }
  }
}
