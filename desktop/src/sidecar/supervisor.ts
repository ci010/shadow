import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process'

export type SidecarRole = 'main' | 'child'

export type SidecarFailureKind =
  | 'spawn-error'
  | 'configuration-error'
  | 'port-conflict'
  | 'readiness-timeout'
  | 'early-exit'
  | 'migration-failure'
  | 'main-unreachable'
  | 'crash'

export type SidecarStatus =
  | { readonly phase: 'stopped' }
  | { readonly phase: 'starting'; readonly role: SidecarRole }
  | { readonly phase: 'ready'; readonly role: SidecarRole; readonly apiBase: string }
  | { readonly phase: 'failed'; readonly role: SidecarRole; readonly kind: SidecarFailureKind; readonly message: string }

export interface SidecarStartRequest {
  readonly role: SidecarRole
  readonly executablePath: string
  readonly entryPath: string
  readonly configPath: string
  readonly launchToken: string
  readonly port: number
  readonly localExecutor?: boolean
}

export interface SidecarSupervisor {
  readonly status: SidecarStatus
  start(request: SidecarStartRequest): Promise<SidecarStatus>
  stop(): Promise<void>
}

export interface SidecarChildProcess {
  readonly stdout: { on(event: 'data', listener: (chunk: unknown) => void): unknown } | null
  readonly stderr: { on(event: 'data', listener: (chunk: unknown) => void): unknown } | null
  once(event: 'error', listener: (error: Error) => void): unknown
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  kill(signal?: NodeJS.Signals): boolean
}

export type SidecarSpawn = (
  executablePath: string,
  args: readonly string[],
  options: SpawnOptions,
) => SidecarChildProcess

export interface SidecarReadinessResult {
  readonly ready: boolean
  readonly failure?: {
    readonly kind: Extract<SidecarFailureKind, 'configuration-error' | 'port-conflict' | 'migration-failure' | 'main-unreachable'>
    readonly message: string
  }
}

export type SidecarReadinessProbe = (apiBase: string, launchToken: string) => Promise<SidecarReadinessResult>

export type SidecarShutdownRequest = (request: {
  readonly apiBase: string
  readonly launchToken: string
}) => Promise<unknown>

export interface SidecarClock {
  now(): number
  setTimeout(callback: () => void, delayMs: number): unknown
  clearTimeout(handle: unknown): void
}

export interface SidecarLogEntry {
  readonly stream: 'stdout' | 'stderr' | 'supervisor'
  readonly message: string
}

export interface NodeSidecarSupervisorOptions {
  readonly spawn?: SidecarSpawn
  readonly readinessProbe: SidecarReadinessProbe
  readonly authenticatedShutdownRequest?: SidecarShutdownRequest
  readonly clock?: SidecarClock
  readonly logSink?: (entry: SidecarLogEntry) => void
  readonly environment?: NodeJS.ProcessEnv
  readonly readinessTimeoutMs?: number
  readonly readinessPollIntervalMs?: number
  readonly shutdownGraceTimeoutMs?: number
  readonly stopTimeoutMs?: number
}

const systemClock: SidecarClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
}

const defaultSpawn: SidecarSpawn = (executablePath, args, options) => nodeSpawn(executablePath, args, options)

export class NodeSidecarSupervisor implements SidecarSupervisor {
  status: SidecarStatus = { phase: 'stopped' }

  private readonly spawn: SidecarSpawn
  private readonly clock: SidecarClock
  private readonly logSink: (entry: SidecarLogEntry) => void
  private readonly environment: NodeJS.ProcessEnv
  private readonly readinessTimeoutMs: number
  private readonly readinessPollIntervalMs: number
  private readonly shutdownGraceTimeoutMs: number
  private readonly stopTimeoutMs: number
  private child: SidecarChildProcess | undefined
  private startPromise: Promise<SidecarStatus> | undefined
  private stopPromise: Promise<void> | undefined
  private exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }> | undefined
  private resolveExit: ((exit: { code: number | null; signal: NodeJS.Signals | null; error?: Error }) => void) | undefined
  private launchContext: { readonly apiBase: string; readonly launchToken: string } | undefined
  private stopping = false
  private recentOutput = ''

  constructor(private readonly options: NodeSidecarSupervisorOptions) {
    this.spawn = options.spawn ?? defaultSpawn
    this.clock = options.clock ?? systemClock
    this.logSink = options.logSink ?? (() => undefined)
    this.environment = options.environment ?? process.env
    this.readinessTimeoutMs = options.readinessTimeoutMs ?? 15_000
    this.readinessPollIntervalMs = options.readinessPollIntervalMs ?? 200
    this.shutdownGraceTimeoutMs = options.shutdownGraceTimeoutMs ?? 1_000
    this.stopTimeoutMs = options.stopTimeoutMs ?? 5_000
  }

  start(request: SidecarStartRequest): Promise<SidecarStatus> {
    if (this.startPromise) return this.startPromise
    if (this.status.phase === 'ready') return Promise.resolve(this.status)

    this.startPromise = this.startProcess(request).finally(() => {
      this.startPromise = undefined
    })
    return this.startPromise
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    this.stopPromise = this.stopProcess().finally(() => {
      this.stopPromise = undefined
    })
    return this.stopPromise
  }

  private async startProcess(request: SidecarStartRequest): Promise<SidecarStatus> {
    const validationFailure = this.validate(request)
    if (validationFailure) return this.fail(request.role, 'configuration-error', validationFailure)

    this.status = { phase: 'starting', role: request.role }
    this.stopping = false
    this.recentOutput = ''

    const args = [
      request.entryPath,
      request.role === 'main' ? 'server' : 'child',
      'start',
      '--config', request.configPath,
      ...(request.localExecutor ? ['--local-executor'] : []),
    ]

    try {
      this.child = this.spawn(request.executablePath, args, {
        cwd: undefined,
        env: {
          ...this.environment,
          ELECTRON_RUN_AS_NODE: '1',
          GATEWAY_PORT: String(request.port),
          WINDOWS_USE_LAUNCH_TOKEN: request.launchToken,
        },
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      return this.fail(request.role, 'spawn-error', this.errorMessage(error))
    }

    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve
    })
    this.captureLogs(this.child)
    this.child.once('error', (error) => {
      this.log('supervisor', `Spawn error: ${error.message}`)
      this.resolveExit?.({ code: null, signal: null, error })
    })
    this.child.once('exit', (code, signal) => {
      this.launchContext = undefined
      this.resolveExit?.({ code, signal })
      if (!this.stopping && this.status.phase === 'ready') {
        this.fail(request.role, 'crash', `Sidecar exited with ${this.formatExit(code, signal)}`)
      }
    })

    const deadline = this.clock.now() + this.readinessTimeoutMs
    const apiBase = `http://127.0.0.1:${request.port}`
    while (this.clock.now() < deadline) {
      const outcome = await this.waitForReadinessOutcome(
        apiBase,
        request.launchToken,
        this.exitPromise,
        deadline - this.clock.now(),
      )

      if (outcome.type === 'exit') {
        if (outcome.exit.error) return this.fail(request.role, 'spawn-error', outcome.exit.error.message)
        const kind = this.classifyEarlyExit()
        return this.fail(request.role, kind, `Sidecar exited before readiness with ${this.formatExit(outcome.exit.code, outcome.exit.signal)}`)
      }
      if (outcome.type === 'deadline') {
        await this.stopChild()
        return this.fail(request.role, 'readiness-timeout', `Sidecar was not ready within ${this.readinessTimeoutMs}ms`)
      }
      if (outcome.type === 'probe' && outcome.result.failure) {
        await this.stopChild()
        return this.fail(request.role, outcome.result.failure.kind, outcome.result.failure.message)
      }
      if (outcome.type === 'probe' && outcome.result.ready) {
        this.launchContext = { apiBase, launchToken: request.launchToken }
        this.status = { phase: 'ready', role: request.role, apiBase }
        return this.status
      }
      if (outcome.type === 'probe-error') this.log('supervisor', `Readiness probe failed: ${this.errorMessage(outcome.error)}`)
      await this.delay(Math.min(this.readinessPollIntervalMs, Math.max(0, deadline - this.clock.now())))
    }

    await this.stopChild()
    return this.fail(request.role, 'readiness-timeout', `Sidecar was not ready within ${this.readinessTimeoutMs}ms`)
  }

  private async waitForReadinessOutcome(
    apiBase: string,
    launchToken: string,
    exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>,
    remainingMs: number,
  ): Promise<
    | { type: 'probe'; result: SidecarReadinessResult }
    | { type: 'probe-error'; error: unknown }
    | { type: 'exit'; exit: { code: number | null; signal: NodeJS.Signals | null; error?: Error } }
    | { type: 'deadline' }
  > {
    let deadlineTimer: unknown
    const deadline = new Promise<{ type: 'deadline' }>((resolve) => {
      deadlineTimer = this.clock.setTimeout(
        () => resolve({ type: 'deadline' }),
        remainingMs,
      )
    })
    try {
      return await Promise.race([
        this.options.readinessProbe(apiBase, launchToken).then(
          (result) => ({ type: 'probe' as const, result }),
          (error: unknown) => ({ type: 'probe-error' as const, error }),
        ),
        exitPromise.then((exit) => ({ type: 'exit' as const, exit })),
        deadline,
      ])
    } finally {
      this.clock.clearTimeout(deadlineTimer)
    }
  }

  private async stopProcess(): Promise<void> {
    this.stopping = true
    try {
      await this.stopChild()
      this.status = { phase: 'stopped' }
    } finally {
      this.launchContext = undefined
    }
  }

  private async stopChild(): Promise<void> {
    const child = this.child
    const exitPromise = this.exitPromise
    if (!child || !exitPromise) return

    const launchContext = this.launchContext
    if (launchContext && this.options.authenticatedShutdownRequest) {
      const graceDeadline = this.clock.now() + this.shutdownGraceTimeoutMs
      const shutdownOutcome = await this.waitForShutdownOutcome(launchContext, exitPromise)
      if (shutdownOutcome === 'exited') {
        this.clearChild(child)
        return
      }
      if (shutdownOutcome === 'requested') {
        const exited = await this.waitForExit(exitPromise, Math.max(0, graceDeadline - this.clock.now()))
        if (exited) {
          this.clearChild(child)
          return
        }
      } else if (shutdownOutcome === 'failed') {
        this.log('supervisor', 'Authenticated shutdown request failed; falling back to SIGTERM')
      }
    }

    child.kill('SIGTERM')
    const exited = await this.waitForExit(exitPromise, this.stopTimeoutMs)
    if (!exited) {
      this.log('supervisor', 'Sidecar did not stop gracefully; forcing termination')
      child.kill('SIGKILL')
      await exitPromise
    }
    this.clearChild(child)
  }


  private async waitForExit(exitPromise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
    let timeoutHandle: unknown
    const timeout = new Promise<false>((resolve) => {
      timeoutHandle = this.clock.setTimeout(() => resolve(false), timeoutMs)
    })
    try {
      return await Promise.race([
        exitPromise.then(() => true),
        timeout,
      ])
    } finally {
      this.clock.clearTimeout(timeoutHandle)
    }
  }
  private async waitForShutdownOutcome(
    launchContext: { readonly apiBase: string; readonly launchToken: string },
    exitPromise: Promise<unknown>,
  ): Promise<'requested' | 'failed' | 'exited' | 'timeout'> {
    let graceTimer: unknown
    const graceTimeout = new Promise<'timeout'>((resolve) => {
      graceTimer = this.clock.setTimeout(() => resolve('timeout'), this.shutdownGraceTimeoutMs)
    })
    try {
      return await Promise.race([
        this.options.authenticatedShutdownRequest!(launchContext).then(
          () => 'requested' as const,
          () => 'failed' as const,
        ),
        exitPromise.then(() => 'exited' as const),
        graceTimeout,
      ])
    } finally {
      this.clock.clearTimeout(graceTimer)
    }
  }

  private clearChild(child: SidecarChildProcess): void {
    if (this.child !== child) return
    this.child = undefined
    this.exitPromise = undefined
    this.resolveExit = undefined
    this.launchContext = undefined
  }

  private captureLogs(child: SidecarChildProcess): void {
    child.stdout?.on('data', (chunk) => this.log('stdout', String(chunk)))
    child.stderr?.on('data', (chunk) => this.log('stderr', String(chunk)))
  }

  private log(stream: SidecarLogEntry['stream'], message: string): void {
    const normalized = message.trim()
    if (!normalized) return
    this.recentOutput = `${this.recentOutput}\n${normalized}`.slice(-8_192)
    this.logSink({ stream, message: normalized })
  }

  private classifyEarlyExit(): SidecarFailureKind {
    if (/EADDRINUSE|address already in use|port.+in use/i.test(this.recentOutput)) return 'port-conflict'
    if (/config(?:uration)?.+(?:invalid|error)|invalid.+config/i.test(this.recentOutput)) return 'configuration-error'
    if (/migration.+(?:failed|error)/i.test(this.recentOutput)) return 'migration-failure'
    return 'early-exit'
  }

  private validate(request: SidecarStartRequest): string | undefined {
    if (!request.executablePath.trim()) return 'Executable path is required'
    if (!request.entryPath.trim()) return 'Backend entry path is required'
    if (!request.configPath.trim()) return 'Config path is required'
    if (!request.launchToken) return 'Launch token is required'
    if (!Number.isInteger(request.port) || request.port < 1 || request.port > 65_535) return 'Port must be an integer from 1 to 65535'
    if (request.role === 'child' && request.localExecutor) return 'Local executor is only valid for main sidecars'
    return undefined
  }

  private fail(role: SidecarRole, kind: SidecarFailureKind, message: string): SidecarStatus {
    this.status = { phase: 'failed', role, kind, message }
    return this.status
  }

  private delay(delayMs: number): Promise<void> {
    return new Promise((resolve) => {
      this.clock.setTimeout(resolve, delayMs)
    })
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }

  private formatExit(code: number | null, signal: NodeJS.Signals | null): string {
    return signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`
  }
}

export class FakeSidecarSupervisor implements SidecarSupervisor {
  status: SidecarStatus = { phase: 'stopped' }
  readonly starts: SidecarStartRequest[] = []
  stopCount = 0

  constructor(private nextResult?: SidecarStatus) {}

  setNextResult(result: SidecarStatus): void {
    this.nextResult = result
  }

  async start(request: SidecarStartRequest): Promise<SidecarStatus> {
    this.starts.push(request)
    this.status = { phase: 'starting', role: request.role }
    this.status = this.nextResult ?? {
      phase: 'ready',
      role: request.role,
      apiBase: `http://127.0.0.1:${request.port}`,
    }
    this.nextResult = undefined
    return this.status
  }

  async stop(): Promise<void> {
    this.stopCount += 1
    this.status = { phase: 'stopped' }
  }
}