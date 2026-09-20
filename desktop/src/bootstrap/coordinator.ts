import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import type { BootstrapStateStorage } from './storage.js'
import { isMissingRuntimeConfig, normalizeMainDirectoryPath, type RuntimeConfigReader, type RuntimeConfigWriter } from './runtime-config.js'
import { defaultMainDirectory } from './main-directory.js'
import type { NativeDirectorySelection } from '../ipc-contract.js'
import type { LaunchProfileStore, MainLaunchProfile } from './launch-profile.js'
import type { MainAgentConfigInitializer } from './main-agent-config.js'
import { startupFailure, type StartupFailure } from '../sidecar/startup-diagnostics.js'
import {
  createWizardState,
  transitionWizard,
  type WizardEvent,
  type WizardState,
} from '../wizard/state-machine.js'

export interface MainRuntimeStartOptions {
  readonly role: 'main'
  readonly port: number
  readonly localExecutor: boolean
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
  | { readonly ok: true; readonly context: MainRuntimeContext }
  | { readonly ok: false; readonly code: 'invalid-state' | 'profile-missing' | 'runtime-unavailable'; readonly failure?: StartupFailure }

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
])

export class BootstrapCoordinator {
  private readonly selections = new Map<string, string>()
  private selectedDirectory: string | undefined
  private operation: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly storage: BootstrapStateStorage,
    private readonly configWriter: RuntimeConfigWriter,
    private readonly mainAgentConfigInitializer: MainAgentConfigInitializer,
    private readonly runtimeHost: MainRuntimeHost,
    private readonly launchProfiles: LaunchProfileStore,
    private readonly configReader: RuntimeConfigReader,
    private readonly getDefaultDirectory: () => string = defaultMainDirectory,
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
    return this.serialize(() => this.storage.clear())
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
      this.selections.delete(selectionId)
      try {
        await this.configWriter.writeMain(dataDir)
        const next = transitionWizard(current, { type: 'data-directory-selected' })
        await this.storage.save(next)
        return { ok: true, state: next }
      } catch {
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
      } catch {
        return { ok: false, code: 'write-failed', state: current }
      }
    })
  }

  launchMain(options: { readonly localExecutor: boolean; readonly port: number }): Promise<BootstrapCommandResult> {
    return this.serialize(async () => {
      const current = await this.load()
      if (current.mode !== 'main' || current.step !== 'launch-main') {
        return { ok: false, code: 'invalid-state', state: current }
      }
      try {
        await this.launchProfiles.save({ version: 1, role: 'main', ...options })
        const status = await this.runtimeHost.start({ role: 'main', ...options })
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
    return this.serialize(async () => {
      const current = await this.load()
      if (current.mode !== 'main' || (current.step !== 'launch-main' && current.step !== 'complete')) {
        return { ok: false, code: 'invalid-state' }
      }

      let profile: MainLaunchProfile | null
      try {
        profile = await this.launchProfiles.load()
      } catch {
        return { ok: false, code: 'runtime-unavailable' }
      }
      if (profile === null) return { ok: false, code: 'profile-missing' }

      try {
        const config = await this.configReader.readMain()
        const status = await this.runtimeHost.start(profile)
        if (status.phase !== 'ready' || status.apiBase === undefined) {
          const failure = startupFailure(status)
          return { ok: false, code: 'runtime-unavailable', ...(failure ? { failure } : {}) }
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
    })
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation)
    this.operation = result.then(() => undefined, () => undefined)
    return result
  }
}