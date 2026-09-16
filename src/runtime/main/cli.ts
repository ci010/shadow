import { readFile } from 'node:fs/promises'
import process from 'node:process'
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

export async function runBackendCli(
  hooks: BackendProcessHooks = nodeProcessHooks,
): Promise<void> {
  const { configPath } = parseBackendCliArguments(hooks.argv)
  const config = await loadConfig(configPath)
  const runtime = await startMainRuntime(config, { configPath, localNodeId: 'local' })
  const detachSignals = attachBackendSignalHandlers(runtime, hooks, {
    includeSigterm: getOs() !== 'windows',
  })
  try {
    await runtime.finished
  } finally {
    detachSignals()
  }
}

export function runRootProcessEntry(
  hooks: BackendProcessHooks = nodeProcessHooks,
): Promise<ProcessEntryResult> {
  return runProcessEntry(hooks.argv, {
    loadConfig,
    startMainRuntime,
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
      env: {
        GATEWAY_PORT: process.env.GATEWAY_PORT,
        WINDOWS_USE_LAUNCH_TOKEN: process.env.WINDOWS_USE_LAUNCH_TOKEN,
      },
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
