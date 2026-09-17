import type { Config } from '../../config/schema.ts'
import type { MainRuntimeHandle, MainRuntimeOptions } from './contracts.ts'
import { createProjectRuntime } from './project-runtime.ts'
import { startProjectHost } from './host.ts'
import { resolveSelfCodeRoot } from './paths.ts'

export async function startMainRuntime(
  config: Config,
  options: MainRuntimeOptions = {},
): Promise<MainRuntimeHandle> {
  return startProjectHost(config, options, createProjectRuntime, await resolveSelfCodeRoot(config.agent.workspace))
}
