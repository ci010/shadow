import type { WizardEvent, WizardState } from './wizard/state-machine.js'
import type { BootstrapCommandResult } from './bootstrap/coordinator.js'
import type { EnsureRuntimeResult } from './bootstrap/coordinator.js'

export const IPC_CHANNELS = {
  loadWizard: 'shadow:bootstrap:load',
  dispatchWizard: 'shadow:bootstrap:dispatch',
  clearWizard: 'shadow:bootstrap:clear',
  commitMainDirectory: 'shadow:bootstrap:commit-main-directory',
  initializeMain: 'shadow:bootstrap:initialize-main',
  launchMain: 'shadow:bootstrap:launch-main',
  ensureRuntime: 'shadow:bootstrap:ensure-runtime',
  selectDirectory: 'shadow:native:select-directory',
  openExternal: 'shadow:native:open-external',
} as const

export interface NativeDirectorySelection {
  readonly selectionId: string
  readonly displayName: string
}

export interface LaunchMainOptions {
  readonly localExecutor: boolean
  readonly port: number
}

export interface ShadowDesktopApi {
  readonly bootstrap: {
    load(): Promise<WizardState>
    dispatch(event: WizardEvent): Promise<WizardState>
    clear(): Promise<void>
    commitMainDirectory(selectionId: string): Promise<BootstrapCommandResult>
    initializeMain(): Promise<BootstrapCommandResult>
    launchMain(options: LaunchMainOptions): Promise<BootstrapCommandResult>
    ensureRuntime(): Promise<EnsureRuntimeResult>
  }
  selectDirectory(): Promise<NativeDirectorySelection | null>
  openExternal(url: string): Promise<void>
}

export interface MainBootstrapInitializer {
  initializeMain(): Promise<BootstrapCommandResult>
}

export interface MainRuntimeEnsurer {
  ensureRuntime(): Promise<EnsureRuntimeResult>
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

export function parseSelectionId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) {
    throw new TypeError('Directory selection ID is invalid')
  }
  return value
}

export function parseNoArguments(values: readonly unknown[]): void {
  if (values.length !== 0) throw new TypeError('Bootstrap command accepts no arguments')
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