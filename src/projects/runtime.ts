import type { Hono } from 'hono'
import type { MainCluster } from '../cluster/main-cluster.ts'
import type { Config } from '../config/schema.ts'
import type { ProjectScope } from './scope.ts'
import type { CopilotAuthenticator } from '../providers/copilot.ts'
import type { FolderRegistry } from '../folders/registry.ts'
import type { ProjectCatalog } from './catalog.ts'
import type { ProjectConfigStore } from './config-store.ts'
import type { ProjectRecord } from './contracts.ts'
import type { ChromePortAllocator } from '../browser/chrome-manager.ts'
import type { RealtimeHub } from '../realtime/hub.ts'

export interface ProjectRuntimeDependencies {
  project: ProjectRecord
  home: string
  scope: ProjectScope
  catalog: ProjectCatalog
  configStore: ProjectConfigStore
  mainCluster: MainCluster
  copilotAuth: CopilotAuthenticator
  chromePortAllocator: ChromePortAllocator
  authorize: (request: Request) => boolean | Promise<boolean>
  gatewayBaseUrl: string
  selfCodeRoot: string
  realtimeHub?: RealtimeHub
}

export interface ProjectRuntime {
  readonly app: Hono
  readonly folders: FolderRegistry
  readonly ready: Promise<void>
  shutdown(): Promise<void>
  updateConfig(config: Config): void | Promise<void>
  setGatewayBaseUrl(url: string): void
}

export type ProjectRuntimeFactory = (config: Config, dependencies: ProjectRuntimeDependencies) => Promise<ProjectRuntime>
