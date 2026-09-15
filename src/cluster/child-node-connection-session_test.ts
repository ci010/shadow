import { deepEqual as assertEquals, rejects as assertRejects, throws as assertThrows } from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { rm, writeFile } from 'node:fs/promises'
import { createTempWorkspace } from '../testing/workspace.ts'
import type {
  CancelReceiptV1,
  JobEventV1,
  JobRequestV1,
  JobStatusV1,
} from '../execution/contracts.ts'
import type { Executor } from '../execution/executor.ts'
import { LocalExecutor } from '../execution/local-executor.ts'
import {
  CapabilityFilesystem,
  FILESYSTEM_READ_OPERATION,
} from '../execution/capability-filesystem.ts'
import { InMemoryLocalApprovalService } from '../execution/local-approval.ts'
import { ChildNodeConnectionSession } from './child-node-connection-session.ts'
import type { CapabilityDescriptorV1, VersionHelloV1 } from './contracts.ts'
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
  features: ['jobs-v1', 'capabilities-v1'],
}
const childHello: VersionHelloV1 = {
  ...mainHello,
  implementationVersion: 'child-0.1.0',
}
const capability: CapabilityDescriptorV1 = {
  version: 1,
  capabilityId: 'shell-1',
  nodeId: auth.nodeId,
  kind: 'shell',
  displayName: 'Project shell',
  permissions: ['process.execute'],
  approvalPolicy: 'session',
  online: true,
}
const request: JobRequestV1 = {
  version: 1,
  jobId: 'job-1',
  idempotencyKey: 'idempotency-1',
  sessionId: 'session-1',
  turnId: 'turn-1',
  nodeId: auth.nodeId,
  capabilityId: capability.capabilityId,
  operation: 'shell.execute',
  args: { command: 'echo hello' },
  createdAt: baseTime.toISOString(),
  deadlineAt: new Date(baseTime.getTime() + 60_000).toISOString(),
  approval: 'none',
}

class SuccessfulExecutor implements Executor {
  readonly requests: JobRequestV1[] = []

  async *execute(request: JobRequestV1): AsyncIterable<JobEventV1> {
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

  async *execute(request: JobRequestV1): AsyncIterable<JobEventV1> {
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
    uiScopes: [],
    nodePrivileges: ['capabilities:advertise', 'jobs:execute'],
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
  child.advertiseCapability(capability)
  await waitFor(() => registry.listCapabilities(auth.nodeId).length === 1)
  main.dispatchJob(request)
  await terminal.promise

  assertEquals(executor.requests, [request])
  assertEquals(received.map((jobEvent) => jobEvent.sequence), [0, 1, 2])
  assertEquals(received.map((jobEvent) => jobEvent.type), [
    'accepted',
    'stdout',
    'completed',
  ])
  assertEquals(child.withdrawCapability(capability.capabilityId), true)
  await waitFor(() => registry.listCapabilities(auth.nodeId).length === 0)
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
    child.advertiseCapability(capability)
    while (!registry.listCapabilities(auth.nodeId).length) await delay(1)
    main.dispatchJob(request)
    await terminal.promise
    assertEquals(received.map(event => event.sequence), Array.from({ length: 34 }, (_, i) => i))
    assertEquals(child.state, 'authenticated')
  } finally { await closePair(child, childRun, mainRun) }
})

test('workdir display metadata is advertised only when negotiated with Main', async () => {
  for (const supported of [false, true]) {
    const registry = approvedRegistry()
    const pair = createInMemoryNodeDuplexPair()
    const displayHello = { ...mainHello, features: [...mainHello.features, 'workdir-display-v1'] }
    const main = new NodeConnectionSession(registry, pair.server, supported ? displayHello : mainHello, {
      maxOutboundQueue: 8, heartbeatTimeoutMs: 30_000,
    })
    const child = new ChildNodeConnectionSession(
      pair.client, displayHello, auth, new SuccessfulExecutor(),
      { maxOutboundQueue: 8, heartbeatTimeoutMs: 30_000 },
    )
    const mainRun = main.run()
    const childRun = child.run()
    try {
      await child.authenticated
      child.advertiseCapability({
        ...capability, kind: 'workdir', displayPath: '/child/project',
      })
      await waitFor(() => registry.listCapabilities(auth.nodeId).length === 1)
      const advertised = registry.listCapabilities(auth.nodeId)[0]
      assertEquals(advertised.displayPath, supported ? '/child/project' : undefined)
      assertThrows(() => child.advertiseCapability({
        ...capability, kind: 'workdir', displayPath: '/child\nforged',
      }), NodeSessionError)
      assertThrows(() => child.advertiseCapability({
        ...capability, nodeId: 'another-node', kind: 'workdir', displayPath: '/child/project',
      }), NodeSessionError)
    } finally {
      await closePair(child, childRun, mainRun)
    }
  }
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
    const approvals = new InMemoryLocalApprovalService([{
      capabilityId: 'workdir-1',
      displayName: 'Test workdir',
      policy: 'grant',
    }])
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
          capabilityId: 'workdir-1',
          rootPath: directory,
        }]),
      ],
      ['shell-1'],
      approvals,
    )
    const child = childSession(pair.client, executor)
    const mainRun = main.run()
    const childRun = child.run()
    const workdirCapability: CapabilityDescriptorV1 = {
      version: 1,
      capabilityId: 'workdir-1',
      nodeId: auth.nodeId,
      kind: 'workdir',
      displayName: 'Test workdir',
      permissions: ['filesystem.read', 'filesystem.write'],
      approvalPolicy: 'grant',
      online: true,
    }

    await child.authenticated
    child.advertiseCapability(workdirCapability)
    await waitFor(() => registry.listCapabilities(auth.nodeId).length === 1)
    const createdAt = new Date()
    main.dispatchJob({
      ...request,
      jobId: 'workdir-read',
      idempotencyKey: 'workdir-read-key',
      capabilityId: workdirCapability.capabilityId,
      operation: FILESYSTEM_READ_OPERATION,
      args: { path: 'message.txt' },
      createdAt: createdAt.toISOString(),
      deadlineAt: new Date(createdAt.getTime() + 10_000).toISOString(),
    })
    await waitFor(() => approvals.listPending().length === 1)
    assertEquals(approvals.approve('workdir-read', 'once'), true)
    await completed.get('workdir-read')?.promise
    main.dispatchJob({
      ...request,
      jobId: 'workdir-shell',
      idempotencyKey: 'workdir-shell-key',
      capabilityId: workdirCapability.capabilityId,
      operation: 'process.execute',
      args: { script: 'echo denied', cwd: directory },
      createdAt: createdAt.toISOString(),
      deadlineAt: new Date(createdAt.getTime() + 10_000).toISOString(),
    })
    await completed.get('workdir-shell')?.promise

    assertEquals(received.get('workdir-read')?.map((event) => event.type), [
      'accepted',
      'awaiting-approval',
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
    const denied = received.get('workdir-shell')?.at(-1)
    assertEquals(denied?.type, 'rejected')
    assertEquals(
      denied && 'receipt' in denied ? denied.receipt.reason?.code : undefined,
      'capability-denied',
    )
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
  child.advertiseCapability(capability)
  await waitFor(() => registry.listCapabilities(auth.nodeId).length === 1)
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

  child.advertiseCapability(capability)
  await waitFor(() => child.outboundInFlight)
  child.advertiseCapability({ ...capability, capabilityId: 'shell-2' })
  assertEquals(child.outboundQueueSize, 1)
  assertThrows(
    () =>
      child.advertiseCapability({
        ...capability,
        capabilityId: 'shell-3',
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
