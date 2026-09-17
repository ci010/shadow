import {
  type InstallationMode,
  parseBootstrapConfigV1,
} from './bootstrap-config.ts'

export type RuntimeCommand = 'start' | 'validate'

export interface RuntimeArgumentPlan {
  readonly command: RuntimeCommand
  readonly expectedMode: InstallationMode
  readonly configPath: string
  readonly serviceMode: boolean
  readonly localExecutor: boolean
  readonly requiresDisplay: false
  readonly launchUi: false
}

export interface RuntimeStartupPlan extends RuntimeArgumentPlan {
  readonly config: ReturnType<typeof parseBootstrapConfigV1>
}

export class RuntimeArgumentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RuntimeArgumentError'
  }
}

export function planRuntimeArguments(
  args: readonly string[],
): RuntimeArgumentPlan {
  const [role, command, ...flags] = args
  const expectedMode = role === 'server'
    ? 'main'
    : role === 'child'
    ? 'child'
    : undefined
  if (expectedMode === undefined) {
    throw new RuntimeArgumentError('first argument must be "server" or "child"')
  }
  if (command !== 'start' && command !== 'validate') {
    throw new RuntimeArgumentError(
      'second argument must be "start" or "validate"',
    )
  }

  let configPath: string | undefined
  let serviceMode = false
  let localExecutor = false
  for (let index = 0; index < flags.length; index++) {
    const flag = flags[index]
    if (flag === '--config') {
      const value = flags[++index]
      if (value === undefined || value.startsWith('--')) {
        throw new RuntimeArgumentError('--config requires a path')
      }
      if (configPath !== undefined) {
        throw new RuntimeArgumentError('--config may only be supplied once')
      }
      configPath = value.trim()
      if (configPath === '') {
        throw new RuntimeArgumentError('--config requires a path')
      }
    } else if (flag === '--service') {
      serviceMode = true
    } else if (flag === '--local-executor') {
      localExecutor = true
    } else {
      throw new RuntimeArgumentError(`unknown argument "${flag}"`)
    }
  }

  if (configPath === undefined) {
    throw new RuntimeArgumentError('--config is required')
  }
  if (command === 'validate' && (serviceMode || localExecutor)) {
    throw new RuntimeArgumentError('validate does not accept runtime flags')
  }
  if (expectedMode === 'child' && localExecutor) {
    throw new RuntimeArgumentError(
      '--local-executor is only valid for server start',
    )
  }

  return {
    command,
    expectedMode,
    configPath,
    serviceMode,
    localExecutor,
    requiresDisplay: false,
    launchUi: false,
  }
}

export function planRuntimeStartup(
  argumentsPlan: RuntimeArgumentPlan,
  rawConfig: unknown,
): RuntimeStartupPlan {
  const config = parseBootstrapConfigV1(rawConfig)
  if (config.mode !== argumentsPlan.expectedMode) {
    throw new RuntimeArgumentError(
      `command expects mode "${argumentsPlan.expectedMode}" but config has mode "${config.mode}"`,
    )
  }

  return {
    ...argumentsPlan,
    config,
  }
}
