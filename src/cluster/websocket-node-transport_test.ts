import { deepEqual as assertEquals, rejects as assertRejects } from 'node:assert/strict'
import { test } from 'node:test'
import type { VersionHelloV1 } from './contracts.ts'
import { NodeConnectionSession } from './node-connection-session.ts'
import { InMemoryPairingNodeRegistry } from './registry.ts'
import {
  acceptAuthenticatedNodeWebSocket,
  connectNodeWebSocket,
} from './websocket-node-transport.ts'

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  readonly CONNECTING = FakeWebSocket.CONNECTING
  readonly OPEN = FakeWebSocket.OPEN
  readonly CLOSING = FakeWebSocket.CLOSING
  readonly CLOSED = FakeWebSocket.CLOSED
  readonly sent: string[] = []
  readyState = FakeWebSocket.OPEN
  bufferedAmount = 0
  binaryType: BinaryType = 'blob'
  extensions = ''
  protocol = ''
  url = 'ws://fake.test/cluster/v1/node'
  peer?: FakeWebSocket

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this.readyState !== FakeWebSocket.OPEN) {
      throw new DOMException('WebSocket is not open', 'InvalidStateError')
    }
    if (typeof data !== 'string') throw new Error('test socket expects text')
    this.sent.push(data)
    this.peer?.dispatchEvent(new MessageEvent('message', { data }))
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState >= FakeWebSocket.CLOSING) return
    this.readyState = FakeWebSocket.CLOSING
    this.#finishClose(code, reason)
    if (this.peer) this.peer.#finishClose(code, reason)
  }

  receive(data: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data }))
  }

  #finishClose(code: number, reason: string): void {
    if (this.readyState === FakeWebSocket.CLOSED) return
    this.readyState = FakeWebSocket.CLOSED
    this.dispatchEvent(
      new CloseEvent('close', { code, reason, wasClean: code === 1000 }),
    )
  }
}

function fakeWebSocketPair(): { server: FakeWebSocket; client: FakeWebSocket } {
  const server = new FakeWebSocket()
  const client = new FakeWebSocket()
  server.peer = client
  client.peer = server
  return { server, client }
}

function asWebSocket(socket: FakeWebSocket): WebSocket {
  return socket as unknown as WebSocket
}

const baseTime = new Date('2026-08-26T00:00:00.000Z')
const auth = {
  deviceId: 'device-1',
  nodeId: 'node-1',
  credentialId: 'credential-1',
}
const hello: VersionHelloV1 = {
  protocolMajor: 1,
  protocolMinor: 2,
  implementationVersion: 'main-0.1.0',
  features: ['jobs-v1', 'capabilities-v1'],
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
    deviceId: auth.deviceId,
    nodeId: auth.nodeId,
    deviceIdentityFingerprint: 'fingerprint-1',
    displayName: 'Workstation',
  }, new Date(baseTime.getTime() + 1_000))
  registry.approve({
    pendingId: 'pending-1',
    expectedDeviceIdentityFingerprint: 'fingerprint-1',
    credentialId: auth.credentialId,
    uiScopes: [],
    nodePrivileges: ['capabilities:advertise', 'jobs:execute'],
  }, new Date(baseTime.getTime() + 2_000))
  return registry
}

test('WebSocket node transport rejects malformed JSON deterministically', async () => {
  const pair = fakeWebSocketPair()
  const transport = acceptAuthenticatedNodeWebSocket(asWebSocket(pair.server))
  const next = transport.incoming[Symbol.asyncIterator]().next()
  pair.server.receive('{not-json')

  await assertRejects(
    () => next,
    (error) => error instanceof Error && error.message.includes('malformed JSON message'),
  )
  assertEquals(await transport.closed, {
    code: 'malformed-json',
    reason: 'malformed JSON message',
    clean: false,
  })
  assertEquals(pair.client.readyState, FakeWebSocket.CLOSED)
})

test('WebSocket node transport rejects oversized inbound and outbound frames', async () => {
  const inboundPair = fakeWebSocketPair()
  const inbound = acceptAuthenticatedNodeWebSocket(
    asWebSocket(inboundPair.server),
    { maxInboundMessageBytes: 32 },
  )
  const next = inbound.incoming[Symbol.asyncIterator]().next()
  inboundPair.server.receive(JSON.stringify({ padding: 'x'.repeat(40) }))
  await assertRejects(
    () => next,
    (error) => error instanceof Error && error.message.includes('exceeds 32 bytes'),
  )
  assertEquals((await inbound.closed).code, 'message-too-large')

  const outboundPair = fakeWebSocketPair()
  const outbound = acceptAuthenticatedNodeWebSocket(
    asWebSocket(outboundPair.server),
    { maxOutboundMessageBytes: 64 },
  )
  await assertRejects(
    () =>
      outbound.send({
        version: 1,
        sequence: 0,
        type: 'heartbeat',
        sentAt: baseTime.toISOString(),
      }),
    (error) => error instanceof Error && error.message.includes('exceeds 64 bytes'),
  )
  assertEquals(outboundPair.server.sent, [])
})

test('WebSocket node transport propagates close code and reason', async () => {
  const pair = fakeWebSocketPair()
  const server = acceptAuthenticatedNodeWebSocket(asWebSocket(pair.server))
  const client = await connectNodeWebSocket('ws://fake.test/cluster/v1/node', {
    webSocketFactory: () => asWebSocket(pair.client),
  })

  await server.close({
    code: 'transport-failed',
    reason: 'socket write failed',
    clean: false,
  })
  assertEquals(await client.closed, {
    code: 'transport-failed',
    reason: 'socket write failed',
    clean: false,
  })
})

test('WebSocket node transport serializes sends under backpressure', async () => {
  const pair = fakeWebSocketPair()
  pair.server.bufferedAmount = 100
  const server = acceptAuthenticatedNodeWebSocket(asWebSocket(pair.server), {
    maxBufferedAmountBytes: 128,
    bufferedAmountPollMs: 1,
    sendTimeoutMs: 1_000,
  })
  const frames = [0, 1, 2].map((sequence) => ({
    version: 1 as const,
    sequence,
    type: 'heartbeat' as const,
    sentAt: new Date(baseTime.getTime() + sequence).toISOString(),
  }))
  const sends = frames.map((frame) => server.send(frame))
  await Promise.resolve()
  assertEquals(pair.server.sent, [])
  pair.server.bufferedAmount = 0
  await Promise.all(sends)
  assertEquals(pair.server.sent.map((value) => JSON.parse(value)), frames)
})

test('NodeConnectionSession authenticates through WebSocket adapters', async () => {
  const pair = fakeWebSocketPair()
  const server = acceptAuthenticatedNodeWebSocket(asWebSocket(pair.server))
  const client = await connectNodeWebSocket('ws://fake.test/cluster/v1/node', {
    webSocketFactory: () => asWebSocket(pair.client),
  })
  const connection = new NodeConnectionSession(
    approvedRegistry(),
    server,
    hello,
    { maxOutboundQueue: 8, heartbeatTimeoutMs: 30_000 },
  )
  const running = connection.run()
  await client.send({
    version: 1,
    sequence: 0,
    type: 'hello',
    hello: { ...hello, implementationVersion: 'child-0.1.0' },
  })
  await client.send({
    version: 1,
    sequence: 1,
    type: 'authenticate',
    authentication: auth,
  })

  assertEquals(
    (await client.incoming[Symbol.asyncIterator]().next()).value,
    {
      version: 1,
      sequence: 0,
      type: 'authenticated',
      negotiated: {
        protocolMajor: 1,
        protocolMinor: 2,
        features: hello.features,
      },
    },
  )
  assertEquals(connection.state, 'authenticated')
  await client.close({
    code: 'test-complete',
    reason: 'test complete',
    clean: true,
  })
  await running
})
