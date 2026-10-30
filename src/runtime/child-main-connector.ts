import type { WorkdirAdvertisement } from '../execution/workdir-contracts.ts'
import type { ChildNodeConnectionSessionOptions } from '../cluster/child-node-connection-session.ts'
import { ChildNodeConnectionSession } from '../cluster/child-node-connection-session.ts'
import type {
  ExecutionSupport,
  VersionHelloV1,
} from '../cluster/contracts.ts'
import type { DuplexCloseInfo } from '../cluster/node-transport.ts'
import type { DeviceAuthenticationV1 } from '../cluster/registry.ts'
import type {
  NodeWebSocketFactory,
  NodeWebSocketTransportOptions,
} from '../cluster/websocket-node-transport.ts'
import { connectNodeWebSocket } from '../cluster/websocket-node-transport.ts'
import type { Executor } from '../execution/executor.ts'
import type { MainConnection, MainConnector } from './child-runtime.ts'

export interface ChildMainConnectorOptions {
  readonly localHello: VersionHelloV1
  readonly authentication: DeviceAuthenticationV1
  readonly executor: Executor
  readonly support: () => ExecutionSupport | Promise<ExecutionSupport>
  readonly workdirs: () => Iterable<WorkdirAdvertisement> | Promise<Iterable<WorkdirAdvertisement>>
  readonly webSocketFactory?: NodeWebSocketFactory
  readonly authenticationProtocol?: (context: {
    readonly endpoint: string
    readonly authentication: DeviceAuthenticationV1
    readonly signal: AbortSignal
  }) => Promise<string>
  readonly transport?: Omit<NodeWebSocketTransportOptions, 'signal'>
  readonly session: ChildNodeConnectionSessionOptions
}

const localCloseInfo: DuplexCloseInfo = {
  code: 'peer-closed',
  reason: 'child main connector closed',
  clean: true,
}

const abortedCloseInfo: DuplexCloseInfo = {
  code: 'aborted',
  reason: 'connection aborted',
  clean: true,
}

export function nodeWebSocketUrl(endpoint: string | URL): URL {
  const url = new URL(endpoint)
  if (url.protocol === 'http:') url.protocol = 'ws:'
  else if (url.protocol === 'https:') url.protocol = 'wss:'
  else throw new TypeError('Main endpoint must use http or https')

  const basePath = url.pathname.replace(/\/+$/, '')
  url.pathname = `${basePath}/cluster/v1/node`
  url.search = ''
  url.hash = ''
  return url
}

export class ChildMainConnector implements MainConnector {
  readonly #options: ChildMainConnectorOptions
  readonly #sessions = new Set<ChildNodeConnectionSession>()
  #shutdownPromise: Promise<void> | undefined

  constructor(options: ChildMainConnectorOptions) {
    this.#options = options
  }

  start(_signal: AbortSignal): Promise<void> {
    return Promise.resolve()
  }

  async advertiseNodeSupport(support: ExecutionSupport): Promise<void> {
    for (const session of this.#sessions) {
      if (session.state === 'authenticated') await session.advertiseNodeSupportWhenReady(support)
    }
  }

  async advertiseWorkdir(workdir: WorkdirAdvertisement): Promise<void> {
    for (const session of this.#sessions) {
      if (session.state === 'authenticated') await session.advertiseWorkdirWhenReady(workdir)
    }
  }

  shutdown(): Promise<void> {
    if (this.#shutdownPromise) return this.#shutdownPromise
    this.#shutdownPromise = Promise.all(
      [...this.#sessions].map((session) => session.close(localCloseInfo)),
    ).then(() => undefined)
    return this.#shutdownPromise
  }

  async connect(options: {
    readonly endpoint: string
    readonly localNodeId: string
    readonly signal: AbortSignal
  }): Promise<MainConnection> {
    if (this.#shutdownPromise) {
      throw new Error('Child main connector has shut down')
    }
    if (this.#options.authentication.nodeId !== options.localNodeId) {
      throw new Error(
        'Child authentication nodeId does not match the local nodeId',
      )
    }
    options.signal.throwIfAborted()

    let authenticationProtocol: string | undefined
    if (this.#options.authenticationProtocol) {
      authenticationProtocol = await this.#options.authenticationProtocol({
        endpoint: options.endpoint,
        authentication: this.#options.authentication,
        signal: options.signal,
      })
      options.signal.throwIfAborted()
    }

    const transport = await connectNodeWebSocket(
      nodeWebSocketUrl(options.endpoint),
      {
        ...this.#options.transport,
        ...(authenticationProtocol
          ? { protocols: authenticationProtocol }
          : {}),
        signal: options.signal,
        webSocketFactory: this.#options.webSocketFactory,
      },
    )
    const session = new ChildNodeConnectionSession(
      transport,
      this.#options.localHello,
      this.#options.authentication,
      this.#options.executor,
      this.#options.session,
    )
    this.#sessions.add(session)
    const onAbort = () => void session.close(abortedCloseInfo)
    options.signal.addEventListener('abort', onAbort, { once: true })
    if (options.signal.aborted) onAbort()

    const running = session.run()
    running.catch(() => {})
    const disconnected = running.then(
      () => undefined,
      () => undefined,
    )
    void disconnected.then(() => {
      options.signal.removeEventListener('abort', onAbort)
      this.#sessions.delete(session)
    })

    try {
      await session.authenticated
      options.signal.throwIfAborted()
      const workdirs = await this.#options.workdirs()
      for (const workdir of workdirs) await session.advertiseWorkdirWhenReady(workdir)
      const support = await this.#options.support()
      options.signal.throwIfAborted()
      await session.advertiseNodeSupportWhenReady(support)
      options.signal.throwIfAborted()
    } catch (error) {
      await session.close(
        options.signal.aborted ? abortedCloseInfo : {
          code: 'authentication-failed',
          reason: error instanceof Error ? error.message : String(error),
          clean: false,
        },
      )
      await disconnected
      if (options.signal.aborted) throw options.signal.reason
      throw error
    }

    let closePromise: Promise<void> | undefined
    return {
      disconnected,
      close(): Promise<void> {
        closePromise ??= session.close(localCloseInfo).then(() => disconnected)
        return closePromise
      },
    }
  }
}
