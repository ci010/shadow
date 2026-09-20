import { readFile } from 'node:fs/promises'
import process from 'node:process'
import { resolve } from 'node:path'
import { loadConfig } from '../../config/loader.ts'
import { getOs } from '../../utils/runtime.ts'
import {
  attachBackendSignalHandlers,
  type BackendProcessHooks,
  parseBackendCliArguments,
} from '../backend-cli.ts'
import { type ProcessEntryResult, runProcessEntry } from '../process-entry.ts'
import { startProductionChildRuntime } from '../production-child.ts'
import { startMainRuntime } from './start.ts'
import { resolveServiceEnvironment } from '../service-mode.ts'
import { runWebPair } from '../web-pairing-cli.ts'
import { loadBrowserPinHash } from '../../gateway/browser-pin.ts'
import type { MainRuntimeOptions } from './contracts.ts'
import type { Config } from '../../config/schema.ts'

async function startLocalMainRuntime(config: Config, options: MainRuntimeOptions) {
  const browserPinHash = await loadBrowserPinHash(resolve(process.env.SHADOW_BROWSER_PIN_FILE ?? '.pin'))
  return startMainRuntime(config, {
    ...options, gateway: { ...options.gateway, ...(browserPinHash ? { browserPinHash } : {}) },
  })
}

export async function runBackendCli(
  hooks: BackendProcessHooks = nodeProcessHooks,
): Promise<void> {
  const { configPath } = parseBackendCliArguments(hooks.argv)
  const config = await loadConfig(configPath)
  const runtime = await startLocalMainRuntime(config, { configPath, localNodeId: 'local' })
  const detachSignals = attachBackendSignalHandlers(runtime, hooks, {
    includeSigterm: getOs() !== 'windows',
  })
  try {
    await runtime.finished
  } finally {
    detachSignals()
  }
}

export async function runRootProcessEntry(
  hooks: BackendProcessHooks = nodeProcessHooks,
): Promise<ProcessEntryResult | { readonly route: 'web-pair' }> {
  const runtimeArgs = hooks.argv.slice(hooks.argv[1] === 'server' || hooks.argv[1] === 'child' || hooks.argv[1] === 'web' ? 1 : 2)
  if (runtimeArgs[0] === 'web') {
    if (runtimeArgs[1] !== 'pair') throw new Error('Use web pair --connection <absolute descriptor> or web pair --url <loopback origin> --credential-file <absolute file>')
    await runWebPair(runtimeArgs.slice(2))
    return { route: 'web-pair' }
  }
  const environment = await resolveServiceEnvironment(runtimeArgs, {
    GATEWAY_PORT: process.env.GATEWAY_PORT,
    GATEWAY_HOST: process.env.GATEWAY_HOST,
    ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE,
    WINDOWS_USE_LAUNCH_TOKEN: process.env.WINDOWS_USE_LAUNCH_TOKEN,
    WINDOWS_USE_LAUNCH_TOKEN_FILE: process.env.WINDOWS_USE_LAUNCH_TOKEN_FILE,
    GATEWAY_LAUNCH_CREDENTIAL: process.env.GATEWAY_LAUNCH_CREDENTIAL,
  })
  return runProcessEntry(hooks.argv, {
    loadConfig,
    startMainRuntime: startLocalMainRuntime,
    startChildRuntime: (config, paths, context) => {
      if (
        context.loopbackPort !== undefined &&
        context.launchCredential === undefined
      ) {
        throw new TypeError(
          'Child local control requires WINDOWS_USE_LAUNCH_TOKEN',
        )
      }
      return startProductionChildRuntime(config, paths, {
        ...(context.loopbackPort === undefined ? {} : {
          localControl: {
            port: context.loopbackPort,
            launchCredential: context.launchCredential!,
          },
        }),
      })
    },
    runLegacy: () => runBackendCli(hooks),
    runtime: {
      readTextFile: (path) => readFile(path, 'utf8'),
      process: hooks,
      env: environment,
      includeSigterm: getOs() !== 'windows',
    },
  })
}

const nodeProcessHooks: BackendProcessHooks = {
  argv: process.argv,
  on: (signal, listener) => process.on(signal, listener),
  off: (signal, listener) => process.off(signal, listener),
  exit: (code) => process.exit(code),
}
