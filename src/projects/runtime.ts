import type { Hono } from 'hono'
import type { RuntimeDiagnosticLog } from '../runtime/diagnostic-log.ts'
import type { MainCluster } from '../cluster/main-cluster.ts'
import type { Config } from '../config/schema.ts'
import type { ProjectScope } from './scope.ts'
import type { CopilotAuthenticator } from '../providers/copilot.ts'
import type { FolderRegistry } from '../folders/registry.ts'
import type { ProjectCatalog } from './catalog.ts'
import type { ProjectConfigStore } from './config-store.ts'
import type { ProjectRecord } from './contracts.ts'
import type { RealtimeHub } from '../realtime/hub.ts'
import type { ComputerService } from '../computer/service.ts'

export interface ProjectRuntimeDependencies {
  /** Single-use ownership scan, only during the initial host boot. */
  startupSessionStates?: import('./session-ownership.ts').StartupOwnershipStates
  diagnostics?: RuntimeDiagnosticLog
  /** Omission preserves legacy/test callers. False selects the coordinator tool profile. */
  localExecutor?: boolean
  project: ProjectRecord
  home: string
  scope: ProjectScope
  catalog: ProjectCatalog
  configStore: ProjectConfigStore
  mainCluster: MainCluster
  copilotAuth: CopilotAuthenticator
  authorize: (request: Request) => boolean | Promise<boolean>
  realtimeHub?: RealtimeHub
  computer?: ComputerService
  /** Desktop grants require a local owner, not mobile/device credentials. */
}

export interface ProjectRuntime {
  authorizeA2a?(request: Request): boolean
  readonly app: Hono
  readonly folders: FolderRegistry
  readonly ready: Promise<void>
  shutdown(): Promise<void>
  updateConfig(config: Config): void | Promise<void>
}

export type ProjectRuntimeFactory = (config: Config, dependencies: ProjectRuntimeDependencies) => Promise<ProjectRuntime>
