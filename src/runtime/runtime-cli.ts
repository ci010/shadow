import { posix, win32 as windows } from 'node:path'
import {
  planRuntimeArguments,
  planRuntimeStartup,
  type RuntimeStartupPlan,
} from './startup-plan.ts'
import type { BackendSignal } from './backend-cli.ts'

export type RuntimePathPlatform = 'windows' | 'posix'

export interface RuntimeDerivedPaths {
  readonly bootstrapConfigPath: string
  readonly bootstrapDirectory: string
  readonly dataDir: string
  readonly mutableAgentConfigPath: string
  readonly clusterSnapshotPath: string
  readonly childCredentialPath: string
}

export interface RuntimeLaunchContext {
  readonly loopbackPort?: number
  readonly launchCredential?: string
}

export interface RuntimeLifecycleHandle {
  readonly ready: Promise<void>
  readonly finished: Promise<void>
  shutdown(): Promise<void>
}

export type RuntimeLifecycleFactory = (
  plan: RuntimeStartupPlan,
  paths: RuntimeDerivedPaths,
  context: RuntimeLaunchContext,
) => RuntimeLifecycleHandle | Promise<RuntimeLifecycleHandle>

export interface RuntimeCliProcessHooks {
  on(signal: BackendSignal, listener: () => void): void
  off(signal: BackendSignal, listener: () => void): void
}

export interface RuntimeCliDependencies {
  readonly readTextFile: (path: string) => Promise<string>
  readonly mainFactory: RuntimeLifecycleFactory
  readonly childFactory: RuntimeLifecycleFactory
  readonly process: RuntimeCliProcessHooks
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly includeSigterm?: boolean
  readonly pathPlatform?: RuntimePathPlatform
  readonly cwd?: string
}

export interface RuntimeCliResult {
  readonly plan: RuntimeStartupPlan
  readonly paths: RuntimeDerivedPaths
  readonly started: boolean
}

export type RuntimeCliErrorCode =
  | 'config_read_failed'
  | 'config_json_invalid'
  | 'config_invalid'
  | 'factory_failed'
  | 'lifecycle_failed'
  | 'environment_invalid'

export class RuntimeCliError extends Error {
  constructor(
    readonly code: RuntimeCliErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'RuntimeCliError'
  }
}

export function deriveRuntimePaths(
  bootstrapConfigPath: string,
  dataDir: string,
  options: {
    readonly platform: RuntimePathPlatform
    readonly cwd?: string
  },
): RuntimeDerivedPaths {
  const path = options.platform === 'windows' ? windows : posix
  const cwd = options.cwd ?? path.resolve('.')
  const configPath = path.resolve(cwd, bootstrapConfigPath)
  const bootstrapDirectory = path.dirname(configPath)
  const resolvedDataDir = path.resolve(bootstrapDirectory, dataDir)

  return {
    bootstrapConfigPath: configPath,
    bootstrapDirectory,
    dataDir: resolvedDataDir,
    mutableAgentConfigPath: path.join(
      resolvedDataDir,
      'config',
      'bot.config.json',
    ),
    clusterSnapshotPath: path.join(
      resolvedDataDir,
      'cluster',
      'registry.v1.json',
    ),
    childCredentialPath: path.join(
      resolvedDataDir,
      'credentials',
      'device-credential.v1.json',
    ),
  }
}

export async function dispatchRuntimeCli(
  args: readonly string[],
  dependencies: RuntimeCliDependencies,
): Promise<RuntimeCliResult> {
  const argumentsPlan = planRuntimeArguments(args)
  const platform = dependencies.pathPlatform ??
    (process.platform === 'win32' ? 'windows' : 'posix')
  const preliminaryPaths = deriveRuntimePaths(
    argumentsPlan.configPath,
    '.',
    { platform, cwd: dependencies.cwd },
  )

  let text: string
  try {
    text = await dependencies.readTextFile(preliminaryPaths.bootstrapConfigPath)
  } catch {
    throw new RuntimeCliError(
      'config_read_failed',
      `Unable to read bootstrap configuration at "${preliminaryPaths.bootstrapConfigPath}"`,
    )
  }

  let rawConfig: unknown
  try {
    rawConfig = JSON.parse(text)
  } catch {
    throw new RuntimeCliError(
      'config_json_invalid',
      `Bootstrap configuration at "${preliminaryPaths.bootstrapConfigPath}" is not valid JSON`,
    )
  }

  let plan: RuntimeStartupPlan
  try {
    plan = planRuntimeStartup(argumentsPlan, rawConfig)
  } catch (cause) {
    throw new RuntimeCliError(
      'config_invalid',
      `Bootstrap configuration at "${preliminaryPaths.bootstrapConfigPath}" is invalid: ${
        errorMessage(cause)
      }`,
    )
  }

  const paths = deriveRuntimePaths(
    argumentsPlan.configPath,
    plan.config.dataDir,
    {
      platform,
      cwd: dependencies.cwd,
    },
  )
  if (plan.command === 'validate') return { plan, paths, started: false }

  const context = readLaunchContext(dependencies.env ?? {})
  const factory = plan.config.mode === 'main'
    ? dependencies.mainFactory
    : dependencies.childFactory
  let lifecycle: RuntimeLifecycleHandle
  try {
    lifecycle = await factory(plan, paths, context)
  } catch {
    throw new RuntimeCliError(
      'factory_failed',
      `Failed to create ${plan.config.mode} runtime`,
    )
  }

  const detachSignals = attachRuntimeSignalHandlers(
    lifecycle,
    dependencies.process,
    dependencies.includeSigterm ?? false,
  )
  try {
    await lifecycle.ready
    await lifecycle.finished
  } catch (cause) {
    throw new RuntimeCliError(
      'lifecycle_failed',
      `${plan.config.mode} runtime failed`,
      { cause },
    )
  } finally {
    detachSignals()
  }

  return { plan, paths, started: true }
}

export function attachRuntimeSignalHandlers(
  lifecycle: RuntimeLifecycleHandle,
  hooks: RuntimeCliProcessHooks,
  includeSigterm: boolean,
): () => void {
  let shutdownPromise: Promise<void> | undefined
  const listener = (): void => {
    shutdownPromise ??= lifecycle.shutdown()
    void shutdownPromise.catch(() => {})
  }
  const signals: BackendSignal[] = includeSigterm
    ? ['SIGINT', 'SIGTERM']
    : ['SIGINT']
  for (const signal of signals) hooks.on(signal, listener)

  return () => {
    for (const signal of signals) hooks.off(signal, listener)
  }
}

function readLaunchContext(
  env: Readonly<Record<string, string | undefined>>,
): RuntimeLaunchContext {
  const rawPort = env.GATEWAY_PORT ?? env.SHADOW_LOOPBACK_PORT
  const launchCredential = env.WINDOWS_USE_LAUNCH_TOKEN
  const credentialContext = !launchCredential ? {} : { launchCredential }
  if (rawPort === undefined || rawPort.trim() === '') return credentialContext
  const loopbackPort = Number(rawPort)
  if (
    !Number.isInteger(loopbackPort) || loopbackPort < 0 || loopbackPort > 65535
  ) {
    throw new RuntimeCliError(
      'environment_invalid',
      'GATEWAY_PORT must be an integer between 0 and 65535',
    )
  }
  return { loopbackPort, ...credentialContext }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown configuration error'
}
