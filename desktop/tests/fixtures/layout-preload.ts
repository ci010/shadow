import { contextBridge, ipcRenderer } from 'electron'
import { DOCUMENT_TAB_CHANNEL, receiveDocumentTabShortcuts } from '../../src/document-tabs.js'
import type { ShadowDesktopApi, DesktopWindowState } from '../../src/ipc-contract.js'
import type { MainRuntimeContext } from '../../src/bootstrap/coordinator.js'
import type { WizardState } from '../../src/wizard/state-machine.js'
import { createPasteClipboardFilesApi } from '../../src/clipboard-files-contract.js'

const prefix = '--layout-api-base='
const apiBase = process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length)
if (!apiBase || !/^http:\/\/127\.0\.0\.1:\d+$/.test(apiBase)) throw new Error('Layout fixture requires its isolated API origin')
window.localStorage.setItem('shadow.locale', 'en')

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
const folderDirectories: Array<string | null> = []
let folderPickerCalls = 0
const unused = async (): Promise<never> => { throw new Error('Unsupported layout fixture action') }

const disposeDocumentShortcuts = receiveDocumentTabShortcuts(ipcRenderer, direction => {
  window.dispatchEvent(new CustomEvent(DOCUMENT_TAB_CHANNEL, { detail: direction }))
})
window.addEventListener('unload', disposeDocumentShortcuts, { once: true })

const api: ShadowDesktopApi = {
  clipboardFiles: createPasteClipboardFilesApi(ipcRenderer, window),
  folders: {
    selectDirectory: async (...args: unknown[]) => {
      if (args.length) throw new Error('Folder directory picker accepts no arguments')
      folderPickerCalls += 1
      if (folderDirectories.length === 0) throw new Error('Synthetic folder picker was not queued')
      return folderDirectories.shift()!
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
  queueFolderDirectories: (values: Array<string | null>) => { folderDirectories.push(...values) },
  folderPickerCalls: () => folderPickerCalls,
  publishWindowState: (value: boolean) => {
    maximized = value
    for (const listener of listeners) listener({ maximized })
  },
})
