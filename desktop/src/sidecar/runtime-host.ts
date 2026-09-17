import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import type { ServiceConnection } from '../service/connection.js'
import { ServiceAttachmentSupervisor } from '../service/supervisor.js'
import {
  createAuthenticatedShutdownRequest,
  createSidecarReadinessProbe,
} from './local-control-client.js'
import {
  NodeSidecarSupervisor,
  type SidecarRole,
  type SidecarStartRequest,
  type SidecarStatus,
  type SidecarSupervisor,
} from './supervisor.js'
import {
  normalizeLoopbackOrigin,
  type RuntimeAuthorizationChanged,
} from '../runtime-authorization.js'

export interface RuntimePathsInput {
  readonly executablePath: string
  readonly appPath: string
  readonly resourcesPath: string
  readonly userDataPath: string
  readonly packaged: boolean
}

export interface RuntimePaths {
  readonly executablePath: string
  readonly entryPath: string
  readonly configPath: string
}

export interface RuntimeLaunchOptions {
  readonly role: SidecarRole
  readonly port: number
  readonly localExecutor?: boolean
}

export type RuntimeTokenFactory = () => string
export type RuntimeSupervisorFactory = (role: SidecarRole) => SidecarSupervisor

export interface RuntimeHostOptions {
  readonly paths: RuntimePathsInput
  readonly supervisorFactory: RuntimeSupervisorFactory
  readonly tokenFactory?: RuntimeTokenFactory
  readonly onAuthorizationChanged?: RuntimeAuthorizationChanged
  readonly revalidateOnStart?: boolean
}

export interface QuitEvent {
  preventDefault(): void
}

export interface QuitApp {
  on(event: 'before-quit', listener: (event: QuitEvent) => void): unknown
  quit(): void
}

export function resolveRuntimePaths(input: RuntimePathsInput): RuntimePaths {
  return {
    executablePath: input.executablePath,
    entryPath: input.packaged
      ? join(input.resourcesPath, 'backend', 'dist', 'src', 'index.js')
      : join(input.appPath, '..', 'dist', 'src', 'index.js'),
    configPath: join(input.userDataPath, 'bootstrap', 'runtime-config.v1.json'),
  }
}

export function createRuntimeLaunchToken(): string {
  return randomBytes(32).toString('base64url')
}

export class RuntimeHost {
  private readonly paths: RuntimePaths
  private readonly tokenFactory: RuntimeTokenFactory
  private supervisor: SidecarSupervisor | undefined
  private launchRequest: SidecarStartRequest | undefined
  private startPromise: Promise<SidecarStatus> | undefined
  private stopPromise: Promise<void> | undefined
  private stopping = false

  constructor(private readonly options: RuntimeHostOptions) {
    this.paths = resolveRuntimePaths(options.paths)
    this.tokenFactory = options.tokenFactory ?? createRuntimeLaunchToken
  }

  get status(): SidecarStatus {
    return this.supervisor?.status ?? { phase: 'stopped' }
  }

  get apiBase(): string | undefined {
    return this.status.phase === 'ready' ? this.status.apiBase : undefined
  }

  start(options: RuntimeLaunchOptions): Promise<SidecarStatus> {
    if (this.stopping) throw new Error('Runtime host is stopping')
    if (this.launchRequest) {
      this.assertSameLaunch(options)
      if (this.startPromise) return this.startPromise
      if (!this.options.revalidateOnStart) return Promise.resolve(this.status)
    }

    const request: SidecarStartRequest = this.launchRequest ?? {
      role: options.role,
      executablePath: this.paths.executablePath,
      entryPath: this.paths.entryPath,
      configPath: this.paths.configPath,
      launchToken: this.tokenFactory(),
      port: options.port,
      ...(options.localExecutor === undefined
        ? {}
        : { localExecutor: options.localExecutor }),
    }
    this.launchRequest = request
    this.supervisor ??= this.options.supervisorFactory(options.role)
    this.startPromise = this.supervisor.start(request).then((status) => {
      if (this.stopping) throw new Error('Runtime host stopped during startup')
      if (status.phase !== 'ready') {
        this.clearFailedStart(request)
        return status
      }
      const apiBase = normalizeLoopbackOrigin(status.apiBase)
      if (apiBase === null) {
        throw new Error('Runtime returned an invalid API origin')
      }
      this.options.onAuthorizationChanged?.({
        apiBase,
        launchToken: request.launchToken,
      })
      return { ...status, apiBase }
    }).catch((error: unknown) => {
      this.clearFailedStart(request)
      throw error
    }).finally(() => {
      if (this.options.revalidateOnStart) this.startPromise = undefined
    })
    return this.startPromise
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    this.stopping = true
    this.stopPromise = this.stopActiveRuntime()
    return this.stopPromise
  }

  private assertSameLaunch(options: RuntimeLaunchOptions): void {
    const active = this.launchRequest!
    if (
      active.role !== options.role ||
      active.port !== options.port ||
      Boolean(active.localExecutor) !== Boolean(options.localExecutor)
    ) {
      throw new Error(
        'Runtime launch role or configuration cannot change while active',
      )
    }
  }

  private async stopActiveRuntime(): Promise<void> {
    this.options.onAuthorizationChanged?.(null)
    const supervisor = this.supervisor
    if (!supervisor) return
    await supervisor.stop()
  }

  private clearFailedStart(request: SidecarStartRequest): void {
    this.options.onAuthorizationChanged?.(null)
    if (this.launchRequest !== request) return
    this.launchRequest = undefined
    this.startPromise = undefined
    this.supervisor = undefined
  }
}

export function createProductionRuntimeHost(
  paths: RuntimePathsInput,
  onAuthorizationChanged?: RuntimeAuthorizationChanged,
  serviceConnection?: ServiceConnection,
): RuntimeHost {
  if (serviceConnection) {
    return new RuntimeHost({
      paths,
      revalidateOnStart: true,
      tokenFactory: () => serviceConnection.launchToken,
      supervisorFactory: () => new ServiceAttachmentSupervisor(
        serviceConnection,
        createSidecarReadinessProbe({
          expectedRole: serviceConnection.descriptor.role,
          fetch: (input, init) => globalThis.fetch(input, { ...init, redirect: 'error' }),
        }),
      ),
      ...(onAuthorizationChanged ? { onAuthorizationChanged } : {}),
    })
  }
  const authenticatedShutdownRequest = createAuthenticatedShutdownRequest()
  return new RuntimeHost({
    paths,
    supervisorFactory: (role) =>
      new NodeSidecarSupervisor({
        readinessProbe: createSidecarReadinessProbe({ expectedRole: role }),
        authenticatedShutdownRequest,
        environment: {
          ...process.env,
          GITHUB_COPILOT_TOKEN_DIR: join(paths.userDataPath, 'auth', 'copilot'),
          GITHUB_COPILOT_ACCESS_TOKEN_FILE: 'access-token',
          GITHUB_COPILOT_API_KEY_FILE: 'api-key.json',
          GITHUB_COPILOT_MODELS_CACHE_FILE: 'models.json',
        },
      }),
    ...(onAuthorizationChanged ? { onAuthorizationChanged } : {}),
  })
}

export function registerRuntimeHostQuitLifecycle(
  app: QuitApp,
  host: Pick<RuntimeHost, 'stop'>,
): void {
  let quittingAfterStop = false
  let stopStarted = false
  app.on('before-quit', (event) => {
    if (quittingAfterStop) return
    event.preventDefault()
    if (stopStarted) return
    stopStarted = true
    const quitAfterStop = () => {
      quittingAfterStop = true
      app.quit()
    }
    void host.stop().then(quitAfterStop, quitAfterStop)
  })
}
