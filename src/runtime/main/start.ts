import type { Config } from '../../config/schema.ts'
import type { MainRuntimeHandle, MainRuntimeOptions } from './contracts.ts'
import { createOrganizationRuntime } from './organization-runtime.ts'
import { startOrganizationHost } from './host.ts'
import { resolveSelfCodeRoot } from './paths.ts'

export async function startMainRuntime(
  config: Config,
  options: MainRuntimeOptions = {},
): Promise<MainRuntimeHandle> {
  return startOrganizationHost(config, options, createOrganizationRuntime, await resolveSelfCodeRoot(config.agent.workspace))
}
