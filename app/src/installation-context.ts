export type InstallationMode = 'main' | 'child' | 'client'

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

export function createMobileClientContext(apiBase: string): InstallationContextV1 {
  return {
    version: 1, mode: 'client', localNodeId: 'mobile-client',
    mainConnection: 'connected', mainLatencyMs: null,
    uiScopes: LOCAL_MAIN_ADMIN_SCOPES.filter(scope => scope !== 'nodes:admin'),
    apiBase,
  }
}

export function createLocalMainAdminContext(
  apiBase: string,
): InstallationContextV1 {
  return {
    version: 1,
    mode: 'main',
    localNodeId: 'local',
    mainConnection: 'connected',
    mainLatencyMs: null,
    uiScopes: [...LOCAL_MAIN_ADMIN_SCOPES],
    apiBase,
  }
}