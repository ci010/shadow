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
import { observeComposerMicrophoneGesture } from './composer-microphone-gesture.js'
import { createStartupDiagnosticsApi } from './startup-diagnostics-ipc.js'
import { createWebPairingApi } from './web-pairing-preload.js'
import type { ChildPairInput } from './bootstrap/child.js'
import { MICRO_APP_CHANNELS, parseMicroAppIdentity, type MicroAppIdentity } from './micro-app-contract.js'
import { createPasteClipboardFilesApi } from './clipboard-files-contract.js'
import { createTaskNotificationsApi } from './task-notifications-contract.js'
import { createFileExplorerApi } from './file-explorer-contract.js'

const disposeDocumentTabs = receiveDocumentTabShortcuts(ipcRenderer, (direction) => {
  window.dispatchEvent(new CustomEvent(DOCUMENT_TAB_CHANNEL, { detail: direction }))
})
window.addEventListener('unload', disposeDocumentTabs, { once: true })

const api: ShadowDesktopApi = Object.freeze({
  fileExplorer: createFileExplorerApi(ipcRenderer),
  taskNotifications: createTaskNotificationsApi(ipcRenderer),
  clipboardFiles: createPasteClipboardFilesApi(ipcRenderer, window),
  microApps: Object.freeze({
    open: (identity: MicroAppIdentity) => ipcRenderer.invoke(MICRO_APP_CHANNELS.open, parseMicroAppIdentity(identity)),
    refresh: () => ipcRenderer.invoke(MICRO_APP_CHANNELS.refresh),
  }),
  webPairing: createWebPairingApi(ipcRenderer),
  diagnostics: createStartupDiagnosticsApi(ipcRenderer),
  mediaCapture: createMediaCaptureApi(ipcRenderer, () => navigator.userActivation.isActive, observeComposerMicrophoneGesture(window, document).consume),
  windowControls: createWindowControlsApi(ipcRenderer),
  folders: createFolderDirectoriesApi(ipcRenderer),
  chatContext: createChatContextApi(ipcRenderer),
  bootstrap: Object.freeze({
    switchRole: (role: 'main' | 'child', executionConsent: boolean) => ipcRenderer.invoke(IPC_CHANNELS.switchRole, role, executionConsent),
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
    prepareProvider: (options: LaunchMainOptions) =>
      ipcRenderer.invoke(IPC_CHANNELS.prepareProvider, options),
    ensureRuntime: () => ipcRenderer.invoke(IPC_CHANNELS.ensureRuntime),
    retryRuntime: () => ipcRenderer.invoke(IPC_CHANNELS.retryRuntime),
    childSetup: () => ipcRenderer.invoke(IPC_CHANNELS.childSetup),
    pairChild: (input: ChildPairInput) => ipcRenderer.invoke(IPC_CHANNELS.pairChild, input),
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
  copilotLoginHostSupport: true,
  openCopilotLogin: (verificationUri: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.openCopilotLogin, verificationUri) as Promise<void>,
})

contextBridge.exposeInMainWorld('shadowDesktop', api)
