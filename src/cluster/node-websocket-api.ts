import type { Hono } from 'hono'
import type { GatewayPlugin } from '../gateway/types.ts'
import { upgradeGatewayWebSocket } from '../gateway/websocket.ts'
import type { JobEventV1, JobRequestV1 } from '../execution/contracts.ts'
import type { RemoteNodeJobDispatcher } from '../execution/remote-executor.ts'
import type { VersionHelloV1 } from './contracts.ts'
import {
  NodeConnectionSession,
  type NodeConnectionSessionOptions,
} from './node-connection-session.ts'
import type { DuplexCloseInfo, NodeMessageDuplex } from './node-transport.ts'
import type { InMemoryPairingNodeRegistry } from './registry.ts'
import type { DeviceAuthenticationV1 } from './registry.ts'
import {
  acceptAuthenticatedNodeWebSocket,
  type NodeWebSocketTransportOptions,
} from './websocket-node-transport.ts'

export interface NodeWebSocketUpgrade {
  (
    request: Request,
    protocol?: string,
  ): { readonly socket: WebSocket; readonly response: Response }
}

export interface VerifiedNodeUpgrade {
  readonly authentication: DeviceAuthenticationV1
  readonly protocol?: string
}

export interface MainNodeSession {
  run(): Promise<void>
  close(info: DuplexCloseInfo): Promise<void>
  readonly state?: string
  hasAdvertisedCapability?(capabilityId: string): boolean
  dispatchJob?(request: JobRequestV1): JobRequestV1
  dispatchCancellation?(jobId: string): void
}

export interface NodeWebSocketApiOptions {
  readonly registry: InMemoryPairingNodeRegistry
  readonly localHello: VersionHelloV1
  readonly authorizeUpgrade: (
    request: Request,
  ) => VerifiedNodeUpgrade | null | Promise<VerifiedNodeUpgrade | null>
  readonly session: NodeConnectionSessionOptions
  readonly transport?: NodeWebSocketTransportOptions
  readonly upgrade?: NodeWebSocketUpgrade
  readonly createSession?: (
    transport: NodeMessageDuplex,
    authentication: DeviceAuthenticationV1,
  ) => MainNodeSession
}

export interface NodeWebSocketApi extends RemoteNodeJobDispatcher {
  readonly plugin: GatewayPlugin
  readonly activeSessionCount: number
  isNodeConnected(nodeId: string): boolean
  hasAdvertisedCapability(nodeId: string, capabilityId: string): boolean
  closeAll(reason?: string): Promise<void>
}

const shutdownCloseInfo = (reason: string): DuplexCloseInfo => ({
  code: 'peer-going-away',
  reason,
  clean: true,
})

export function createNodeWebSocketApi(
  options: NodeWebSocketApiOptions,
): NodeWebSocketApi {
  const sessions = new Set<MainNodeSession>()
  const sessionsByNode = new Map<string, MainNodeSession>()
  const jobs = new Map<string, {
    readonly nodeId: string
    readonly session: MainNodeSession
    readonly onEvent: (event: JobEventV1) => void
    readonly onDisconnect: (reason: string) => void
  }>()
  let closing = false
  let closePromise: Promise<void> | undefined
  const createSession = options.createSession ??
    ((transport, authentication) => {
      let session: NodeConnectionSession
      const configuredOnJobEvent = options.session.onJobEvent
      session = new NodeConnectionSession(
        options.registry,
        transport,
        options.localHello,
        {
          ...options.session,
          expectedAuthentication: authentication,
          onJobEvent: async (event, request) => {
            const job = jobs.get(event.jobId)
            if (job?.session === session) job.onEvent(event)
            await configuredOnJobEvent?.(event, request)
            if ('receipt' in event && job?.session === session) {
              jobs.delete(event.jobId)
            }
          },
        },
      )
      return session
    })

  const plugin = (app: Hono): void => {
    app.get('/cluster/v1/node', async (context) => {
      if (closing) return context.json({ error: 'cluster_stopping' }, 503)
      if (context.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
        return context.json({ error: 'websocket_upgrade_required' }, 426, {
          'Upgrade': 'websocket',
        })
      }
      const verified = await options.authorizeUpgrade(context.req.raw)
      if (verified === null) {
        return context.json({ error: 'unauthorized' }, 401)
      }

      const attach = (socket: WebSocket) => {
        if (closing) {
          socket.close(1001, 'Main node listener is shutting down')
          return
        }
        const transport = acceptAuthenticatedNodeWebSocket(
          socket,
          options.transport,
        )
        const session = createSession(transport, verified.authentication)
        sessions.add(session)
        const nodeId = verified.authentication.nodeId
        const previous = sessionsByNode.get(nodeId)
        sessionsByNode.set(nodeId, session)
        if (previous && previous !== session) {
          void previous.close({
            code: 'replaced',
            reason: 'A newer connection replaced this node session',
            clean: true,
          })
        }
        void session.run().catch(() => {}).finally(() => {
          sessions.delete(session)
          if (sessionsByNode.get(nodeId) === session) {
            sessionsByNode.delete(nodeId)
          }
          disconnectSessionJobs(
            session,
            'Remote node connection closed before the job completed',
          )
        })
      }
      try {
        if (options.upgrade) {
          const upgraded = options.upgrade(context.req.raw, verified.protocol)
          attach(upgraded.socket)
          return upgraded.response
        }
        return await upgradeGatewayWebSocket(
          app,
          context,
          (socket) => attach(socket as unknown as WebSocket),
          verified.protocol,
        )
      } catch (error) {
        console.warn('[cluster] WebSocket upgrade failed:', error instanceof Error ? error.message : 'unknown upgrade error')
        return context.json({ error: 'websocket_upgrade_failed' }, 400)
      }
    })
  }

  const api: NodeWebSocketApi = {
    plugin,
    get activeSessionCount(): number {
      return sessions.size
    },
    isNodeConnected(nodeId): boolean {
      return sessionsByNode.get(nodeId)?.state === 'authenticated'
    },
    hasAdvertisedCapability(nodeId, capabilityId): boolean {
      return sessionsByNode.get(nodeId)?.hasAdvertisedCapability?.(capabilityId) === true
    },
    closeAll(reason = 'Main node listener is shutting down'): Promise<void> {
      if (closePromise) return closePromise
      closing = true
      closePromise = Promise.all(
        [...sessions].map((session) =>
          session.close(shutdownCloseInfo(reason))
        ),
      ).then(() => undefined)
      return closePromise
    },
    dispatchJob(request, callbacks): void {
      if (closing) throw new Error('Main node listener is shutting down')
      if (jobs.has(request.jobId)) {
        throw new Error('Remote job is already tracked')
      }
      const session = sessionsByNode.get(request.nodeId)
      if (
        !session || session.state !== 'authenticated' ||
        !session.dispatchJob
      ) {
        throw new Error('Remote node is not connected and authenticated')
      }
      jobs.set(request.jobId, {
        nodeId: request.nodeId,
        session,
        ...callbacks,
      })
      try {
        session.dispatchJob(request)
      } catch (error) {
        jobs.delete(request.jobId)
        throw error
      }
    },
    dispatchCancellation(nodeId, jobId): void {
      const job = jobs.get(jobId)
      if (job?.nodeId !== nodeId || !job.session.dispatchCancellation) {
        throw new Error('Remote job is not active on the requested node')
      }
      job.session.dispatchCancellation(jobId)
    },
  }
  return api

  function disconnectSessionJobs(
    session: MainNodeSession,
    reason: string,
  ): void {
    for (const [jobId, job] of jobs) {
      if (job.session !== session) continue
      jobs.delete(jobId)
      job.onDisconnect(reason)
    }
  }
}
