import type { Hono } from 'hono'
import type { MainCluster } from '../cluster/main-cluster.ts'
import type { Config } from '../config/schema.ts'
import type { OrganizationScope } from './scope.ts'
import type { CopilotAuthenticator } from '../providers/copilot.ts'
import type { ProjectRegistry } from '../projects/registry.ts'
import type { OrganizationCatalog } from './catalog.ts'
import type { OrganizationConfigStore } from './config-store.ts'
import type { OrganizationRecord } from './contracts.ts'
import type { ChromePortAllocator } from '../browser/chrome-manager.ts'

export interface OrganizationRuntimeDependencies {
  organization: OrganizationRecord
  home: string
  scope: OrganizationScope
  catalog: OrganizationCatalog
  configStore: OrganizationConfigStore
  mainCluster: MainCluster
  copilotAuth: CopilotAuthenticator
  chromePortAllocator: ChromePortAllocator
  authorize: (request: Request) => boolean | Promise<boolean>
  gatewayBaseUrl: string
  selfCodeRoot: string
}

export interface OrganizationRuntime {
  readonly app: Hono
  readonly projects: ProjectRegistry
  readonly ready: Promise<void>
  shutdown(): Promise<void>
  updateConfig(config: Config): void
  setGatewayBaseUrl(url: string): void
}

export type OrganizationRuntimeFactory = (config: Config, dependencies: OrganizationRuntimeDependencies) => Promise<OrganizationRuntime>
