import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC_CHANNELS,
  type LaunchMainOptions,
  type NativeDirectorySelection,
  type ShadowDesktopApi,
} from './ipc-contract.js'
import type { WizardEvent, WizardState } from './wizard/state-machine.js'
import { createWindowControlsApi } from './window-controls-preload.js'
import { createFolderDirectoriesApi } from './folder-directories.js'
import { createChatContextApi } from './chat-context.js'
import { DOCUMENT_TAB_CHANNEL, receiveDocumentTabShortcuts } from './document-tabs.js'
import { createMediaCaptureApi } from './media-capture-preload.js'
import { createStartupDiagnosticsApi } from './startup-diagnostics-ipc.js'
import { createWebPairingApi } from './web-pairing-preload.js'

const disposeDocumentTabs = receiveDocumentTabShortcuts(ipcRenderer, (direction) => {
  window.dispatchEvent(new CustomEvent(DOCUMENT_TAB_CHANNEL, { detail: direction }))
})
window.addEventListener('unload', disposeDocumentTabs, { once: true })

const api: ShadowDesktopApi = Object.freeze({
  webPairing: createWebPairingApi(ipcRenderer),
  diagnostics: createStartupDiagnosticsApi(ipcRenderer),
  mediaCapture: createMediaCaptureApi(ipcRenderer, () => navigator.userActivation.isActive),
  windowControls: createWindowControlsApi(ipcRenderer),
  folders: createFolderDirectoriesApi(ipcRenderer),
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
