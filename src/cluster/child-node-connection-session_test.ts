import { fixtureDirectoryAdmission } from '../execution/test-fixtures.ts'
import { deepEqual as assertEquals, rejects as assertRejects, throws as assertThrows } from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { rm, writeFile } from 'node:fs/promises'
import { createTempWorkspace } from '../testing/workspace.ts'
import type {
  CancelReceiptV1,
  JobEventV1,
  ExecutionRequestV2,
  JobStatusV1,
} from '../execution/contracts.ts'
import type { Executor } from '../execution/executor.ts'
import { LocalExecutor } from '../execution/local-executor.ts'
import {
  CapabilityFilesystem,
  FILESYSTEM_READ_OPERATION,
} from '../execution/capability-filesystem.ts'
import { ChildNodeConnectionSession } from './child-node-connection-session.ts'
import type { ExecutionSupport, VersionHelloV1 } from './contracts.ts'
import { createInMemoryNodeDuplexPair } from './in-memory-node-duplex.ts'
import {
  NodeConnectionSession,
  NodeSessionError,
} from './node-connection-session.ts'
import type { DuplexCloseInfo, NodeMessageDuplex } from './node-transport.ts'
import { InMemoryPairingNodeRegistry } from './registry.ts'

const baseTime = new Date('2026-08-26T00:00:00.000Z')
const auth = {
  deviceId: 'device-1',
  nodeId: 'node-1',
  credentialId: 'credential-1',
}
const mainHello: VersionHelloV1 = {
  protocolMajor: 1,
  protocolMinor: 2,
  implementationVersion: 'main-0.1.0',
  features: ['workdir-execution-v2'],
}
const childHello: VersionHelloV1 = {
  ...mainHello,
  implementationVersion: 'child-0.1.0',
}
const capability: ExecutionSupport = { operations: ['process.execute'] }
const request: ExecutionRequestV2 = {
  version: 2,
  jobId: 'job-1',
  idempotencyKey: 'idempotency-1',
  sessionId: 'session-1',
  turnId: 'turn-1',
  nodeId: auth.nodeId,
  projectScope: '0123456789abcdef0123456789abcdef',
  operation: 'process.execute',
  args: { command: 'echo hello' },
  createdAt: baseTime.toISOString(),
  deadlineAt: new Date(baseTime.getTime() + 60_000).toISOString(),
}

class SuccessfulExecutor implements Executor {
  readonly requests: ExecutionRequestV2[] = []

  async *execute(request: ExecutionRequestV2): AsyncIterable<JobEventV1> {
    this.requests.push(structuredClone(request))
    yield event(request.jobId, 0, 'accepted')
    yield event(request.jobId, 1, 'stdout', { chunk: 'hello\n' })
    yield terminalEvent(request.jobId, 2, 'completed', 'completed')
  }

  getStatus(_jobId: string): Promise<JobStatusV1 | null> {
    return Promise.resolve(null)
  }

  cancel(jobId: string): Promise<CancelReceiptV1> {
    return Promise.resolve(cancelReceipt(jobId, 'not-found'))
  }
}

class CancellableExecutor implements Executor {
  readonly cancelled: string[] = []
  readonly #cancelled = Promise.withResolvers<void>()

  async *execute(request: ExecutionRequestV2): AsyncIterable<JobEventV1> {
    yield event(request.jobId, 0, 'accepted')
    await this.#cancelled.promise
    yield terminalEvent(
      request.jobId,
      1,
      'cancel-acknowledged',
      'cancelled',
    )
  }

  getStatus(_jobId: string): Promise<JobStatusV1 | null> {
    return Promise.resolve(null)
  }

  cancel(jobId: string): Promise<CancelReceiptV1> {
    this.cancelled.push(jobId)
    this.#cancelled.resolve()
    return Promise.resolve(cancelReceipt(jobId, 'requested'))
  }
}

class BlockingAfterHandshakeDuplex implements NodeMessageDuplex {
  readonly incoming: AsyncIterable<unknown>
  readonly closed: Promise<DuplexCloseInfo>
  readonly #delegate: NodeMessageDuplex
  readonly #sendGate = Promise.withResolvers<void>()
  #sendCount = 0

  constructor(delegate: NodeMessageDuplex) {
    this.#delegate = delegate
    this.incoming = delegate.incoming
    this.closed = delegate.closed
  }

  async send(message: unknown): Promise<void> {
    if (this.#sendCount++ >= 2) await this.#sendGate.promise
    await this.#delegate.send(message)
  }

  close(info: DuplexCloseInfo): Promise<void> {
    return this.#delegate.close(info)
  }

  release(): void {
    this.#sendGate.resolve()
  }
}

function event(
  jobId: string,
  sequence: number,
  type: 'accepted' | 'stdout',
  extra: { chunk: string } | Record<string, never> = {},
): JobEventV1 {
  return {
    version: 1,
    jobId,
    sequence,
    timestamp: baseTime.toISOString(),
    type,
    ...extra,
  } as JobEventV1
}

function terminalEvent(
  jobId: string,
  sequence: number,
  type: 'completed' | 'cancel-acknowledged',
  state: 'completed' | 'cancelled',
): JobEventV1 {
  return {
    version: 1,
    jobId,
    sequence,
    timestamp: baseTime.toISOString(),
    type,
    receipt: {
      version: 1,
      jobId,
      nodeId: auth.nodeId,
      state,
      finishedAt: baseTime.toISOString(),
    },
  }
}

function cancelReceipt(
  jobId: string,
  outcome: CancelReceiptV1['outcome'],
): CancelReceiptV1 {
  return {
    version: 1,
    jobId,
    outcome,
    timestamp: baseTime.toISOString(),
    status: null,
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

function childSession(
  transport: NodeMessageDuplex,
  executor: Executor,
  options: {
    maxOutboundQueue?: number
    heartbeatTimeoutMs?: number
    now?: () => Date
  } = {},
): ChildNodeConnectionSession {
  return new ChildNodeConnectionSession(
    transport,
    childHello,
    auth,
    executor,
    {
      maxOutboundQueue: options.maxOutboundQueue ?? 8,
      heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? 30_000,
      now: options.now,
    },
  )
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return
    await Promise.resolve()
  }
  throw new Error('condition was not reached')
}

async function closePair(
  child: ChildNodeConnectionSession,
  childRun: Promise<void>,
  mainRun: Promise<void>,
): Promise<void> {
  await child.close({
    code: 'test-complete',
    reason: 'test complete',
    clean: true,
  })
  await Promise.all([childRun, mainRun])
}

test('child node session handshakes, advertises, executes, streams, and withdraws', async () => {
  const registry = approvedRegistry()
  const pair = createInMemoryNodeDuplexPair()
  const received: JobEventV1[] = []
  const terminal = Promise.withResolvers<void>()
  const main = new NodeConnectionSession(registry, pair.server, mainHello, {
    maxOutboundQueue: 8,
    heartbeatTimeoutMs: 30_000,
    onJobEvent: (jobEvent) => {
      received.push(jobEvent)
      if (jobEvent.type === 'completed') terminal.resolve()
    },
  })
  const executor = new SuccessfulExecutor()
  const child = childSession(pair.client, executor)
  const mainRun = main.run()
  const childRun = child.run()

  assertEquals(await child.authenticated, {
    protocolMajor: 1,
    protocolMinor: 2,
    features: childHello.features,
  })
  child.advertiseNodeSupport(capability)
  await waitFor(() => registry.nodeSupport(auth.nodeId).operations.length === 1)
  main.dispatchJob(request)
  await terminal.promise

  assertEquals(executor.requests, [request])
  assertEquals(received.map((jobEvent) => jobEvent.sequence), [0, 1, 2])
  assertEquals(received.map((jobEvent) => jobEvent.type), [
    'accepted',
    'stdout',
    'completed',
  ])
  assertEquals(child.advertiseNodeSupport({ operations: [] }), { operations: [] })
  await waitFor(() => registry.nodeSupport(auth.nodeId).operations.length === 0)
  await closePair(child, childRun, mainRun)
})

test('chunked job output waits for transport capacity instead of disconnecting a slow reader', { timeout: 5000 }, async () => {
  const registry = approvedRegistry()
  const pair = createInMemoryNodeDuplexPair()
  const received: JobEventV1[] = []
  const terminal = Promise.withResolvers<void>()
  const main = new NodeConnectionSession(registry, pair.server, mainHello, {
    maxOutboundQueue: 8, heartbeatTimeoutMs: 30_000,
    onJobEvent: event => { received.push(event); if (event.type === 'completed') terminal.resolve() },
  })
  const executor = new SuccessfulExecutor()
  executor.execute = async function* (request) {
    yield event(request.jobId, 0, 'accepted')
    for (let sequence = 1; sequence <= 32; sequence++) {
      yield event(request.jobId, sequence, 'stdout', { chunk: String(sequence) })
    }
    yield terminalEvent(request.jobId, 33, 'completed', 'completed')
  }
  const child = childSession({
    incoming: pair.client.incoming, closed: pair.client.closed,
    send: async message => { await delay(1); await pair.client.send(message) },
    close: info => pair.client.close(info),
  }, executor, { maxOutboundQueue: 1 })
  const mainRun = main.run()
  const childRun = child.run()
  try {
    await child.authenticated
    child.advertiseNodeSupport(capability)
    while (!registry.nodeSupport(auth.nodeId).operations.length) await delay(1)
    main.dispatchJob(request)
    await terminal.promise
    assertEquals(received.map(event => event.sequence), Array.from({ length: 34 }, (_, i) => i))
    assertEquals(child.state, 'authenticated')
  } finally { await closePair(child, childRun, mainRun) }
})

test('workdir display metadata is advertised by new protocol only and never becomes a capability path', async () => {
  const registry = approvedRegistry()
  const pair = createInMemoryNodeDuplexPair()
  const main = new NodeConnectionSession(registry, pair.server, mainHello, { maxOutboundQueue: 8, heartbeatTimeoutMs: 30_000 })
  const child = childSession(pair.client, new SuccessfulExecutor())
  const mainRun = main.run(); const childRun = child.run()
  try {
    await child.authenticated
    const workdir = { version: 2 as const, nodeId: auth.nodeId, workdirId: 'folder', displayName: 'Folder', displayPath: '/child/folder', online: true, support: { operations: ['filesystem.read','filesystem.write','workdir.git.status','workdir.git.diff','workdir.identity','workdir.process.execute','workdir.process.execute-once','workdir.process.reconcile'] } }
    child.advertiseWorkdir(workdir)
    await waitFor(() => registry.listWorkdirs(auth.nodeId).length === 1)
    assertEquals(registry.listWorkdirs(auth.nodeId)[0].displayPath, '/child/folder')
    assertThrows(() => child.advertiseWorkdir({ ...workdir, displayPath: '/child\nforged' }), NodeSessionError)
    assertThrows(() => child.advertiseWorkdir({ ...workdir, nodeId: 'another-node' }), NodeSessionError)
    assertThrows(() => child.advertiseNodeSupport({ ...capability, displayPath: '/child/folder' }), NodeSessionError)
  } finally { await closePair(child, childRun, mainRun) }
})

test('child node session executes a confined workdir read and rejects shell capability confusion', async () => {
  const directory = await createTempWorkspace()
  await writeFile(`${directory}/message.txt`, 'remote workdir')
  try {
    const registry = approvedRegistry()
    const pair = createInMemoryNodeDuplexPair()
    const received = new Map<string, JobEventV1[]>()
    const completed = new Map([
      ['workdir-read', Promise.withResolvers<void>()],
      ['workdir-shell', Promise.withResolvers<void>()],
    ])
    const main = new NodeConnectionSession(registry, pair.server, mainHello, {
      maxOutboundQueue: 8,
      heartbeatTimeoutMs: 30_000,
      onJobEvent: (jobEvent) => {
        const events = received.get(jobEvent.jobId) ?? []
        events.push(jobEvent)
        received.set(jobEvent.jobId, events)
        if ('receipt' in jobEvent) completed.get(jobEvent.jobId)?.resolve()
      },
    })
    let spawnCount = 0
    const executor = new LocalExecutor(
      {
        spawn: () => {
          spawnCount++
          throw new Error('process spawn must not be reached')
        },
      },
      auth.nodeId,
      [
        new CapabilityFilesystem([{
          workdirId: 'workdir-1',
          rootPath: directory,
        }]),
      ],
      fixtureDirectoryAdmission(auth.nodeId, [{ workdirId: 'workdir-1', rootPath: directory }]),
    )
    const child = childSession(pair.client, executor)
    const mainRun = main.run()
    const childRun = child.run()
    const workdirCapability = { version: 2, nodeId: auth.nodeId, workdirId: 'workdir-1', displayName: 'Test workdir', online: true, support: { operations: ['filesystem.read', 'filesystem.write'] } }

    await child.authenticated
    child.advertiseWorkdir({ version: 2 as const, nodeId: auth.nodeId, workdirId: 'workdir-1', displayName: 'Folder', online: true, support: { operations: ['filesystem.read','filesystem.write','workdir.git.status','workdir.git.diff','workdir.identity','workdir.process.execute','workdir.process.execute-once','workdir.process.reconcile'] } })
    child.advertiseWorkdir(workdirCapability as import('../execution/workdir-contracts.ts').WorkdirAdvertisement)
    await waitFor(() => registry.listWorkdirs(auth.nodeId)[0]?.support.operations.length === 2)
    const createdAt = new Date()
    main.dispatchJob({
      ...request,
      jobId: 'workdir-read',
      idempotencyKey: 'workdir-read-key',
      nodeId: auth.nodeId, workdirId: 'workdir-1',
      operation: FILESYSTEM_READ_OPERATION,
      args: { path: 'message.txt' },
      createdAt: createdAt.toISOString(),
      deadlineAt: new Date(createdAt.getTime() + 10_000).toISOString(),
    })
    await completed.get('workdir-read')?.promise
    assertThrows(() => main.dispatchJob({
      ...request,
      jobId: 'workdir-shell',
      idempotencyKey: 'workdir-shell-key',
      nodeId: auth.nodeId, workdirId: 'workdir-1',
      operation: 'process.execute',
      args: { script: 'echo denied', cwd: directory },
      createdAt: createdAt.toISOString(),
      deadlineAt: new Date(createdAt.getTime() + 10_000).toISOString(),
    }), /directory operations require workdirId/)

    assertEquals(received.get('workdir-read')?.map((event) => event.type), [
      'accepted',
      'stdout',
      'completed',
    ])
    const readOutput = received.get('workdir-read')?.find((event) =>
      event.type === 'stdout'
    )
    assertEquals(
      readOutput?.type === 'stdout' ? readOutput.chunk : undefined,
      'remote workdir',
    )
    assertEquals(received.has('workdir-shell'), false)
    assertEquals(spawnCount, 0)
    await closePair(child, childRun, mainRun)
  } finally {
    await rm(directory, { recursive: true })
  }
})

test('child node session rejects authenticated when closed before authentication', async () => {
  const pair = createInMemoryNodeDuplexPair()
  const child = childSession(pair.client, new SuccessfulExecutor())
  const running = child.run()
  const incoming = pair.server.incoming[Symbol.asyncIterator]()
  await incoming.next()
  await incoming.next()

  await child.close({
    code: 'test-complete',
    reason: 'closed before authentication',
    clean: true,
  })

  await assertRejects(
    () => child.authenticated,
    (error) => error instanceof NodeSessionError &&
      error.message.includes('closed before authentication'),
  )
  await running
})

test('child node session forwards Main cancellation to Executor', async () => {
  const registry = approvedRegistry()
  const pair = createInMemoryNodeDuplexPair()
  const accepted = Promise.withResolvers<void>()
  const cancelled = Promise.withResolvers<void>()
  const main = new NodeConnectionSession(registry, pair.server, mainHello, {
    maxOutboundQueue: 8,
    heartbeatTimeoutMs: 30_000,
    onJobEvent: (jobEvent) => {
      if (jobEvent.type === 'accepted') accepted.resolve()
      if (jobEvent.type === 'cancel-acknowledged') cancelled.resolve()
    },
  })
  const executor = new CancellableExecutor()
  const child = childSession(pair.client, executor)
  const mainRun = main.run()
  const childRun = child.run()

  await waitFor(() => child.state === 'authenticated')
  child.advertiseNodeSupport(capability)
  await waitFor(() => registry.nodeSupport(auth.nodeId).operations.length === 1)
  main.dispatchJob(request)
  await accepted.promise
  main.dispatchCancellation(request.jobId)
  await cancelled.promise

  assertEquals(executor.cancelled, [request.jobId])
  await closePair(child, childRun, mainRun)
})

test('child node session rejects job dispatch before authentication result', async () => {
  const pair = createInMemoryNodeDuplexPair()
  const child = childSession(pair.client, new SuccessfulExecutor())
  const running = child.run()
  const incoming = pair.server.incoming[Symbol.asyncIterator]()
  assertEquals((await incoming.next()).value, {
    version: 1,
    sequence: 0,
    type: 'hello',
    hello: childHello,
  })
  assertEquals((await incoming.next()).value, {
    version: 1,
    sequence: 1,
    type: 'authenticate',
    authentication: auth,
  })
  await pair.server.send({
    version: 1,
    sequence: 0,
    type: 'job-request',
    request,
  })
  await assertRejects(
    () => running,
    (error) => error instanceof NodeSessionError && error.code === 'unexpected-message',
  )
  assertEquals((await child.closed).clean, false)
})

test('child node session sends heartbeats and closes when Main is stale', async () => {
  let now = baseTime
  const pair = createInMemoryNodeDuplexPair()
  const child = childSession(pair.client, new SuccessfulExecutor(), {
    heartbeatTimeoutMs: 1_000,
    now: () => now,
  })
  const running = child.run()
  const incoming = pair.server.incoming[Symbol.asyncIterator]()
  await incoming.next()
  await incoming.next()
  await pair.server.send({
    version: 1,
    sequence: 0,
    type: 'authenticated',
    negotiated: {
      protocolMajor: 1,
      protocolMinor: 2,
      features: childHello.features,
    },
  })
  await waitFor(() => child.state === 'authenticated')
  child.sendHeartbeat()
  assertEquals((await incoming.next()).value, {
    version: 1,
    sequence: 2,
    type: 'heartbeat',
    sentAt: baseTime.toISOString(),
  })
  now = new Date(baseTime.getTime() + 1_001)
  assertEquals(await child.checkLiveness(), false)
  assertEquals((await child.closed).code, 'heartbeat-timeout')
  await running
})

test('child node session bounds queued outbound frames behind a blocked send', async () => {
  const pair = createInMemoryNodeDuplexPair()
  const transport = new BlockingAfterHandshakeDuplex(pair.client)
  const child = childSession(transport, new SuccessfulExecutor(), {
    maxOutboundQueue: 1,
  })
  const running = child.run()
  const incoming = pair.server.incoming[Symbol.asyncIterator]()
  await incoming.next()
  await incoming.next()
  await pair.server.send({
    version: 1,
    sequence: 0,
    type: 'authenticated',
    negotiated: {
      protocolMajor: 1,
      protocolMinor: 2,
      features: childHello.features,
    },
  })
  await waitFor(() => child.state === 'authenticated')

  child.advertiseNodeSupport(capability)
  await waitFor(() => child.outboundInFlight)
  child.advertiseNodeSupport({ operations: [] })
  assertEquals(child.outboundQueueSize, 1)
  assertThrows(
    () =>
      child.advertiseNodeSupport({
        operations: ['process.execute'],
      }),
    (error) => error instanceof NodeSessionError &&
      error.message.includes('child node outbound queue is full'),
  )

  transport.release()
  await child.close({
    code: 'test-complete',
    reason: 'test complete',
    clean: true,
  })
  await running
})


test('new Child explicitly refuses an authenticated old Main rather than downgrading execution', async () => {
  const registry = approvedRegistry()
  const pair = createInMemoryNodeDuplexPair()
  const main = new NodeConnectionSession(registry, pair.server, { ...mainHello, features: ['jobs-v1'] }, { maxOutboundQueue: 8, heartbeatTimeoutMs: 30000 })
  const executor = new SuccessfulExecutor()
  const child = childSession(pair.client, executor)
  const mainRun = main.run(); const childRun = child.run()
  mainRun.catch(() => {}); childRun.catch(() => {})
  await assertRejects(child.authenticated, /Upgrade both Main and Child/)
  assertEquals(executor.requests.length, 0)
  await Promise.allSettled([mainRun, childRun])
})
