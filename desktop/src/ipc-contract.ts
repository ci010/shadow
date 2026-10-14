import type { DataLayoutView } from './bootstrap/data-layout-controller.js'
import type { WizardEvent, WizardState } from './wizard/state-machine.js'
import type { BootstrapCommandResult } from './bootstrap/coordinator.js'
import type { EnsureRuntimeResult } from './bootstrap/coordinator.js'
import type { DesktopMediaCaptureApi } from './media-capture-contract.js'
import type { DesktopWebPairingApi } from './web-pairing-contract.js'
import type { ChildPairInput, ChildSetupInfo } from './bootstrap/child.js'
import type { DesktopMicroAppsApi } from './micro-app-contract.js'
import type { DesktopClipboardFilesApi } from './clipboard-files-contract.js'
import type { DesktopTaskNotificationsApi } from './task-notifications-contract.js'
import type { DesktopFileExplorerApi } from './file-explorer-contract.js'

export const IPC_CHANNELS = {
  dataLayoutStatus: 'shadow:bootstrap:data-layout-status',
  upgradeDataLayout: 'shadow:bootstrap:upgrade-data-layout',
  loadWizard: 'shadow:bootstrap:load',
  dispatchWizard: 'shadow:bootstrap:dispatch',
  clearWizard: 'shadow:bootstrap:clear',
  commitMainDirectory: 'shadow:bootstrap:commit-main-directory',
  initializeMain: 'shadow:bootstrap:initialize-main',
  launchMain: 'shadow:bootstrap:launch-main',
  prepareProvider: 'shadow:bootstrap:prepare-provider',
  ensureRuntime: 'shadow:bootstrap:ensure-runtime',
  retryRuntime: 'shadow:bootstrap:retry-runtime',
  childSetup: 'shadow:bootstrap:child-setup',
  pairChild: 'shadow:bootstrap:pair-child',
  selectDirectory: 'shadow:native:select-directory',
  selectFolderDirectory: 'shadow:folders:select-directory',
  selectChatContextFiles: 'shadow:chat-context:select-files',
  selectChatContextFolders: 'shadow:chat-context:select-folders',
  getMainDirectorySelection: 'shadow:bootstrap:get-main-directory-selection',
  selectMainDirectoryPath: 'shadow:bootstrap:select-main-directory-path',
  openExternal: 'shadow:native:open-external',
  openCopilotLogin: 'shadow:native:open-copilot-login',
  revealStartupLog: 'shadow:diagnostics:reveal-startup-log',
  createWebPairing: 'shadow:web-pairing:create',
  windowGetState: 'shadow:window:get-state',
  windowMinimize: 'shadow:window:minimize',
  windowToggleMaximize: 'shadow:window:toggle-maximize',
  windowClose: 'shadow:window:close',
  windowStateChanged: 'shadow:window:state-changed',
} as const

export interface NativeDirectorySelection {
  readonly selectionId: string
  readonly displayName: string
  readonly displayPath?: string
}

export interface LaunchMainOptions {
  readonly localExecutor: boolean
  readonly port: number
}

export interface DesktopWindowState {
  readonly maximized: boolean
}

export interface DesktopWindowControls {
  getState(): Promise<DesktopWindowState>
  minimize(): Promise<void>
  toggleMaximize(): Promise<DesktopWindowState>
  close(): Promise<void>
  onStateChanged(listener: (state: DesktopWindowState) => void): () => void
}

export interface ShadowDesktopApi {
  readonly fileExplorer: DesktopFileExplorerApi
  readonly taskNotifications: DesktopTaskNotificationsApi
  readonly clipboardFiles: DesktopClipboardFilesApi
  readonly microApps: DesktopMicroAppsApi
  readonly webPairing: DesktopWebPairingApi
  readonly diagnostics: {
    revealStartupLog(): Promise<void>
  }
  readonly mediaCapture: DesktopMediaCaptureApi
  readonly windowControls: DesktopWindowControls
  readonly folders: {
    selectDirectory(): Promise<string | null>
  }
  readonly chatContext: {
    readonly selectFiles: () => Promise<string[]>
    readonly selectFolders: () => Promise<string[]>
  }
  readonly bootstrap: {
    dataLayoutStatus(): Promise<DataLayoutView | null>
    upgradeDataLayout(): Promise<DataLayoutView>
    load(): Promise<WizardState>
    dispatch(event: WizardEvent): Promise<WizardState>
    clear(): Promise<void>
    commitMainDirectory(selectionId: string): Promise<BootstrapCommandResult>
    initializeMain(): Promise<BootstrapCommandResult>
    launchMain(options: LaunchMainOptions): Promise<BootstrapCommandResult>
    prepareProvider(options: LaunchMainOptions): Promise<EnsureRuntimeResult>
    ensureRuntime(): Promise<EnsureRuntimeResult>
    retryRuntime(): Promise<EnsureRuntimeResult>
    childSetup(): Promise<ChildSetupInfo>
    pairChild(input: ChildPairInput): Promise<BootstrapCommandResult>
  }

  selectDirectory(): Promise<NativeDirectorySelection | null>
  getMainDirectorySelection(): Promise<NativeDirectorySelection>
  selectMainDirectoryPath(path: string): Promise<NativeDirectorySelection>
  openExternal(url: string): Promise<void>
  readonly copilotLoginHostSupport?: boolean
  openCopilotLogin(verificationUri: string): Promise<void>
}

export function parseDesktopWindowState(value: unknown): DesktopWindowState {
  if (
    typeof value !== 'object'
    || value === null
    || Array.isArray(value)
    || Object.keys(value).length !== 1
    || !Object.hasOwn(value, 'maximized')
    || typeof (value as Record<string, unknown>).maximized !== 'boolean'
  ) {
    throw new TypeError('Desktop window state is invalid')
  }
  return { maximized: (value as Record<string, unknown>).maximized as boolean }
}

export interface MainBootstrapInitializer {
  initializeMain(): Promise<BootstrapCommandResult>
}

export interface MainRuntimeEnsurer {
  ensureRuntime(): Promise<EnsureRuntimeResult>
}

export interface MainDirectorySelector {
  getMainDirectorySelection(): Promise<NativeDirectorySelection>
  selectMainDirectoryPath(path: string): Promise<NativeDirectorySelection>
}

export function handleGetMainDirectorySelection(
  coordinator: MainDirectorySelector,
  rawArguments: readonly unknown[],
): Promise<NativeDirectorySelection> {
  parseNoArguments(rawArguments)
  return coordinator.getMainDirectorySelection()
}

export function handleInitializeMain(
  coordinator: MainBootstrapInitializer,
  rawArguments: readonly unknown[],
): Promise<BootstrapCommandResult> {
  parseNoArguments(rawArguments)
  return coordinator.initializeMain()
}

export function handleEnsureRuntime(
  coordinator: MainRuntimeEnsurer,
  rawArguments: readonly unknown[],
): Promise<EnsureRuntimeResult> {
  parseNoArguments(rawArguments)
  return coordinator.ensureRuntime()
}

export function handlePrepareProvider(
  coordinator: { prepareProvider(options: LaunchMainOptions): Promise<EnsureRuntimeResult> },
  rawArguments: readonly unknown[],
): Promise<EnsureRuntimeResult> {
  if (rawArguments.length !== 1) throw new TypeError('Provider preparation requires one options object')
  return coordinator.prepareProvider(parseLaunchMainOptions(rawArguments[0]))
}

export function parseSelectionId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) {
    throw new TypeError('Directory selection ID is invalid')
  }
  return value
}

export function parseNoArguments(values: readonly unknown[]): void {
  if (values.length !== 0) throw new TypeError('Bootstrap command accepts no arguments')
}

export async function handleOpenCopilotLogin(
  open: (url: string) => Promise<void>,
  rawArguments: readonly unknown[],
): Promise<void> {
  // Match the raw string: URL parsing would hide explicit :443, dot segments,
  // whitespace and other spellings that must not cross this privileged boundary.
  const uri = rawArguments[0]
  if (rawArguments.length !== 1 || typeof uri !== 'string'
    || !/^https:\/\/(?:github\.com|(?!xn--)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ghe\.com)\/login\/device$/.test(uri)
    || /\s/.test(uri)) {
    throw new TypeError('Copilot login requires one trusted HTTPS device verification URI')
  }
  await open(uri)
}

export function parseLaunchMainOptions(value: unknown): LaunchMainOptions {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Main launch options are invalid')
  }
  const candidate = value as Record<string, unknown>
  if (
    Object.keys(candidate).some((field) => !['localExecutor', 'port'].includes(field))
    || typeof candidate.localExecutor !== 'boolean'
    || !Number.isSafeInteger(candidate.port)
    || (candidate.port as number) < 1
    || (candidate.port as number) > 65_535
  ) {
    throw new TypeError('Main launch options are invalid')
  }
  return {
    localExecutor: candidate.localExecutor,
    port: candidate.port as number,
  }
}