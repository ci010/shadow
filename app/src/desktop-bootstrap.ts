import { t } from './i18n.ts'
import type { InstallationContextV1 } from './installation-context.ts'
import { parseRuntimeFailure, type RuntimeFailure } from './runtime-recovery.ts'
import type { DesktopWebPairingApi } from '../../desktop/src/web-pairing-contract.ts'
import type { ChildPairInput, ChildSetupInfo } from '../../desktop/src/bootstrap/child.ts'
import type { DesktopMicroAppsApi } from '../../desktop/src/micro-app-contract.ts'
import type { DesktopTaskNotificationsApi } from '../../desktop/src/task-notifications-contract.ts'

export type InstallationMode = 'main' | 'child'

export type MainWizardStep =
	| 'choose-role'
	| 'choose-data-directory'
	| 'initialize-main'
	| 'configure-provider'
	| 'choose-local-capabilities'
	| 'launch-main'
	| 'complete'

export type ChildWizardStep =
	| 'choose-role'
	| 'enter-pairing-offer'
	| 'verify-fingerprint'
	| 'name-device'
	| 'choose-capabilities'
	| 'launch-child'
	| 'complete'

export type WizardState =
	| { readonly version: 1; readonly revision: number; readonly mode: null; readonly step: 'choose-role' }
	| { readonly version: 1; readonly revision: number; readonly mode: 'main'; readonly step: MainWizardStep }
	| { readonly version: 1; readonly revision: number; readonly mode: 'child'; readonly step: ChildWizardStep }

export type RendererWizardEvent =
	| { readonly type: 'select-role'; readonly mode: InstallationMode }
	| { readonly type: 'provider-configured' }
	| { readonly type: 'local-capabilities-selected' }

export type BootstrapCommandResult =
	| { readonly ok: true; readonly state: WizardState }
	| {
		readonly ok: false
		readonly code: 'invalid-state' | 'invalid-selection' | 'write-failed' | 'initialize-failed' | 'launch-failed'
		readonly state: WizardState
	}

export interface NativeDirectorySelection {
	readonly selectionId: string
	readonly displayName: string
	readonly displayPath?: string
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
	readonly fileExplorer?: import('../../desktop/src/file-explorer-contract.ts').DesktopFileExplorerApi
	readonly taskNotifications?: DesktopTaskNotificationsApi
	readonly clipboardFiles?: {
		readFiles(): Promise<Array<{ name: string; bytes: Uint8Array; lastModified: number }>>
	}
	readonly microApps?: DesktopMicroAppsApi
	readonly webPairing?: DesktopWebPairingApi
	readonly diagnostics?: {
		revealStartupLog(): Promise<void>
	}
	readonly windowControls?: DesktopWindowControls
	readonly folders?: {
		selectDirectory(): Promise<string | null>
	}
	readonly chatContext?: {
		readonly selectFiles: () => Promise<string[]>
		readonly selectFolders: () => Promise<string[]>
	}
	readonly bootstrap: {
		load(): Promise<WizardState>
		dispatch(event: RendererWizardEvent): Promise<WizardState>
		clear?(): Promise<void>
		commitMainDirectory(selectionId: string): Promise<BootstrapCommandResult>
		initializeMain(): Promise<BootstrapCommandResult>
		launchMain(options: { readonly localExecutor: boolean; readonly port: number }): Promise<BootstrapCommandResult>
		ensureRuntime(): Promise<EnsureRuntimeResult>
		childSetup?(): Promise<ChildSetupInfo>
		pairChild?(input: ChildPairInput): Promise<BootstrapCommandResult>
	}
	selectDirectory(): Promise<NativeDirectorySelection | null>
	getMainDirectorySelection?(): Promise<NativeDirectorySelection>
	selectMainDirectoryPath?(path: string): Promise<NativeDirectorySelection>
	openCopilotLogin?(): Promise<void>
	openExternal?(url: string): Promise<void>
}

export type EnsureRuntimeResult =
	| { readonly ok: true; readonly context: InstallationContextV1 }
	| {
		readonly ok: false
		readonly code: 'invalid-state' | 'profile-missing' | 'runtime-unavailable'
		readonly failure?: RuntimeFailure
	}

export type RendererBootstrapOutcome =
	| { readonly view: 'app'; readonly context: InstallationContextV1 }
	| { readonly view: 'wizard'; readonly initialState: WizardState | null; readonly loadError: boolean }
	| { readonly view: 'runtime-recovery'; readonly role?: InstallationMode; readonly code?: string; readonly failure?: RuntimeFailure }

declare global {
	interface Window {
		readonly shadowDesktop?: ShadowDesktopApi
	}
}

export const MAIN_LAUNCH_PORT = 43_123

export async function loadMainDirectorySelection(
	api: ShadowDesktopApi,
	current: NativeDirectorySelection | null,
): Promise<NativeDirectorySelection | null> {
	return current ?? await api.getMainDirectorySelection?.() ?? null
}

export async function commitMainDirectoryChoice(
	api: ShadowDesktopApi,
	path: string,
	current: NativeDirectorySelection | null,
): Promise<BootstrapCommandResult> {
	const selection = api.selectMainDirectoryPath
		? await api.selectMainDirectoryPath(path)
		: current
	if (!selection) throw new Error(t('Choose a Main directory first'))
	return await api.bootstrap.commitMainDirectory(selection.selectionId)
}

export function isBootstrapComplete(state: WizardState): boolean {
	return state.step === 'complete'
}

export function shouldShowFirstRun(state: WizardState): boolean {
	return !isBootstrapComplete(state)
}

export async function loadDesktopBootstrap(api: ShadowDesktopApi): Promise<WizardState> {
	return await api.bootstrap.load()
}

export function browserBootstrap(context: InstallationContextV1): RendererBootstrapOutcome {
	return { view: 'app', context }
}

export async function resolveDesktopBootstrap(api: ShadowDesktopApi): Promise<RendererBootstrapOutcome> {
	let initialState: WizardState
	try {
		initialState = await loadDesktopBootstrap(api)
	} catch {
		return { view: 'wizard', initialState: null, loadError: true }
	}

	if (shouldShowFirstRun(initialState)) {
		return { view: 'wizard', initialState, loadError: false }
	}

	try {
		const runtime = await api.bootstrap.ensureRuntime()
		if (runtime.ok) return { view: 'app', context: runtime.context }
		const failure = parseRuntimeFailure(runtime.failure)
		return {
			view: 'runtime-recovery',
			role: failure?.role ?? initialState.mode ?? undefined,
			code: runtime.code,
			...(failure ? { failure } : {}),
		}
	} catch {
		return { view: 'runtime-recovery', role: initialState.mode ?? undefined }
	}
}