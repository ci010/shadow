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
import { desktopChildChannel } from '../child-desktop-ipc.ts'
import { startProductionChildRuntime } from '../production-child.ts'
import { startMainRuntime } from './start.ts'
import { resolveServiceEnvironment } from '../service-mode.ts'
import type { MainRuntimeOptions } from './contracts.ts'
import type { Config } from '../../config/schema.ts'
import { childPairingFailureCode } from '../child-pairing-diagnostics.ts'
import { runChildPairingCli } from '../child-pairing-cli.ts'

async function startLocalMainRuntime(config: Config, options: MainRuntimeOptions) {
  return startMainRuntime(config, options)
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
): Promise<ProcessEntryResult | { readonly route: 'child-pair' | 'project-audio' | 'project-video' }> {
  const runtimeArgs = hooks.argv.slice(hooks.argv[1] === 'server' || hooks.argv[1] === 'child' || hooks.argv[1] === 'project-audio' || hooks.argv[1] === 'project-video' ? 1 : 2)
  if (runtimeArgs[0] === 'project-video') {
    const { runVideoCli } = await import('../../video/cli.ts')
    const controller = new AbortController()
    const abort = () => controller.abort(new Error('Video command interrupted'))
    hooks.on('SIGINT', abort)
    hooks.on('SIGTERM', abort)
    try {
      process.stdout.write(JSON.stringify(await runVideoCli(runtimeArgs.slice(1), { signal: controller.signal }), null, 2) + '\n')
    } finally {
      hooks.off('SIGINT', abort)
      hooks.off('SIGTERM', abort)
    }
    return { route: 'project-video' }
  }
  if (runtimeArgs[0] === 'project-audio') {
    const { runProjectAudioCli } = await import('../../audio-cpp/host-cli.ts')
    process.stdout.write(JSON.stringify(await runProjectAudioCli(runtimeArgs.slice(1)), null, 2) + '\n')
    return { route: 'project-audio' }
  }
  if (runtimeArgs[0] === 'child' && runtimeArgs[1] === 'pair') {
    try { await runChildPairingCli(runtimeArgs.slice(2)) }
    catch (error) {
      process.stdout.write(JSON.stringify({ version: 1, state: 'failed', code: childPairingFailureCode(error) }) + '\n')
      throw new Error('Child pairing failed; verify the offer, endpoint and protected OS key store, then retry')
    }
    return { route: 'child-pair' }
  }
  if (runtimeArgs[0] === 'web' || hooks.argv[1] === 'web') throw new Error('Standalone browser access is no longer supported')
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
    startChildRuntime: (config, paths) => {
      const desktopChannel = desktopChildChannel()
      return startProductionChildRuntime(config, paths, desktopChannel ? { desktopChannel } : {})
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
