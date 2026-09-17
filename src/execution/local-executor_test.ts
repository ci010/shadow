import assert, { deepEqual as assertEquals, rejects as assertRejects } from 'node:assert/strict'
import { test } from 'node:test'
import { cwd } from 'node:process'
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createTempWorkspace } from '../testing/workspace.ts'
import type { ChildProcess } from 'node:child_process'
import type {
  ManagedProcess,
  ManagedProcessStatus,
  ProcessManager,
} from './processes/manager.ts'
import type { JobEventV1, JobRequestV1 } from './contracts.ts'
import {
  validateCancelReceiptV1,
  validateJobEventV1,
  validateJobRequestV1,
  validateJobStatusV1,
} from './contracts.ts'
import { LocalExecutor } from './local-executor.ts'
import {
  CapabilityFilesystem,
  FILESYSTEM_READ_OPERATION,
  FILESYSTEM_WRITE_OPERATION,
} from './capability-filesystem.ts'

function request(
  jobId: string,
  overrides: Partial<JobRequestV1> = {},
): JobRequestV1 {
  const createdAt = new Date()
  return {
    version: 1,
    jobId,
    idempotencyKey: `key-${jobId}`,
    sessionId: 'session-1',
    turnId: 'turn-1',
    nodeId: 'local',
    capabilityId: 'shell-1',
    operation: 'process.execute',
    args: { script: 'ignored', cwd: cwd() },
    createdAt: createdAt.toISOString(),
    deadlineAt: new Date(createdAt.getTime() + 10_000).toISOString(),
    ...overrides,
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve = (_value: T) => {}
  const promise = new Promise<T>((done) => resolve = done)
  return { promise, resolve }
}

class FakeProcessManager {
  spawnCount = 0
  processes: ManagedProcess[] = []
  spawnArgs: unknown[][] = []

  constructor(private autoComplete = true) {}

  spawn(...args: unknown[]): Promise<ManagedProcess> {
    this.spawnCount++
    this.spawnArgs.push(args)
    const exit = deferred<ManagedProcessStatus>()
    let settled = false
    const finish = (status: ManagedProcessStatus) => {
      if (settled) return
      settled = true
      exit.resolve(status)
    }
    const process = {
      kill: () => {
        finish({ success: false, code: -1, signal: 'SIGTERM' })
        return true
      },
    } as unknown as ChildProcess
    const managed: ManagedProcess = {
      pid: 1000 + this.spawnCount,
      command: 'ignored',
      cwd: cwd(),
      shell: 'cmd',
      startedAt: new Date(),
      process,
      stdoutChunks: [new TextEncoder().encode('stdout')],
      stderrChunks: [],
      exitPromise: exit.promise,
    }
    this.processes.push(managed)
    if (this.autoComplete) {
      queueMicrotask(() => finish({ success: true, code: 0, signal: null }))
    }
    return Promise.resolve(managed)
  }
}

test('LocalExecutor startProcess validates and forwards process arguments unchanged', async () => {
  const manager = new FakeProcessManager()
  const executor = new LocalExecutor(
    manager as unknown as Pick<ProcessManager, 'spawn'>,
  )
  const process = await executor.startProcess({
    script: 'printf test',
    cwd: '/workspace',
    env: { TEST_VALUE: 'present' },
    shell: 'bash',
    args: ['one', 'two'],
  })

  assertEquals(process.pid, 1001)
  assertEquals(manager.spawnArgs, [[
    'printf test',
    '/workspace',
    { TEST_VALUE: 'present' },
    'bash',
    ['one', 'two'],
  ]])
  await assertRejects(
    () => executor.startProcess({ script: '', cwd: '/workspace' }),
    { name: 'TypeError', message: /Invalid ProcessExecuteArgsV1/ },
  )
})

class BlockingProcessManager extends FakeProcessManager {
  constructor() {
    super(false)
  }
}

async function collect(
  iterable: AsyncIterable<JobEventV1>,
): Promise<JobEventV1[]> {
  const events: JobEventV1[] = []
  for await (const event of iterable) events.push(event)
  return events
}

test('execution contracts validate versions, malformed data, and unknown fields', () => {
  const valid = request('validation')
  assert(validateJobRequestV1(valid).success)
  assertEquals(validateJobRequestV1({ ...valid, version: 2 }).success, false)
  assertEquals(validateJobRequestV1({ ...valid, surprise: true }).success, false)
  for (const approval of ['none', 'local-required']) {
    assertEquals(validateJobRequestV1({ ...valid, approval }).success, false)
  }
  assertEquals(
    validateJobRequestV1({ ...valid, deadlineAt: 'not-a-date' }).success,
    false,
  )

  const event: JobEventV1 = {
    version: 1,
    jobId: valid.jobId,
    sequence: 0,
    timestamp: valid.createdAt,
    type: 'accepted',
  }
  assert(validateJobEventV1(event).success)
  assertEquals(validateJobEventV1({ ...event, type: 'future-event' }).success, false)
  assertEquals(validateJobEventV1({ ...event, type: 'awaiting-approval' }).success, false)
})

test('LocalExecutor deduplicates jobId and emits one ordered terminal stream', async () => {
  const manager = new FakeProcessManager()
  const executor = new LocalExecutor(
    manager as unknown as Pick<ProcessManager, 'spawn'>,
  )
  const job = request('dedupe')
  const first = collect(executor.execute(job, new AbortController().signal))
  const replay = collect(executor.execute(job, new AbortController().signal))
  const [events, replayedEvents] = await Promise.all([first, replay])

  assertEquals(manager.spawnCount, 1)
  assertEquals(replayedEvents, events)
  assertEquals(events.map((event) => event.sequence), [0, 1, 2, 3])
  assertEquals(events.map((event) => event.type), [
    'accepted',
    'started',
    'stdout',
    'completed',
  ])
  assertEquals(events.filter((event) => 'receipt' in event).length, 1)
  for (const event of events) assert(validateJobEventV1(event).success)

  const status = await executor.getStatus(job.jobId)
  assert(status)
  assertEquals(status.state, 'completed')
  assert(validateJobStatusV1(status).success)
  const cancel = await executor.cancel(job.jobId)
  assertEquals(cancel.outcome, 'already-terminal')
  assert(validateCancelReceiptV1(cancel).success)
})

test('LocalExecutor cancellation produces a terminal acknowledgement', async () => {
  const manager = new BlockingProcessManager()
  const executor = new LocalExecutor(
    manager as unknown as Pick<ProcessManager, 'spawn'>,
  )
  const job = request('cancel')
  const eventsPromise = collect(
    executor.execute(job, new AbortController().signal),
  )
  while (manager.spawnCount === 0) await Promise.resolve()

  const receipt = await executor.cancel(job.jobId)
  assertEquals(receipt.outcome, 'requested')
  assertEquals(receipt.status?.state, 'cancelling')
  const events = await eventsPromise
  assertEquals(events.at(-1)?.type, 'cancel-acknowledged')
  assertEquals((await executor.getStatus(job.jobId))?.state, 'cancelled')
})

test('LocalExecutor expires stale and over-deadline jobs without duplicate terminals', async () => {
  const manager = new BlockingProcessManager()
  const executor = new LocalExecutor(
    manager as unknown as Pick<ProcessManager, 'spawn'>,
  )
  const stale = request('stale', {
    createdAt: new Date(Date.now() - 2000).toISOString(),
    deadlineAt: new Date(Date.now() - 1000).toISOString(),
  })
  const staleEvents = await collect(
    executor.execute(stale, new AbortController().signal),
  )
  assertEquals(staleEvents.map((event) => event.type), ['accepted', 'expired'])
  assertEquals(manager.spawnCount, 0)

  const timed = request('timed', {
    deadlineAt: new Date(Date.now() + 20).toISOString(),
  })
  const timedEvents = await collect(
    executor.execute(timed, new AbortController().signal),
  )
  assertEquals(timedEvents.at(-1)?.type, 'expired')
  assertEquals(timedEvents.filter((event) => 'receipt' in event).length, 1)

  await assertRejects(
    async () => {
      for await (
        const _event of executor.execute(
          { ...request('invalid'), version: 2 } as unknown as JobRequestV1,
          new AbortController().signal,
        )
      ) { /* consume */ }
    },
    { name: 'TypeError', message: /Invalid JobRequestV1/ },
  )
})

test('LocalExecutor confines capability filesystem reads and writes to the physical root', async () => {
  const directory = await createTempWorkspace()
  const root = `${directory}/root`
  const outside = `${directory}/outside`
  await mkdir(`${root}/nested`, { recursive: true })
  await mkdir(outside)
  await writeFile(`${root}/nested/input.txt`, 'inside')
  await writeFile(`${outside}/secret.txt`, 'outside-secret')
  await symlink(
    outside,
    `${root}/escape`,
    process.platform === 'win32' ? 'junction' : 'dir',
  )
  try {
    const manager = new FakeProcessManager()
    const filesystem = new CapabilityFilesystem([{
      capabilityId: 'workdir-1',
      rootPath: root,
    }])
    const executor = new LocalExecutor(
      manager as unknown as Pick<ProcessManager, 'spawn'>,
      'local',
      [filesystem],
      ['shell-1'],
    )
    const readEvents = await collect(executor.execute(
      request('fs-read', {
        capabilityId: 'workdir-1',
        operation: FILESYSTEM_READ_OPERATION,
        args: { path: 'nested/input.txt' },
      }),
      new AbortController().signal,
    ))
    const writeEvents = await collect(executor.execute(
      request('fs-write', {
        capabilityId: 'workdir-1',
        operation: FILESYSTEM_WRITE_OPERATION,
        args: { path: 'nested/output.txt', content: 'written' },
      }),
      new AbortController().signal,
    ))
    const listEvents = await collect(executor.execute(
      request('fs-list', {
        capabilityId: 'workdir-1',
        operation: FILESYSTEM_READ_OPERATION,
        args: { path: 'nested' },
      }),
      new AbortController().signal,
    ))
    const escapeEvents = await collect(executor.execute(
      request('fs-escape', {
        capabilityId: 'workdir-1',
        operation: FILESYSTEM_READ_OPERATION,
        args: { path: 'escape/secret.txt' },
      }),
      new AbortController().signal,
    ))
    const unknownEvents = await collect(executor.execute(
      request('fs-unknown', {
        capabilityId: 'workdir-unknown',
        operation: FILESYSTEM_READ_OPERATION,
        args: { path: 'nested/input.txt' },
      }),
      new AbortController().signal,
    ))
    const confusedDeputyEvents = await collect(
      executor.execute(
        request('fs-shell', {
          capabilityId: 'workdir-1',
        }),
        new AbortController().signal,
      ),
    )

    assertEquals(readEvents.map((event) => event.type), [
      'accepted',
      'stdout',
      'completed',
    ])
    const readOutput = readEvents.find((event) => event.type === 'stdout')
    assertEquals(
      readOutput?.type === 'stdout' ? readOutput.chunk : undefined,
      'inside',
    )
    assertEquals(writeEvents.at(-1)?.type, 'completed')
    const listOutput = listEvents.find((event) => event.type === 'stdout')
    assertEquals(
      listOutput?.type === 'stdout' ? listOutput.chunk : undefined,
      'input.txt\noutput.txt',
    )
    assertEquals(
      await readFile(`${root}/nested/output.txt`, 'utf8'),
      'written',
    )
    assertEquals(escapeEvents.at(-1)?.type, 'rejected')
    assertEquals(unknownEvents.at(-1)?.type, 'rejected')
    assertEquals(confusedDeputyEvents.at(-1)?.type, 'rejected')
    assertEquals(JSON.stringify(escapeEvents).includes(outside), false)
    assertEquals(manager.spawnCount, 0)
  } finally {
    await rm(directory, { recursive: true })
  }
})

test('LocalExecutor runs registered process capabilities directly', async () => {
  const manager = new FakeProcessManager()
  const executor = new LocalExecutor(
    manager as unknown as Pick<ProcessManager, 'spawn'>,
    'local',
    [],
    ['shell-1'],
  )
  const firstEvents = collect(executor.execute(
    request('direct-first'),
    new AbortController().signal,
  ))
  assertEquals((await firstEvents).map((event) => event.type), [
    'accepted',
    'started',
    'stdout',
    'completed',
  ])

  const grantedEvents = await collect(executor.execute(
    request('direct-next'),
    new AbortController().signal,
  ))
  assertEquals(grantedEvents.map((event) => event.type), [
    'accepted',
    'started',
    'stdout',
    'completed',
  ])
  assertEquals(manager.spawnCount, 2)
})

test('LocalExecutor never spawns a pre-cancelled or expired job', async () => {
  const manager = new FakeProcessManager()
  const executor = new LocalExecutor(
    manager as unknown as Pick<ProcessManager, 'spawn'>,
    'local',
    [],
    ['shell-1'],
  )
  const cancelledEvents = await collect(executor.execute(
    request('pre-cancelled'),
    AbortSignal.abort(),
  ))
  assertEquals(cancelledEvents.map(event => event.type), ['accepted', 'cancel-acknowledged'])

  const expiring = request('expired-before-start', {
    createdAt: new Date(Date.now() - 200).toISOString(),
    deadlineAt: new Date(Date.now() - 100).toISOString(),
  })
  const expiredEvents = await collect(executor.execute(
    expiring,
    new AbortController().signal,
  ))
  assertEquals(expiredEvents.map((event) => event.type), [
    'accepted',
    'expired',
  ])
  assertEquals(manager.spawnCount, 0)
})
