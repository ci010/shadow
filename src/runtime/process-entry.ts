import type { Config } from '../config/schema.ts'
import type { ChildBootstrapConfigV1 } from './bootstrap-config.ts'
import {
  dispatchRuntimeCli,
  type RuntimeCliDependencies,
  type RuntimeCliResult,
  type RuntimeLifecycleHandle,
} from './runtime-cli.ts'

export interface ProcessEntryDependencies {
  readonly loadConfig: (configPath?: string) => Promise<Config>
  readonly startMainRuntime: (
    config: Config,
    options: {
      readonly configPath: string
      readonly clusterSnapshotPath: string
      readonly gateway: { readonly port?: number }
    },
  ) => RuntimeLifecycleHandle | Promise<RuntimeLifecycleHandle>
  readonly startChildRuntime: (
    config: ChildBootstrapConfigV1,
    paths: Parameters<RuntimeCliDependencies['mainFactory']>[1],
    context: Parameters<RuntimeCliDependencies['mainFactory']>[2],
  ) => RuntimeLifecycleHandle | Promise<RuntimeLifecycleHandle>
  readonly runLegacy: () => Promise<void>
  readonly runtime: Omit<RuntimeCliDependencies, 'mainFactory' | 'childFactory'>
  readonly dispatch?: typeof dispatchRuntimeCli
}

export type ProcessEntryResult =
  | { readonly route: 'legacy' }
  | { readonly route: 'runtime'; readonly result: RuntimeCliResult }

export async function runProcessEntry(
  argv: readonly string[],
  dependencies: ProcessEntryDependencies,
): Promise<ProcessEntryResult> {
  const compiledRuntimeEntry = argv[1] === 'server' || argv[1] === 'child'
  const args = argv.slice(compiledRuntimeEntry ? 1 : 2)
  if (args[0] !== 'server' && args[0] !== 'child') {
    await dependencies.runLegacy()
    return { route: 'legacy' }
  }

  const dispatch = dependencies.dispatch ?? dispatchRuntimeCli
  const result = await dispatch(args, {
    ...dependencies.runtime,
    mainFactory: async (_plan, paths, context) => {
      const config = await dependencies.loadConfig(
        paths.mutableAgentConfigPath,
      )
      return await dependencies.startMainRuntime(config, {
        configPath: paths.mutableAgentConfigPath,
        clusterSnapshotPath: paths.clusterSnapshotPath,
        gateway: { port: context.loopbackPort },
      })
    },
    childFactory: async (plan, paths, context) => {
      if (plan.config.mode !== 'child') {
        throw new TypeError('Child factory requires Child configuration')
      }
      return await dependencies.startChildRuntime(plan.config, paths, context)
    },
  })
  return { route: 'runtime', result }
}
