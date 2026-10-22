export type InstallationMode = 'main' | 'child' | 'client'

export type MainConnectionState =
  | 'connected'
  | 'connecting'
  | 'offline'
  | 'unpaired'

export interface InstallationContextV1 {
  version: 1
  mainWorkspace?: boolean
  mode: InstallationMode
  localNodeId: string
  mainConnection: MainConnectionState
  mainLatencyMs: number | null
  apiBase: string
}

export function createMobileClientContext(apiBase: string): InstallationContextV1 {
  return {
    version: 1, mode: 'client', localNodeId: 'mobile-client',
    mainConnection: 'connected', mainLatencyMs: null,
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
    apiBase,
  }
}