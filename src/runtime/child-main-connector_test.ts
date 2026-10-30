import { deepEqual as assertEquals, rejects as assertRejects } from 'node:assert/strict'
import { test } from 'node:test'
import type {
  ExecutionSupport,
  VersionHelloV1,
} from '../cluster/contracts.ts'
import { acceptAuthenticatedNodeWebSocket } from '../cluster/websocket-node-transport.ts'
import { NodeConnectionSession } from '../cluster/node-connection-session.ts'
import { InMemoryPairingNodeRegistry } from '../cluster/registry.ts'
import type {
  CancelReceiptV1,
  JobEventV1,
  ExecutionRequestV2,
  JobStatusV1,
} from '../execution/contracts.ts'
import type { Executor } from '../execution/executor.ts'
import { ChildMainConnector, nodeWebSocketUrl } from './child-main-connector.ts'

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  readonly CONNECTING = FakeWebSocket.CONNECTING
  readonly OPEN = FakeWebSocket.OPEN
  readonly CLOSING = FakeWebSocket.CLOSING
  readonly CLOSED = FakeWebSocket.CLOSED
  readyState = FakeWebSocket.OPEN
  bufferedAmount = 0
  binaryType: BinaryType = 'blob'
  extensions = ''
  protocol = ''
  url = 'ws://main.test/cluster/v1/node'
  peer?: FakeWebSocket
  closeCalls = 0

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this.readyState !== FakeWebSocket.OPEN) {
      throw new DOMException('WebSocket is not open', 'InvalidStateError')
    }
    if (typeof data !== 'string') throw new Error('test socket expects text')
    this.peer?.dispatchEvent(new MessageEvent('message', { data }))
  }

  close(code = 1000, reason = ''): void {
    this.closeCalls++
    if (this.readyState >= FakeWebSocket.CLOSING) return
    this.readyState = FakeWebSocket.CLOSING
    this.#finishClose(code, reason)
    if (this.peer) this.peer.#finishClose(code, reason)
  }

  #finishClose(code: number, reason: string): void {
    if (this.readyState === FakeWebSocket.CLOSED) return
    this.readyState = FakeWebSocket.CLOSED
    this.dispatchEvent(
      new CloseEvent('close', { code, reason, wasClean: code === 1000 }),
    )
  }
}

class IdleExecutor implements Executor {
  async *execute(_request: ExecutionRequestV2): AsyncIterable<JobEventV1> {
    return
  }

  getStatus(_jobId: string): Promise<JobStatusV1 | null> {
    return Promise.resolve(null)
  }

  cancel(jobId: string): Promise<CancelReceiptV1> {
    return Promise.resolve({
      version: 1,
      jobId,
      outcome: 'not-found',
      timestamp: baseTime.toISOString(),
      status: null,
    })
  }
}

const baseTime = new Date('2026-08-26T00:00:00.000Z')
const authentication = {
  deviceId: 'device-1',
  nodeId: 'node-1',
  credentialId: 'credential-1',
}
const hello: VersionHelloV1 = {
  protocolMajor: 1,
  protocolMinor: 2,
  implementationVersion: 'child-0.1.0',
  features: ['workdir-execution-v2'],
}
const capability: ExecutionSupport = { operations: ['process.execute'] }

function socketPair(): { server: FakeWebSocket; client: FakeWebSocket } {
  const server = new FakeWebSocket()
  const client = new FakeWebSocket()
  server.peer = client
  client.peer = server
  return { server, client }
}

function asWebSocket(socket: FakeWebSocket): WebSocket {
  return socket as unknown as WebSocket
}

function approvedRegistry(): InMemoryPairingNodeRegistry {
  const registry = new InMemoryPairingNodeRegistry()
  registry.createOffer(
    'offer-1',
    baseTime,
    new Date(baseTime.getTime() + 60_000),
  )
  registry.presentOffer({
    offerId: 'offer-1',
    pendingId: 'pending-1',
    deviceId: authentication.deviceId,
    nodeId: authentication.nodeId,
    deviceIdentityFingerprint: 'fingerprint-1',
    displayName: 'Workstation',
  }, new Date(baseTime.getTime() + 1_000))
  registry.approve({
    pendingId: 'pending-1',
    expectedDeviceIdentityFingerprint: 'fingerprint-1',
    credentialId: authentication.credentialId,
  }, new Date(baseTime.getTime() + 2_000))
  return registry
}

function connector(
  client: FakeWebSocket,
  capabilities: ExecutionSupport[] = [capability],
): ChildMainConnector {
  return new ChildMainConnector({
    localHello: hello,
    authentication,
    executor: new IdleExecutor(),
    workdirs: () => [],
    support: () => ({ operations: [...new Set(capabilities.flatMap(s => s.operations))] }),
    webSocketFactory: () => asWebSocket(client),
    transport: { maxPendingSends: 8 },
    session: { maxOutboundQueue: 8, heartbeatTimeoutMs: 30_000 },
  })
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return
    await Promise.resolve()
  }
  throw new Error('condition was not reached')
}

test('nodeWebSocketUrl maps HTTP origins and preserves base prefixes', () => {
  assertEquals(
    nodeWebSocketUrl('http://main.test').href,
    'ws://main.test/cluster/v1/node',
  )
  assertEquals(
    nodeWebSocketUrl('https://main.test/base/api/?ignored=yes#hash').href,
    'wss://main.test/base/api/cluster/v1/node',
  )
})

test('ChildMainConnector authenticates and advertises online capabilities', async () => {
  const pair = socketPair()
  const registry = approvedRegistry()
  const main = new NodeConnectionSession(
    registry,
    acceptAuthenticatedNodeWebSocket(asWebSocket(pair.server)),
    { ...hello, implementationVersion: 'main-0.1.0' },
    { maxOutboundQueue: 8, heartbeatTimeoutMs: 30_000 },
  )
  const mainRun = main.run()
  const offline = {
    ...capability,
    capabilityId: 'shell-offline',
    online: false,
  }
  const connection = await connector(pair.client, [capability, offline])
    .connect({
      endpoint: 'https://main.test/base',
      localNodeId: authentication.nodeId,
      signal: new AbortController().signal,
    })

  await waitFor(() =>
    registry.nodeSupport(authentication.nodeId).operations.length === 1
  )
  assertEquals(registry.nodeSupport(authentication.nodeId), capability)
  await connection.close()
  await mainRun
})

test('ChildMainConnector obtains and forwards the one-time authentication protocol', async () => {
  const pair = socketPair()
  const registry = approvedRegistry()
  const main = new NodeConnectionSession(
    registry,
    acceptAuthenticatedNodeWebSocket(asWebSocket(pair.server)),
    { ...hello, implementationVersion: 'main-0.1.0' },
    { maxOutboundQueue: 8, heartbeatTimeoutMs: 30_000 },
  )
  const mainRun = main.run()
  let requestedContext: unknown
  let protocols: string | string[] | undefined
  const mainConnector = new ChildMainConnector({
    localHello: hello,
    authentication,
    executor: new IdleExecutor(),
    workdirs: () => [],
    support: () => ({ operations: [] }),
    authenticationProtocol: (context) => {
      requestedContext = { ...context, signal: context.signal.aborted }
      return Promise.resolve('shadow-node-v1.signed-proof')
    },
    webSocketFactory: (_url, value) => {
      protocols = value
      return asWebSocket(pair.client)
    },
    session: { maxOutboundQueue: 8, heartbeatTimeoutMs: 30_000 },
  })
  const connection = await mainConnector.connect({
    endpoint: 'https://main.test',
    localNodeId: authentication.nodeId,
    signal: new AbortController().signal,
  })

  assertEquals(requestedContext, {
    endpoint: 'https://main.test',
    authentication,
    signal: false,
  })
  assertEquals(protocols, 'shadow-node-v1.signed-proof')
  await connection.close()
  await mainRun
})

test('ChildMainConnector rejects authentication failure and abort', async () => {
  const failedPair = socketPair()
  const failedMain = new NodeConnectionSession(
    new InMemoryPairingNodeRegistry(),
    acceptAuthenticatedNodeWebSocket(asWebSocket(failedPair.server)),
    { ...hello, implementationVersion: 'main-0.1.0' },
    { maxOutboundQueue: 8, heartbeatTimeoutMs: 30_000 },
  )
  const failedMainRun = failedMain.run()
  await assertRejects(
    () =>
      connector(failedPair.client).connect({
        endpoint: 'http://main.test',
        localNodeId: authentication.nodeId,
        signal: new AbortController().signal,
      }),
    Error,
  )
  await failedMainRun.catch(() => {})

  const abortedPair = socketPair()
  const abortController = new AbortController()
  const connecting = connector(abortedPair.client).connect({
    endpoint: 'http://main.test',
    localNodeId: authentication.nodeId,
    signal: abortController.signal,
  })
  abortController.abort(new DOMException('test abort', 'AbortError'))
  await assertRejects(
    () => connecting,
    (error) => error instanceof DOMException && error.message.includes('test abort'),
  )
  assertEquals(abortedPair.client.readyState, FakeWebSocket.CLOSED)
})

test('ChildMainConnector rejects a credential node mismatch before dialing', async () => {
  const pair = socketPair()
  let dialed = false
  const mainConnector = new ChildMainConnector({
    localHello: hello,
    authentication,
    executor: new IdleExecutor(),
    workdirs: () => [],
    support: () => ({ operations: [] }),
    webSocketFactory: () => {
      dialed = true
      return asWebSocket(pair.client)
    },
    session: { maxOutboundQueue: 8, heartbeatTimeoutMs: 30_000 },
  })

  await assertRejects(
    () =>
      mainConnector.connect({
        endpoint: 'http://main.test',
        localNodeId: 'node-2',
        signal: new AbortController().signal,
      }),
    (error) => error instanceof Error && error.message.includes('does not match'),
  )
  assertEquals(dialed, false)
})

test('ChildMainConnector disconnected settles on peer close', async () => {
  const pair = socketPair()
  const main = new NodeConnectionSession(
    approvedRegistry(),
    acceptAuthenticatedNodeWebSocket(asWebSocket(pair.server)),
    { ...hello, implementationVersion: 'main-0.1.0' },
    { maxOutboundQueue: 8, heartbeatTimeoutMs: 30_000 },
  )
  const mainRun = main.run()
  const connection = await connector(pair.client).connect({
    endpoint: 'http://main.test',
    localNodeId: authentication.nodeId,
    signal: new AbortController().signal,
  })

  await main.close({
    code: 'test-complete',
    reason: 'peer closed',
    clean: true,
  })
  await connection.disconnected
  await mainRun
})

test('ChildMainConnector closes idempotently', async () => {
  const pair = socketPair()
  const main = new NodeConnectionSession(
    approvedRegistry(),
    acceptAuthenticatedNodeWebSocket(asWebSocket(pair.server)),
    { ...hello, implementationVersion: 'main-0.1.0' },
    { maxOutboundQueue: 8, heartbeatTimeoutMs: 30_000 },
  )
  const mainRun = main.run()
  const connection = await connector(pair.client).connect({
    endpoint: 'http://main.test',
    localNodeId: authentication.nodeId,
    signal: new AbortController().signal,
  })

  const firstClose = connection.close()
  const secondClose = connection.close()
  assertEquals(firstClose, secondClose)
  await firstClose
  await connection.disconnected
  assertEquals(pair.client.closeCalls, 1)
  await mainRun
})
