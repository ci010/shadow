import { isAbsolute, resolve } from 'node:path'
import { sessionWorkspacePath } from '../utils/paths.ts'

export const LOCAL_NODE_ID = 'local'

export interface WorkdirRefV1 {
  version: 1
  nodeId: string
  capabilityId: string
  displayName?: string
  displayPathSnapshot?: string
}

export type WorkdirUnavailableReason =
  | 'node-missing'
  | 'node-offline'
  | 'capability-missing'
  | 'capability-revoked'
  | 'capability-offline'
  | 'incompatible'

export interface WorkdirCapabilityState {
  readonly node: 'online' | 'offline' | 'missing' | 'revoked'
  readonly capability?: {
    readonly kind: string
    readonly online: boolean
    /** Trusted local directory supplied by the capability registry, not a display path. */
    readonly path?: string
  }
}

export type WorkdirCapabilityLookup = (
  workdir: WorkdirRefV1,
) => WorkdirCapabilityState

export type WorkdirResolution =
  | {
    available: true
    locality: 'local'
    workdir: WorkdirRefV1
    path: string
  }
  | {
    available: true
    locality: 'remote'
    workdir: WorkdirRefV1
  }
  | {
    available: false
    workdir: WorkdirRefV1
    reason: WorkdirUnavailableReason
  }

export interface SessionLocalityState {
  sessionId: string
  workspaceRoot?: string
  workdir?: WorkdirRefV1
}

export interface ResolvedSessionLocations {
  home: string
  sessionDataDir: string
  workdir: WorkdirResolution
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseWorkdirRefV1(value: unknown): WorkdirRefV1 | null {
  if (
    !isRecord(value) || value.version !== 1 ||
    typeof value.nodeId !== 'string' || value.nodeId.length === 0 ||
    typeof value.capabilityId !== 'string' || value.capabilityId.length === 0 ||
    (value.displayName !== undefined &&
      typeof value.displayName !== 'string') ||
    (value.displayPathSnapshot !== undefined &&
      typeof value.displayPathSnapshot !== 'string')
  ) {
    return null
  }

  return {
    version: 1,
    nodeId: value.nodeId,
    capabilityId: value.capabilityId,
    ...(value.displayName === undefined
      ? {}
      : { displayName: value.displayName }),
    ...(value.displayPathSnapshot === undefined
      ? {}
      : { displayPathSnapshot: value.displayPathSnapshot }),
  }
}

export function managedSessionWorkdirRef(
  ownerSessionId: string,
  localNodeId = LOCAL_NODE_ID,
): WorkdirRefV1 {
  return {
    version: 1,
    nodeId: localNodeId,
    capabilityId: `managed-session-v1:${encodeURIComponent(ownerSessionId)}`,
  }
}

export function localFolderWorkdirRef(folderId: string): WorkdirRefV1 {
  return {
    version: 1,
    nodeId: LOCAL_NODE_ID,
    capabilityId: `local-project-v1:${folderId}`,
  }
}

export function normalizeSessionLocality<T extends SessionLocalityState>(
  state: T,
  localNodeId = LOCAL_NODE_ID,
): T & { workdir: WorkdirRefV1 } {
  return {
    ...state,
    workdir: state.workdir ?? managedSessionWorkdirRef(
      state.workspaceRoot ?? state.sessionId,
      localNodeId,
    ),
  }
}

export function resolveSessionLocations(
  workspace: string,
  state: SessionLocalityState,
  localNodeId = LOCAL_NODE_ID,
  lookup?: WorkdirCapabilityLookup,
): ResolvedSessionLocations {
  const normalized = normalizeSessionLocality(state, localNodeId)
  const ownerSessionId = state.workspaceRoot ?? state.sessionId
  const compatibilityRef = managedSessionWorkdirRef(ownerSessionId, localNodeId)
  const home = resolve(workspace)
  const sessionDataDir = sessionWorkspacePath(workspace, ownerSessionId)

  if (normalized.workdir.nodeId !== localNodeId) {
    const state = lookup?.(normalized.workdir)
    if (state?.node === 'online' && state.capability) {
      if (state.capability.kind !== 'workdir') {
        return unavailable('incompatible')
      }
      if (!state.capability.online) return unavailable('capability-offline')
      return {
        home,
        sessionDataDir,
        workdir: {
          available: true,
          locality: 'remote',
          workdir: normalized.workdir,
        },
      }
    }
    if (state?.node === 'offline') return unavailable('node-offline')
    if (state?.node === 'revoked') return unavailable('capability-revoked')
    if (state?.node === 'online') return unavailable('capability-missing')
    return {
      home,
      sessionDataDir,
      workdir: {
        available: false,
        workdir: normalized.workdir,
        reason: 'node-missing',
      },
    }
  }

  if (normalized.workdir.capabilityId !== compatibilityRef.capabilityId) {
    const capabilityState = lookup?.(normalized.workdir)
    if (capabilityState?.node === 'offline') return unavailable('node-offline')
    if (capabilityState?.node === 'revoked') return unavailable('capability-revoked')
    if (capabilityState?.node !== 'online') return unavailable('capability-missing')
    const capability = capabilityState.capability
    if (!capability) return unavailable('capability-missing')
    if (capability.kind !== 'workdir') return unavailable('incompatible')
    if (!capability.online) return unavailable('capability-offline')
    if (typeof capability.path !== 'string' || !isAbsolute(capability.path)) {
      return unavailable('incompatible')
    }
    return {
      home,
      sessionDataDir,
      workdir: {
        available: true,
        locality: 'local',
        workdir: normalized.workdir,
        path: resolve(capability.path),
      },
    }
  }

  return {
    home,
    sessionDataDir,
    workdir: {
      available: true,
      locality: 'local',
      workdir: normalized.workdir,
      path: sessionDataDir,
    },
  }

  function unavailable(
    reason: WorkdirUnavailableReason,
  ): ResolvedSessionLocations {
    return {
      home,
      sessionDataDir,
      workdir: {
        available: false,
        workdir: normalized.workdir,
        reason,
      },
    }
  }
}
