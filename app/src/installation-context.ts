export type InstallationMode = 'main' | 'child'

export type MainConnectionState =
  | 'connected'
  | 'connecting'
  | 'offline'
  | 'unpaired'

export type UiScope =
  | 'chat:read'
  | 'chat:write'
  | 'knowledge:read'
  | 'main:admin'
  | 'nodes:admin'
  | 'audit:read'

export interface InstallationContextV1 {
  version: 1
  mode: InstallationMode
  localNodeId: string
  mainConnection: MainConnectionState
  mainLatencyMs: number | null
  uiScopes: UiScope[]
  apiBase: string
}

export const LOCAL_MAIN_ADMIN_SCOPES: readonly UiScope[] = [
  'chat:read',
  'chat:write',
  'knowledge:read',
  'main:admin',
  'nodes:admin',
  'audit:read',
]

export function createLocalMainAdminContext(
  apiBase: string,
): InstallationContextV1 {
  return {
    version: 1,
    mode: 'main',
    localNodeId: 'main-studio',
    mainConnection: 'connected',
    mainLatencyMs: 18,
    uiScopes: [...LOCAL_MAIN_ADMIN_SCOPES],
    apiBase,
  }
}