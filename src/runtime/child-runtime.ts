import type { ChildBootstrapConfigV1 } from './bootstrap-config.ts'

export interface ChildRuntimeService {
  start(signal: AbortSignal): Promise<void>
  shutdown(): Promise<void>
}

export interface MainConnection {
  readonly disconnected: Promise<void>
  close(): Promise<void>
}

export interface MainConnector extends ChildRuntimeService {
  connect(options: {
    readonly endpoint: string
    readonly localNodeId: string
    readonly signal: AbortSignal
  }): Promise<MainConnection>
}

export interface ChildRuntimeDependencies {
  readonly nodeIdentity: ChildRuntimeService
  readonly capabilityRegistry: ChildRuntimeService
  readonly localExecutors: ChildRuntimeService
  readonly approvalService: ChildRuntimeService
  readonly artifactStaging: ChildRuntimeService
  readonly mainConnector: MainConnector
  readonly remoteApiProxy: ChildRuntimeService
}

export interface ChildRuntimeHandle {
  readonly ready: Promise<void>
  readonly finished: Promise<void>
  shutdown(): Promise<void>
}

export interface ChildRuntimeTimers {
  sleep(delayMs: number, signal: AbortSignal): Promise<void>
}

export interface ChildReconnectPolicy {
  readonly initialDelayMs: number
  readonly maxDelayMs: number
  readonly multiplier: number
}

export interface ChildRuntimeOptions {
  readonly reconnect?: Partial<ChildReconnectPolicy>
  readonly timers?: ChildRuntimeTimers
}

const defaultReconnectPolicy: ChildReconnectPolicy = {
  initialDelayMs: 250,
  maxDelayMs: 30_000,
  multiplier: 2,
}

const defaultTimers: ChildRuntimeTimers = {
  sleep(delayMs, signal) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(done, delayMs)

      function done(): void {
        signal.removeEventListener('abort', aborted)
        resolve()
      }

      function aborted(): void {
        clearTimeout(timeout)
        reject(signal.reason)
      }

      if (signal.aborted) aborted()
      else signal.addEventListener('abort', aborted, { once: true })
    })
  },
}

export function startChildRuntime(
  config: ChildBootstrapConfigV1,
  dependencies: ChildRuntimeDependencies,
  options: ChildRuntimeOptions = {},
): ChildRuntimeHandle {
  const abortController = new AbortController()
  const finished = Promise.withResolvers<void>()
  const started: ChildRuntimeService[] = []
  const reconnect = reconnectPolicy(options.reconnect)
  const timers = options.timers ?? defaultTimers
  let activeConnection: MainConnection | undefined
  let supervisor: Promise<void> | undefined
  let shutdownPromise: Promise<void> | undefined

  const services = [
    dependencies.nodeIdentity,
    dependencies.capabilityRegistry,
    dependencies.localExecutors,
    dependencies.approvalService,
    dependencies.artifactStaging,
    dependencies.mainConnector,
    dependencies.remoteApiProxy,
  ]

  const ready = (async () => {
    for (const service of services) {
      abortController.signal.throwIfAborted()
      await service.start(abortController.signal)
      started.push(service)
    }

    supervisor = superviseConnection()
    await Promise.resolve()
  })()

  const shutdown = (): Promise<void> => {
    if (shutdownPromise !== undefined) return shutdownPromise
    shutdownPromise = (async () => {
      abortController.abort()
      await activeConnection?.close()
      await ready.catch(() => {})
      await supervisor

      const errors: unknown[] = []
      for (const service of started.toReversed()) {
        try {
          await service.shutdown()
        } catch (error) {
          errors.push(error)
        }
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, 'Child runtime shutdown failed')
      }
    })()
    shutdownPromise.then(finished.resolve, finished.reject)
    return shutdownPromise
  }

  ready.catch(() => void shutdown())

  return { ready, finished: finished.promise, shutdown }

  async function superviseConnection(): Promise<void> {
    let delayMs = reconnect.initialDelayMs
    while (!abortController.signal.aborted) {
      try {
        const connection = await dependencies.mainConnector.connect({
          endpoint: config.mainEndpoint,
          localNodeId: config.localNodeId,
          signal: abortController.signal,
        })
        if (abortController.signal.aborted) {
          await connection.close()
          return
        }

        activeConnection = connection
        delayMs = reconnect.initialDelayMs
        await waitForDisconnect(connection, abortController.signal)
        activeConnection = undefined
      } catch (error) {
        if (abortController.signal.aborted) return
        console.warn('[child] Main connection failed; retrying:', error instanceof Error ? error.message : 'unknown connection error')
      }

      try {
        await timers.sleep(delayMs, abortController.signal)
      } catch {
        if (abortController.signal.aborted) return
        throw new Error('Reconnect timer failed')
      }
      delayMs = Math.min(
        reconnect.maxDelayMs,
        Math.max(reconnect.initialDelayMs, delayMs * reconnect.multiplier),
      )
    }
  }
}

function waitForDisconnect(
  connection: MainConnection,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
    connection.disconnected.then(done, done)
  })
}

function reconnectPolicy(
  input: Partial<ChildReconnectPolicy> | undefined,
): ChildReconnectPolicy {
  const policy = { ...defaultReconnectPolicy, ...input }
  if (
    !Number.isFinite(policy.initialDelayMs) || policy.initialDelayMs < 0 ||
    !Number.isFinite(policy.maxDelayMs) ||
    policy.maxDelayMs < policy.initialDelayMs ||
    !Number.isFinite(policy.multiplier) || policy.multiplier < 1
  ) {
    throw new TypeError('Invalid Child reconnect policy')
  }
  return policy
}
