import { deepEqual as assertEquals, throws as assertThrows } from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import type { JobRequestV1 } from '../execution/contracts.ts'
import type { NodeMessageDuplex } from './node-transport.ts'
import {
  createNodeWebSocketApi,
  type MainNodeSession,
} from './node-websocket-api.ts'
import { InMemoryPairingNodeRegistry } from './registry.ts'

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = WebSocket.CONNECTING
  static readonly OPEN = WebSocket.OPEN
  static readonly CLOSING = WebSocket.CLOSING
  static readonly CLOSED = WebSocket.CLOSED
  readyState: number = FakeWebSocket.OPEN
  bufferedAmount = 0
  sent: string[] = []
  closes: Array<{ code?: number; reason?: string }> = []

  send(value: string): void {
    this.sent.push(value)
  }

  close(code?: number, reason?: string): void {
    this.readyState = FakeWebSocket.CLOSED
    this.closes.push({ code, reason })
  }
}

class FakeSession implements MainNodeSession {
  readonly running = Promise.withResolvers<void>()
  readonly state = 'authenticated'
  runCount = 0
  closes: Array<{ code: string; reason: string; clean: boolean }> = []
  jobs: JobRequestV1[] = []
  cancellations: string[] = []

  run(): Promise<void> {
    this.runCount++
    return this.running.promise
  }

  close(info: { code: string; reason: string; clean: boolean }): Promise<void> {
    this.closes.push(info)
    this.running.resolve()
    return Promise.resolve()
  }

  dispatchJob(request: JobRequestV1): JobRequestV1 {
    this.jobs.push(structuredClone(request))
    return request
  }

  dispatchCancellation(jobId: string): void {
    this.cancellations.push(jobId)
  }
}

function createApi() {
  const socket = new FakeWebSocket() as unknown as WebSocket
  const session = new FakeSession()
  let transport: NodeMessageDuplex | undefined
  let verifiedAuthentication: unknown
  let selectedProtocol: string | undefined
  let upgradeCount = 0
  const api = createNodeWebSocketApi({
    registry: new InMemoryPairingNodeRegistry(),
    localHello: {
      protocolMajor: 1,
      protocolMinor: 0,
      implementationVersion: 'test',
      features: [],
    },
    authorizeUpgrade: (request) =>
      request.headers.get('Authorization') === 'Proof valid'
        ? {
          authentication: {
            deviceId: 'device-1',
            nodeId: 'node-1',
            credentialId: 'credential-1',
          },
          protocol: 'shadow-node-v1.proof',
        }
        : null,
    session: { maxOutboundQueue: 8, heartbeatTimeoutMs: 1_000 },
    upgrade: (_request, protocol) => {
      upgradeCount++
      selectedProtocol = protocol
      return { socket, response: new Response(null, { status: 200 }) }
    },
    createSession: (value, authentication) => {
      transport = value
      verifiedAuthentication = authentication
      return session
    },
  })
  const app = new Hono()
  api.plugin(app)
  return {
    api,
    app,
    session,
    socket,
    transport: () => transport,
    verifiedAuthentication: () => verifiedAuthentication,
    selectedProtocol: () => selectedProtocol,
    upgradeCount: () => upgradeCount,
  }
}

test('node WebSocket route requires an upgrade and explicit authorization', async () => {
  const { app, upgradeCount } = createApi()
  const ordinary = await app.request('/cluster/v1/node')
  const unauthorized = await app.request('/cluster/v1/node', {
    headers: { Upgrade: 'websocket' },
  })

  assertEquals(ordinary.status, 426)
  assertEquals(ordinary.headers.get('Upgrade'), 'websocket')
  assertEquals(await ordinary.json(), { error: 'websocket_upgrade_required' })
  assertEquals(unauthorized.status, 401)
  assertEquals(await unauthorized.json(), { error: 'unauthorized' })
  assertEquals(upgradeCount(), 0)
})

test('authorized upgrade owns a bounded transport and session lifecycle', async () => {
  const {
    api,
    app,
    session,
    transport,
    verifiedAuthentication,
    selectedProtocol,
    upgradeCount,
  } = createApi()
  const response = await app.request('/cluster/v1/node', {
    headers: { Upgrade: 'websocket', Authorization: 'Proof valid' },
  })

  assertEquals(response.status, 200)
  assertEquals(upgradeCount(), 1)
  assertEquals(session.runCount, 1)
  assertEquals(api.activeSessionCount, 1)
  assertEquals(transport() !== undefined, true)
  assertEquals(verifiedAuthentication(), {
    deviceId: 'device-1',
    nodeId: 'node-1',
    credentialId: 'credential-1',
  })
  assertEquals(selectedProtocol(), 'shadow-node-v1.proof')

  await api.closeAll('test shutdown')
  assertEquals(session.closes, [{
    code: 'peer-going-away',
    reason: 'test shutdown',
    clean: true,
  }])
  await Promise.resolve()
  assertEquals(api.activeSessionCount, 0)
})

test('node WebSocket route fails closed after shutdown begins', async () => {
  const { api, app } = createApi()
  await api.closeAll()
  const response = await app.request('/cluster/v1/node', {
    headers: { Upgrade: 'websocket', Authorization: 'Proof valid' },
  })

  assertEquals(response.status, 503)
  assertEquals(await response.json(), { error: 'cluster_stopping' })
})

test('removing one node closes its session without stopping the listener', async () => {
  const { api, app, session } = createApi()
  const connect = () => app.request('/cluster/v1/node', {
    headers: { Upgrade: 'websocket', Authorization: 'Proof valid' },
  })
  await connect()
  await api.closeNode('unrelated-node', 'not this device')
  assertEquals(session.closes, [])
  assertEquals(api.isNodeConnected('node-1'), true)
  await api.closeNode('node-1', 'Device removed by Main')
  assertEquals(api.isNodeConnected('node-1'), false)
  assertEquals(session.closes, [{ code: 'revoked', reason: 'Device removed by Main', clean: true }])
  assertEquals((await connect()).status, 200)
  await api.closeAll()
})

test('node WebSocket owner routes jobs by node and disconnects owned work', async () => {
  const { api, app, session } = createApi()
  await app.request('/cluster/v1/node', {
    headers: { Upgrade: 'websocket', Authorization: 'Proof valid' },
  })
  const createdAt = new Date()
  const request: JobRequestV1 = {
    version: 1,
    jobId: 'remote-job-1',
    idempotencyKey: 'remote-job-key-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    nodeId: 'node-1',
    capabilityId: 'workdir-1',
    operation: 'filesystem.read',
    args: { path: 'README.md' },
    createdAt: createdAt.toISOString(),
    deadlineAt: new Date(createdAt.getTime() + 10_000).toISOString(),
  }
  const disconnects: string[] = []
  api.dispatchJob(request, {
    onEvent: () => {},
    onDisconnect: (reason) => disconnects.push(reason),
  })
  api.dispatchCancellation('node-1', request.jobId)

  assertEquals(session.jobs, [request])
  assertEquals(session.cancellations, [request.jobId])
  assertThrows(
    () =>
      api.dispatchJob({ ...request, jobId: 'wrong-node', nodeId: 'node-2' }, {
        onEvent: () => {},
        onDisconnect: () => {},
      }),
    (error) => error instanceof Error && error.message.includes('not connected'),
  )
  await session.close({ code: 'test', reason: 'test closed', clean: true })
  await Promise.resolve()
  assertEquals(disconnects, [
    'Remote node connection closed before the job completed',
  ])
})
