import { deepEqual as assertEquals, rejects as assertRejects, throws as assertThrows } from 'node:assert/strict'
import { test } from 'node:test'
import type { JobEventV1, ExecutionRequestV2 } from '../execution/contracts.ts'
import type { ExecutionSupport, VersionHelloV1 } from './contracts.ts'
import { createInMemoryNodeDuplexPair } from './in-memory-node-duplex.ts'
import {
  NodeConnectionSession,
  NodeSessionError,
  type NodeSessionErrorCode,
} from './node-connection-session.ts'
import type { DuplexCloseInfo, NodeMessageDuplex } from './node-transport.ts'
import { InMemoryPairingNodeRegistry, RegistryError } from './registry.ts'

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
  features: ['workdir-execution-v2'],
}
const capability: ExecutionSupport = { operations: ['process.execute'] }
const request: ExecutionRequestV2 = {
  version: 2,
  jobId: 'job-1',
  idempotencyKey: 'idempotency-1',
  sessionId: 'session-1',
  turnId: 'turn-1',
  nodeId: 'node-1',
  projectScope: '0123456789abcdef0123456789abcdef',
  operation: 'process.execute',
  args: { command: 'echo hello' },
  createdAt: baseTime.toISOString(),
  deadlineAt: new Date(baseTime.getTime() + 60_000).toISOString(),
}

class RecordingDuplex implements NodeMessageDuplex {
  readonly sent: unknown[] = []
  readonly incoming: AsyncIterable<unknown> = {
    async *[Symbol.asyncIterator]() {
      return
    },
  }
  readonly #closedResolver = Promise.withResolvers<DuplexCloseInfo>()
  readonly closed = this.#closedResolver.promise

  send(message: unknown): Promise<void> {
    this.sent.push(structuredClone(message))
    return Promise.resolve()
  }

  close(info: DuplexCloseInfo): Promise<void> {
    this.#closedResolver.resolve(structuredClone(info))
    return Promise.resolve()
  }
}

class BlockingDuplex extends RecordingDuplex {
  readonly #sendGate = Promise.withResolvers<void>()

  override send(message: unknown): Promise<void> {
    this.sent.push(structuredClone(message))
    return this.#sendGate.promise
  }

  release(): void {
    this.#sendGate.resolve()
  }
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
  }, new Date(baseTime.getTime() + 2_000))
  return registry
}

function session(
  registry = approvedRegistry(),
  transport: NodeMessageDuplex = new RecordingDuplex(),
  options: {
    maxOutboundQueue?: number
    heartbeatTimeoutMs?: number
    expectedAuthentication?: typeof auth
    now?: () => Date
  } = {},
): NodeConnectionSession {
  return new NodeConnectionSession(registry, transport, hello, {
    maxOutboundQueue: options.maxOutboundQueue ?? 8,
    heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? 30_000,
    expectedAuthentication: options.expectedAuthentication,
    now: options.now,
  })
}

async function authenticate(connection: NodeConnectionSession): Promise<void> {
  await connection.handleIncoming({
    version: 1,
    sequence: 0,
    type: 'hello',
    hello: { ...hello, implementationVersion: 'child-0.1.0' },
  })
  await connection.handleIncoming({
    version: 1,
    sequence: 1,
    type: 'authenticate',
    authentication: auth,
  })
}

async function expectSessionError(
  code: NodeSessionErrorCode,
  action: () => Promise<unknown>,
): Promise<void> {
  await assertRejects(
    action,
    (error) => error instanceof NodeSessionError && error.code === code,
  )
}

test('node session requires hello first and in-memory duplex completes authentication', async () => {
  const invalid = session()
  await expectSessionError('unexpected-message', () =>
    invalid.handleIncoming({
      version: 1,
      sequence: 0,
      type: 'authenticate',
      authentication: auth,
    }))
  assertEquals((await invalid.closed).code, 'unexpected-message')

  const registry = approvedRegistry()
  const pair = createInMemoryNodeDuplexPair()
  const connection = session(registry, pair.server)
  const running = connection.run()
  await pair.client.send({
    version: 1,
    sequence: 0,
    type: 'hello',
    hello: { ...hello, implementationVersion: 'child-0.1.0' },
  })
  await pair.client.send({
    version: 1,
    sequence: 1,
    type: 'authenticate',
    authentication: auth,
  })
  const response = await pair.client.incoming[Symbol.asyncIterator]().next()
  assertEquals(response.value, {
    version: 1,
    sequence: 0,
    type: 'authenticated',
    negotiated: {
      protocolMajor: 1,
      protocolMinor: 2,
      features: hello.features,
    },
  })
  assertEquals(connection.state, 'authenticated')
  await pair.client.close({
    code: 'test-complete',
    reason: 'test complete',
    clean: true,
  })
  await running
})

test('node session binds authenticate frame to the verified upgrade identity', async () => {
  const connection = session(approvedRegistry(), new RecordingDuplex(), {
    expectedAuthentication: auth,
  })
  await connection.handleIncoming({
    version: 1,
    sequence: 0,
    type: 'hello',
    hello,
  })
  await expectSessionError(
    'authentication-failed',
    () =>
      connection.handleIncoming({
        version: 1,
        sequence: 1,
        type: 'authenticate',
        authentication: { ...auth, nodeId: 'node-other' },
      }),
  )
  assertEquals(
    (await connection.closed).reason.includes('verified upgrade identity'),
    true,
  )
})

test('node session rejects protocol major mismatch before capability exchange', async () => {
  const connection = session()
  await connection.handleIncoming({
    version: 1,
    sequence: 0,
    type: 'hello',
    hello: { ...hello, protocolMajor: 2 },
  })
  await expectSessionError(
    'authentication-failed',
    () =>
      connection.handleIncoming({
        version: 1,
        sequence: 1,
        type: 'authenticate',
        authentication: auth,
      }),
  )
  assertEquals(
    (await connection.closed).reason,
    'protocol major versions do not match',
  )
})

test('node session gates capability advertise and withdrawal on authentication', async () => {
  const registry = approvedRegistry()
  const unauthenticated = session(registry)
  await unauthenticated.handleIncoming({
    version: 1,
    sequence: 0,
    type: 'hello',
    hello,
  })
  await expectSessionError(
    'unexpected-message',
    () =>
      unauthenticated.handleIncoming({
        version: 1,
        sequence: 1,
        type: 'node-support', nodeId: auth.nodeId, support: capability,
      }),
  )
  assertEquals(registry.nodeSupport(auth.nodeId), { operations: [] })

  const authenticated = session(registry)
  await authenticate(authenticated)
  await authenticated.handleIncoming({
    version: 1,
    sequence: 2,
    type: 'node-support', nodeId: auth.nodeId, support: capability,
  })
  assertEquals(registry.nodeSupport(auth.nodeId), capability)
  await authenticated.handleIncoming({
    version: 1,
    sequence: 3,
    type: 'node-support', nodeId: auth.nodeId, support: { operations: [] },
  })
  assertEquals(registry.nodeSupport(auth.nodeId), { operations: [] })
})

test('node session validates jobs and enforces frame, event, and receipt correlation', async () => {
  const registry = approvedRegistry()
  registry.advertiseNodeSupport(auth, auth.nodeId, capability)
  const received: JobEventV1[] = []
  const transport = new RecordingDuplex()
  const connection = new NodeConnectionSession(registry, transport, hello, {
    maxOutboundQueue: 8,
    heartbeatTimeoutMs: 30_000,
    onJobEvent: (event) => {
      received.push(event)
    },
  })
  await authenticateLive(connection)
  assertThrows(
    () => connection.dispatchJob({ ...request, deadlineAt: 'invalid' }),
    NodeSessionError,
  )
  connection.dispatchJob(request)

  const accepted: JobEventV1 = {
    version: 1,
    jobId: request.jobId,
    sequence: 0,
    timestamp: baseTime.toISOString(),
    type: 'accepted',
  }
  await connection.handleIncoming({
    version: 1,
    sequence: 3,
    type: 'job-event',
    event: accepted,
  })
  assertEquals(received, [accepted])
  await expectSessionError(
    'sequence-mismatch',
    () =>
      connection.handleIncoming({
        version: 1,
        sequence: 3,
        type: 'job-event',
        event: { ...accepted, sequence: 1 },
      }),
  )

  const correlation = session(registry)
  await authenticateLive(correlation)
  correlation.dispatchJob({
    ...request,
    jobId: 'job-2',
    idempotencyKey: 'idempotency-2',
  })
  await expectSessionError(
    'job-correlation-failed',
    () =>
      correlation.handleIncoming({
        version: 1,
        sequence: 3,
        type: 'job-event',
        event: { ...accepted, jobId: 'unknown-job' },
      }),
  )

  const eventOrder = session(registry)
  await authenticateLive(eventOrder)
  eventOrder.dispatchJob({
    ...request,
    jobId: 'job-3',
    idempotencyKey: 'idempotency-3',
  })
  await expectSessionError(
    'job-sequence-mismatch',
    () =>
      eventOrder.handleIncoming({
        version: 1,
        sequence: 3,
        type: 'job-event',
        event: { ...accepted, jobId: 'job-3', sequence: 1 },
      }),
  )
})

test('node session dispatches cancellation only for an active tracked job', async () => {
  const registry = approvedRegistry()
  registry.advertiseNodeSupport(auth, auth.nodeId, capability)
  const transport = new RecordingDuplex()
  const connection = session(registry, transport)
  await authenticateLive(connection)
  connection.dispatchJob(request)
  connection.dispatchCancellation(request.jobId)
  await Promise.resolve()
  await Promise.resolve()
  assertEquals(transport.sent.at(-1), {
    version: 1,
    sequence: 2,
    type: 'job-cancel',
    jobId: request.jobId,
  })
  assertThrows(
    () => connection.dispatchCancellation('unknown-job'),
    (error) => error instanceof NodeSessionError &&
      error.message.includes('cancellation references an unknown job'),
  )
})

test('node session applies an explicit bound to queued outbound work', async () => {
  const registry = approvedRegistry()
  registry.advertiseNodeSupport(auth, auth.nodeId, capability)
  const transport = new BlockingDuplex()
  const connection = session(registry, transport, { maxOutboundQueue: 1 })
  await authenticateLive(connection)
  await Promise.resolve()
  await Promise.resolve()
  assertEquals(connection.outboundInFlight, true)
  connection.dispatchJob(request)
  assertEquals(connection.outboundQueueSize, 1)
  assertThrows(
    () =>
      connection.dispatchJob({
        ...request,
        jobId: 'job-2',
        idempotencyKey: 'idempotency-2',
      }),
    (error) => error instanceof NodeSessionError &&
      error.message.includes('node outbound queue is full'),
  )
  transport.release()
  await connection.close({
    code: 'test-complete',
    reason: 'test complete',
    clean: true,
  })
})

test('node session heartbeat timeout closes a stale connection', async () => {
  let now = baseTime
  const connection = session(approvedRegistry(), new RecordingDuplex(), {
    heartbeatTimeoutMs: 1_000,
    now: () => now,
  })
  await authenticateLive(connection)
  now = new Date(baseTime.getTime() + 1_001)
  assertEquals(await connection.checkLiveness(), false)
  assertEquals(await connection.closed, {
    code: 'heartbeat-timeout',
    reason: 'node heartbeat timeout exceeded',
    clean: false,
  })
})

test('node session revocation removes capabilities and cleanly closes the duplex', async () => {
  const registry = approvedRegistry()
  registry.advertiseNodeSupport(auth, auth.nodeId, capability)
  const transport = new RecordingDuplex()
  const connection = session(registry, transport)
  await authenticateLive(connection)
  await connection.revoke(
    'operator revoked device',
    new Date(baseTime.getTime() + 3_000),
  )
  assertEquals(connection.state, 'closed')
  assertEquals(await transport.closed, {
    code: 'revoked',
    reason: 'operator revoked device',
    clean: true,
  })
  assertEquals(registry.nodeSupport(auth.nodeId), { operations: [] })
  assertThrows(
    () => registry.authenticate(auth),
    (error) => error instanceof RegistryError && error.code === 'node-revoked',
  )
})

test('retiring node privileges preserves fresh revocation checks for job dispatch and results', async () => {
  const registry = approvedRegistry()
  registry.advertiseNodeSupport(auth, auth.nodeId, capability)
  const connection = session(registry)
  try {
    await authenticateLive(connection)
    connection.dispatchJob(request)
    registry.revoke(auth, 'revoked outside this connection', baseTime)
    assertThrows(
      () => connection.dispatchJob({ ...request, jobId: 'another-job' }),
      (error) => error instanceof RegistryError && error.code === 'node-revoked',
    )
    await expectSessionError('authorization-failed', () => connection.handleIncoming({
      version: 1, sequence: 3, type: 'job-event',
      event: { version: 1, jobId: request.jobId, sequence: 0, timestamp: baseTime.toISOString(), type: 'accepted' },
    }))
  } finally {
    await connection.close({ code: 'test-complete', reason: 'test complete', clean: true })
  }
})

test('inventory connection notifications expose authenticated and closed state only once', async () => {
  const states: string[] = []
  const connection = new NodeConnectionSession(approvedRegistry(), new RecordingDuplex(), hello, {
    maxOutboundQueue: 128, heartbeatTimeoutMs: 90_000, now: () => baseTime,
    onConnectionChange: () => { states.push(connection.state); throw new Error('test observer failure') },
  })
  await authenticateLive(connection)
  assertEquals(states, ['authenticated'])
  await connection.close({ code: 'peer-going-away', reason: 'test', clean: true })
  await connection.close({ code: 'peer-going-away', reason: 'test', clean: true })
  assertEquals(states, ['authenticated', 'closed'])
  const unauthenticated = new NodeConnectionSession(approvedRegistry(), new RecordingDuplex(), hello, {
    maxOutboundQueue: 128, heartbeatTimeoutMs: 90_000,
    onConnectionChange: () => states.push('unexpected'),
  })
  await unauthenticated.close({ code: 'peer-going-away', reason: 'test', clean: true })
  assertEquals(states, ['authenticated', 'closed'])
})

async function authenticateLive(connection: NodeConnectionSession): Promise<void> {
  await authenticate(connection)
  await connection.handleIncoming({ version: 1, sequence: 2, type: 'node-support', nodeId: auth.nodeId, support: capability })
}


test('Main refuses legacy execution peers and missing, offline or withdrawn workdirs before transport, including reconcile', async () => {
  const registry = approvedRegistry()
  const transport = new RecordingDuplex()
  const connection = session(registry, transport)
  await authenticate(connection)
  const workdir = { version: 2 as const, nodeId: auth.nodeId, workdirId: 'directory', displayName: 'Directory', online: true, support: { operations: ['filesystem.read','filesystem.write','workdir.git.status','workdir.git.diff','workdir.identity','workdir.process.execute','workdir.process.execute-once','workdir.process.reconcile'] } }
  const descriptor = { ...workdir, support: { operations: ['workdir.process.execute-once', 'workdir.process.reconcile'], shell: { shells: ['sh'], maxInputBytes: 32768, maxDeadlineMs: 120000 } } }
  const job = { ...request, nodeId: auth.nodeId, workdirId: 'directory', operation: 'workdir.process.reconcile', args: { script: 'echo no' } }
  assertThrows(() => connection.dispatchJob(job), /workdir.*missing|workdir is missing/)
  await connection.handleIncoming({ version: 1, sequence: 2, type: 'workdir-advertise', workdir: { ...descriptor, online: false } })
  assertThrows(() => connection.dispatchJob(job), /workdir.*missing|workdir is missing/)
  await connection.handleIncoming({ version: 1, sequence: 3, type: 'workdir-advertise', workdir: descriptor })
  assertThrows(() => connection.dispatchJob({ ...job, args: { script: 'x'.repeat(40000) } }), /shell support limits/)
  await connection.handleIncoming({ version: 1, sequence: 4, type: 'workdir-advertise', workdir: { ...descriptor, support: { operations: [] } } })
  assertThrows(() => connection.dispatchJob(job), /No live support/)
  await connection.handleIncoming({ version: 1, sequence: 5, type: 'workdir-advertise', workdir: descriptor })
  await connection.handleIncoming({ version: 1, sequence: 6, type: 'workdir-withdraw', nodeId: auth.nodeId, workdirId: 'directory' })
  assertThrows(() => connection.dispatchJob(job), /workdir.*missing|workdir is missing/)
  assertEquals(transport.sent.some((frame: any) => frame.type === 'job-request'), false)
  await connection.close({ code: 'test-complete', reason: 'test', clean: true })

  const old = session(registry)
  await old.handleIncoming({ version: 1, sequence: 0, type: 'hello', hello: { ...hello, features: ['jobs-v1'] } })
  await old.handleIncoming({ version: 1, sequence: 1, type: 'authenticate', authentication: auth })
  assertEquals(old.supportsExecutionProtocol(), false)
  assertThrows(() => old.dispatchJob(job), /Upgrade both Main and Child/)
  await old.close({ code: 'test-complete', reason: 'test', clean: true })
})
