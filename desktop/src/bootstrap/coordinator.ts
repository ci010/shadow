import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import type { BootstrapStateStorage } from './storage.js'
import { isMissingRuntimeConfig, normalizeMainDirectoryPath, type RuntimeConfigReader, type RuntimeConfigWriter } from './runtime-config.js'
import { defaultMainDirectory } from './main-directory.js'
import type { NativeDirectorySelection } from '../ipc-contract.js'
import type { LaunchProfileStore, LaunchProfile } from './launch-profile.js'
import type { ChildBootstrap, ChildPairInput, ChildSetupInfo } from './child.js'
import type { MainAgentConfigInitializer } from './main-agent-config.js'
import { startupFailure, type StartupFailure } from '../sidecar/startup-diagnostics.js'
import {
  createWizardState,
  transitionWizard,
  type WizardEvent,
  type WizardState,
  type MainWizardState,
} from '../wizard/state-machine.js'

export interface MainRuntimeStartOptions {
  readonly role: 'main' | 'child'
  readonly port: number
  readonly localExecutor?: boolean
}

export interface MainRuntimeStatus {
  readonly phase: string
  readonly apiBase?: string
  readonly role?: 'main' | 'child'
  readonly kind?: string
  readonly elapsedMs?: number
}

export interface MainRuntimeHost {
  start(options: MainRuntimeStartOptions): Promise<MainRuntimeStatus>
}

export type BootstrapCommandResult =
  | { readonly ok: true; readonly state: WizardState }
  | { readonly ok: false; readonly code: 'invalid-state' | 'invalid-selection' | 'write-failed' | 'launch-failed'; readonly state: WizardState }

export interface MainRuntimeContext {
  readonly version: 1
  readonly mode: 'main'
  readonly localNodeId: string
  readonly mainConnection: 'connected'
  readonly mainLatencyMs: null
  readonly uiScopes: readonly ['chat:read', 'chat:write', 'knowledge:read', 'main:admin', 'nodes:admin', 'audit:read']
  readonly apiBase: string
}

export type EnsureRuntimeResult =
  | { readonly ok: true; readonly context: MainRuntimeContext | ChildRuntimeContext }
  | { readonly ok: false; readonly code: 'invalid-state' | 'profile-missing' | 'runtime-unavailable'; readonly failure?: StartupFailure }

export interface ChildRuntimeContext {
  readonly version: 1
  readonly mode: 'child'
  readonly localNodeId: string
  readonly mainConnection: 'connecting'
  readonly mainLatencyMs: null
  readonly uiScopes: readonly []
  readonly apiBase: string
}
const MAIN_UI_SCOPES = [
  'chat:read',
  'chat:write',
  'knowledge:read',
  'main:admin',
  'nodes:admin',
  'audit:read',
] as const

const PRIVILEGED_EVENTS = new Set<WizardEvent['type']>([
  'data-directory-selected',
  'main-initialized',
  'sidecar-ready',
  'pairing-offer-entered',
  'fingerprint-verified',
  'device-named',
  'child-capabilities-selected',
])

export class BootstrapCoordinator {
  private readonly selections = new Map<string, string>()
  private selectedDirectory: string | undefined
  private operation: Promise<unknown> = Promise.resolve()
  private switchingRole = false

  constructor(
    private readonly storage: BootstrapStateStorage,
    private readonly configWriter: RuntimeConfigWriter,
    private readonly mainAgentConfigInitializer: MainAgentConfigInitializer,
    private readonly runtimeHost: MainRuntimeHost,
    private readonly launchProfiles: LaunchProfileStore,
    private readonly configReader: RuntimeConfigReader,
    private readonly getDefaultDirectory: () => string = defaultMainDirectory,
    private readonly childBootstrap?: ChildBootstrap,
    private readonly validateMainDirectory?: (paths: readonly string[]) => Promise<void>,
  ) {}

  registerDirectorySelection(selectionId: string, absolutePath: string): void {
    this.selections.set(selectionId, absolutePath)
    this.selectedDirectory = absolutePath
  }

  getMainDirectorySelection(): Promise<NativeDirectorySelection> {
    return this.serialize(async () => {
      await this.requireDirectoryStep()
      let path = this.selectedDirectory
      if (path === undefined) {
        try {
          path = (await this.configReader.readMain()).dataDir
        } catch (error) {
          if (!isMissingRuntimeConfig(error)) throw new Error('Saved Main directory could not be loaded')
          path = this.getDefaultDirectory()
        }
      }
      return this.createDirectorySelection(path)
    })
  }

  selectMainDirectoryPath(path: string): Promise<NativeDirectorySelection> {
    return this.serialize(async () => {
      await this.requireDirectoryStep()
      return this.createDirectorySelection(path)
    })
  }

  private async requireDirectoryStep(): Promise<void> {
    const current = await this.load()
    if (current.mode !== 'main' || current.step !== 'choose-data-directory') {
      throw new TypeError('Main directory selection is only available during directory setup')
    }
  }

  private createDirectorySelection(path: string): NativeDirectorySelection {
    const displayPath = normalizeMainDirectoryPath(path)
    const selectionId = randomUUID()
    this.registerDirectorySelection(selectionId, displayPath)
    return { selectionId, displayName: basename(displayPath), displayPath }
  }

  async load(): Promise<WizardState> {
    return await this.storage.load() ?? createWizardState()
  }

  dispatch(event: WizardEvent): Promise<WizardState> {
    if (PRIVILEGED_EVENTS.has(event.type)) {
      return Promise.reject(new TypeError('Wizard event requires a dedicated bootstrap command'))
    }
    return this.serialize(async () => {
      const current = await this.load()
      const next = transitionWizard(current, event)
      await this.storage.save(next)
      return next
    })
  }

  clear(): Promise<void> {
    return this.serialize(async () => {
      if ((await this.load()).mode === 'child') throw new Error('Child identity is retained; retry setup or runtime instead of resetting')
      await this.storage.clear()
    })
  }

  childSetup(): Promise<ChildSetupInfo> {
    return this.serialize(async () => {
      if ((await this.load()).mode !== 'child' || !this.childBootstrap) throw new Error('Child setup is unavailable')
      return this.childBootstrap.info()
    })
  }

  pairChild(input: ChildPairInput): Promise<BootstrapCommandResult> {
    return this.serialize(async () => {
      const current = await this.load()
      if (current.mode !== 'child' || current.step === 'complete' || !this.childBootstrap) {
        return { ok: false, code: 'invalid-state', state: current }
      }
      await this.childBootstrap.pair(input)
      await this.launchProfiles.save({ version: 1, role: 'child', port: 43124 })
      const next: WizardState = { ...current, step: 'complete', revision: current.revision + 1 }
      await this.storage.save(next)
      return { ok: true, state: next }
    })
  }

  commitMainDirectory(selectionId: string): Promise<BootstrapCommandResult> {
    return this.serialize(async () => {
      const current = await this.load()
      if (current.mode !== 'main' || current.step !== 'choose-data-directory') {
        return { ok: false, code: 'invalid-state', state: current }
      }
      const dataDir = this.selections.get(selectionId)
      if (dataDir === undefined) {
        return { ok: false, code: 'invalid-selection', state: current }
      }
      await this.validateMainDirectory?.([dataDir])
      this.selections.delete(selectionId)
      try {
        await this.configWriter.writeMain(dataDir)
        const next = transitionWizard(current, { type: 'data-directory-selected' })
        await this.storage.save(next)
        return { ok: true, state: next }
      } catch (error) {
        return { ok: false, code: 'write-failed', state: current }
      }
    })
  }

  initializeMain(): Promise<BootstrapCommandResult> {
    return this.serialize(async () => {
      const current = await this.load()
      if (current.mode !== 'main' || current.step !== 'initialize-main') {
        return { ok: false, code: 'invalid-state', state: current }
      }
      try {
        await this.mainAgentConfigInitializer.initialize()
        const next = transitionWizard(current, { type: 'main-initialized' })
        await this.storage.save(next)
        return { ok: true, state: next }
      } catch (error) {
        return { ok: false, code: 'write-failed', state: current }
      }
    })
  }

  /** Start the authenticated backend for provider HTTP setup without completing the wizard. */
  prepareProvider(options: { readonly localExecutor: boolean; readonly port: number }): Promise<EnsureRuntimeResult> {
    return this.serialize(async () => {
      const current = await this.load()
      if (current.mode !== 'main' || (current.step !== 'configure-provider' && current.step !== 'launch-main')) {
        return { ok: false, code: 'invalid-state' }
      }
      try {
        const launchOptions = await this.mainLaunchOptions(current, options)
        await this.launchProfiles.save({ version: 1, role: 'main', ...launchOptions })
      } catch {
        return { ok: false, code: 'runtime-unavailable' }
      }
      return this.ensureRuntimeForState(current)
    })
  }

  private async mainLaunchOptions(
    current: MainWizardState,
    options: { readonly localExecutor: boolean; readonly port: number },
  ): Promise<{ readonly localExecutor: boolean; readonly port: number }> {
    const profile = await this.launchProfiles.load()
    if (profile && profile.role !== 'main') throw new Error('Saved launch role does not match Main setup')
    // Keep resumed/prepared runtimes stable when an older renderer sends defaults.
    return {
      port: profile?.port ?? options.port,
      localExecutor: current.localExecutor ?? profile?.localExecutor ?? options.localExecutor,
    }
  }

  launchMain(options: { readonly localExecutor: boolean; readonly port: number }): Promise<BootstrapCommandResult> {
    return this.serialize(async () => {
      const current = await this.load()
      if (current.mode !== 'main' || current.step !== 'launch-main') {
        return { ok: false, code: 'invalid-state', state: current }
      }
      try {
        const launchOptions = await this.mainLaunchOptions(current, options)
        await this.launchProfiles.save({ version: 1, role: 'main', ...launchOptions })
        const status = await this.runtimeHost.start({ role: 'main', ...launchOptions })
        if (status.phase !== 'ready') return { ok: false, code: 'launch-failed', state: current }
        const next = transitionWizard(current, { type: 'sidecar-ready' })
        await this.storage.save(next)
        return { ok: true, state: next }
      } catch {
        return { ok: false, code: 'launch-failed', state: current }
      }
    })
  }

  ensureRuntime(): Promise<EnsureRuntimeResult> {
    return this.serialize(async () => this.ensureRuntimeForState(await this.load()))
  }

  private async ensureRuntimeForState(current: WizardState): Promise<EnsureRuntimeResult> {
    if (current.mode === null || (current.step !== 'complete'
      && !(current.mode === 'main' && (current.step === 'configure-provider' || current.step === 'launch-main')))) {
      return { ok: false, code: 'invalid-state' }
    }

    let profile: LaunchProfile | null
    try {
      profile = await this.launchProfiles.load()
    } catch {
      return { ok: false, code: 'runtime-unavailable' }
    }
    if (profile === null) return { ok: false, code: 'profile-missing' }
    if (profile.role !== current.mode) return { ok: false, code: 'runtime-unavailable' }

    try {
      const config = current.mode === 'child'
        ? await this.childBootstrap?.readConfig()
        : await this.configReader.readMain()
      if (!config) return { ok: false, code: 'runtime-unavailable' }
      if (current.mode === 'main') await this.validateMainDirectory?.([config.dataDir])
      const status = await this.runtimeHost.start(profile)
      if (status.phase !== 'ready' || status.apiBase === undefined) {
        const failure = startupFailure(status)
        return { ok: false, code: 'runtime-unavailable', ...(failure ? { failure } : {}) }
      }
      if (current.mode === 'child') return {
        ok: true,
        context: { version: 1, mode: 'child', localNodeId: config.localNodeId,
          mainConnection: 'connecting', mainLatencyMs: null, uiScopes: [], apiBase: status.apiBase },
      }
      return {
        ok: true,
        context: {
          version: 1,
          mode: 'main',
          localNodeId: config.localNodeId,
          mainConnection: 'connected',
          mainLatencyMs: null,
          uiScopes: MAIN_UI_SCOPES,
          apiBase: status.apiBase,
        },
      }
    } catch {
      return { ok: false, code: 'runtime-unavailable' }
    }
  }

  /** Serialize with setup/start commands; once stopping begins, only reopening the app can resume. */
  switchRole(target: 'main' | 'child', stopAndSelect: (current: 'main' | 'child') => Promise<void>): Promise<void> {
    return this.serialize(async () => {
      const current = await this.load()
      if (!current.mode || current.mode === target) throw new Error('Choose a different desktop role')
      this.switchingRole = true
      await stopAndSelect(current.mode)
    })
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const guarded = () => {
      if (this.switchingRole) throw new Error('Desktop role switch is in progress. Close and reopen Shadow if it could not restart.')
      return operation()
    }
    const result = this.operation.then(guarded, guarded)
    this.operation = result.then(() => undefined, () => undefined)
    return result
  }
}