import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC_CHANNELS,
  type LaunchMainOptions,
  type NativeDirectorySelection,
  type ShadowDesktopApi,
} from './ipc-contract.js'
import type { WizardEvent, WizardState } from './wizard/state-machine.js'
import { createWindowControlsApi } from './window-controls-preload.js'
import { createProjectDirectoriesApi } from './project-directories.js'
import { createChatContextApi } from './chat-context.js'

const api: ShadowDesktopApi = Object.freeze({
  windowControls: createWindowControlsApi(ipcRenderer),
  projects: createProjectDirectoriesApi(ipcRenderer),
  chatContext: createChatContextApi(ipcRenderer),
  bootstrap: Object.freeze({
    load: () =>
      ipcRenderer.invoke(IPC_CHANNELS.loadWizard) as Promise<WizardState>,
    dispatch: (event: WizardEvent) =>
      ipcRenderer.invoke(IPC_CHANNELS.dispatchWizard, event) as Promise<
        WizardState
      >,
    clear: () => ipcRenderer.invoke(IPC_CHANNELS.clearWizard) as Promise<void>,
    commitMainDirectory: (selectionId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.commitMainDirectory, selectionId),
    initializeMain: () => ipcRenderer.invoke(IPC_CHANNELS.initializeMain),
    launchMain: (options: LaunchMainOptions) =>
      ipcRenderer.invoke(IPC_CHANNELS.launchMain, options),
    ensureRuntime: () => ipcRenderer.invoke(IPC_CHANNELS.ensureRuntime),
  }),
  selectDirectory: () =>
    ipcRenderer.invoke(IPC_CHANNELS.selectDirectory) as Promise<
      NativeDirectorySelection | null
    >,
  getMainDirectorySelection: () =>
    ipcRenderer.invoke(IPC_CHANNELS.getMainDirectorySelection) as Promise<NativeDirectorySelection>,
  selectMainDirectoryPath: (path: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.selectMainDirectoryPath, path) as Promise<NativeDirectorySelection>,
  openExternal: (url: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.openExternal, url) as Promise<void>,
  openCopilotLogin: () =>
    ipcRenderer.invoke(IPC_CHANNELS.openCopilotLogin) as Promise<void>,
})

contextBridge.exposeInMainWorld('shadowDesktop', api)
