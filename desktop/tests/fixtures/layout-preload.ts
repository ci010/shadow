import { contextBridge } from 'electron'
import type { ShadowDesktopApi, DesktopWindowState } from '../../src/ipc-contract.js'
import type { MainRuntimeContext } from '../../src/bootstrap/coordinator.js'
import type { WizardState } from '../../src/wizard/state-machine.js'

const prefix = '--layout-api-base='
const apiBase = process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length)
if (!apiBase || !/^http:\/\/127\.0\.0\.1:\d+$/.test(apiBase)) throw new Error('Layout fixture requires its isolated API origin')

const context: MainRuntimeContext = {
  version: 1,
  mode: 'main',
  localNodeId: 'layout-fixture',
  mainConnection: 'connected',
  mainLatencyMs: null,
  uiScopes: ['chat:read', 'chat:write', 'knowledge:read', 'main:admin', 'nodes:admin', 'audit:read'],
  apiBase,
}
const state: WizardState = { version: 1, revision: 1, mode: 'main', step: 'complete' }
let maximized = false
const calls: string[] = []
const listeners = new Set<(value: DesktopWindowState) => void>()
const projectDirectories: Array<string | null> = []
let projectPickerCalls = 0
const unused = async (): Promise<never> => { throw new Error('Unsupported layout fixture action') }

const api: ShadowDesktopApi = {
  projects: {
    selectDirectory: async (...args: unknown[]) => {
      if (args.length) throw new Error('Project directory picker accepts no arguments')
      projectPickerCalls += 1
      if (projectDirectories.length === 0) throw new Error('Synthetic project picker was not queued')
      return projectDirectories.shift()!
    },
  },
  bootstrap: {
    load: async () => state,
    ensureRuntime: async () => ({ ok: true, context }),
    dispatch: unused,
    clear: unused,
    commitMainDirectory: unused,
    initializeMain: unused,
    launchMain: unused,
  },
  windowControls: {
    getState: async () => ({ maximized }),
    minimize: async () => { calls.push('minimize') },
    close: async () => { calls.push('close') },
    toggleMaximize: async () => {
      calls.push('toggleMaximize')
      maximized = !maximized
      for (const listener of listeners) listener({ maximized })
      return { maximized }
    },
    onStateChanged: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  },
  selectDirectory: unused,
  getMainDirectorySelection: unused,
  selectMainDirectoryPath: unused,
  openExternal: unused,
  openCopilotLogin: unused,
}

contextBridge.exposeInMainWorld('shadowDesktop', api)
contextBridge.exposeInMainWorld('layoutFixture', {
  windowCalls: () => [...calls],
  queueProjectDirectories: (values: Array<string | null>) => { projectDirectories.push(...values) },
  projectPickerCalls: () => projectPickerCalls,
  publishWindowState: (value: boolean) => {
    maximized = value
    for (const listener of listeners) listener({ maximized })
  },
})
