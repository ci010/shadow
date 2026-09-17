import { deepEqual as assertEquals, rejects as assertRejects } from 'node:assert/strict'
import { test } from 'node:test'
import type { JobEventV1, JobRequestV1 } from './contracts.ts'
import {
  RemoteExecutor,
  type RemoteNodeJobDispatcher,
} from './remote-executor.ts'

function request(jobId = 'remote-job'): JobRequestV1 {
  const createdAt = new Date()
  return {
    version: 1,
    jobId,
    idempotencyKey: `${jobId}-key`,
    sessionId: 'session-1',
    turnId: 'turn-1',
    nodeId: 'child-1',
    capabilityId: 'workdir-1',
    operation: 'filesystem.read',
    args: { path: 'README.md' },
    createdAt: createdAt.toISOString(),
    deadlineAt: new Date(createdAt.getTime() + 10_000).toISOString(),
  }
}

class FakeDispatcher implements RemoteNodeJobDispatcher {
  dispatches = 0
  cancellations: Array<{ nodeId: string; jobId: string }> = []
  callbacks?: Parameters<RemoteNodeJobDispatcher['dispatchJob']>[1]

  dispatchJob(
    _request: JobRequestV1,
    callbacks: Parameters<RemoteNodeJobDispatcher['dispatchJob']>[1],
  ): void {
    this.dispatches++
    this.callbacks = callbacks
  }

  dispatchCancellation(nodeId: string, jobId: string): void {
    this.cancellations.push({ nodeId, jobId })
  }

  event(event: JobEventV1): void {
    this.callbacks?.onEvent(event)
  }
}

async function collect(
  iterable: AsyncIterable<JobEventV1>,
): Promise<JobEventV1[]> {
  const events: JobEventV1[] = []
  for await (const event of iterable) events.push(event)
  return events
}

test('RemoteExecutor dispatches once and replays one ordered event stream', async () => {
  const dispatcher = new FakeDispatcher()
  const executor = new RemoteExecutor(dispatcher)
  const job = request()
  const first = collect(executor.execute(job, new AbortController().signal))
  const replay = collect(executor.execute(job, new AbortController().signal))
  dispatcher.event(event(job, 0, 'accepted'))
  dispatcher.event(event(job, 1, 'stdout', { chunk: 'remote text' }))
  dispatcher.event(terminal(job, 2, 'completed'))

  const [events, replayed] = await Promise.all([first, replay])
  assertEquals(dispatcher.dispatches, 1)
  assertEquals(replayed, events)
  assertEquals(events.map((value) => value.type), [
    'accepted',
    'stdout',
    'completed',
  ])
  assertEquals((await executor.getStatus(job.jobId))?.state, 'completed')
  await assertRejects(
    async () => {
      for await (
        const _event of executor.execute(
          { ...job, capabilityId: 'different' },
          new AbortController().signal,
        )
      ) { /* consume */ }
    },
    { name: 'TypeError', message: /different request/ },
  )
})

test('RemoteExecutor never dispatches a pre-cancelled job and replays its terminal receipt', async () => {
  const dispatcher = new FakeDispatcher()
  const executor = new RemoteExecutor(dispatcher)
  const job = request()
  const events = await collect(executor.execute(job, AbortSignal.abort()))
  assertEquals(events.map(event => event.type), ['cancel-acknowledged'])
  assertEquals(dispatcher.dispatches, 0)
  assertEquals(dispatcher.cancellations, [])
  assertEquals((await executor.getStatus(job.jobId))?.state, 'cancelled')
  assertEquals(await collect(executor.execute(job, new AbortController().signal)), events)
})

test('RemoteExecutor forwards cancellation and terminates disconnected jobs', async () => {
  const dispatcher = new FakeDispatcher()
  const executor = new RemoteExecutor(dispatcher)
  const cancelledJob = request('cancelled-job')
  const cancelledEvents = collect(executor.execute(
    cancelledJob,
    new AbortController().signal,
  ))
  dispatcher.event(event(cancelledJob, 0, 'accepted'))
  assertEquals((await executor.cancel(cancelledJob.jobId)).outcome, 'requested')
  assertEquals(dispatcher.cancellations, [{
    nodeId: 'child-1',
    jobId: 'cancelled-job',
  }])
  dispatcher.event(
    terminal(cancelledJob, 1, 'cancel-acknowledged', 'cancelled'),
  )
  assertEquals((await cancelledEvents).at(-1)?.type, 'cancel-acknowledged')

  const disconnectedJob = request('disconnected-job')
  const disconnected = collect(executor.execute(
    disconnectedJob,
    new AbortController().signal,
  ))
  dispatcher.callbacks?.onDisconnect('connection closed\nwith private details')
  const terminalEvent = (await disconnected).at(-1)
  assertEquals(terminalEvent?.type, 'failed')
  assertEquals(
    terminalEvent && 'receipt' in terminalEvent
      ? terminalEvent.receipt.reason?.code
      : undefined,
    'remote-node-unavailable',
  )
})

function event(
  job: JobRequestV1,
  sequence: number,
  type: 'accepted' | 'stdout',
  extra: { chunk: string } | Record<string, never> = {},
): JobEventV1 {
  return {
    version: 1,
    jobId: job.jobId,
    sequence,
    timestamp: new Date().toISOString(),
    type,
    ...extra,
  } as JobEventV1
}

function terminal(
  job: JobRequestV1,
  sequence: number,
  type: 'completed' | 'cancel-acknowledged',
  state: 'completed' | 'cancelled' = 'completed',
): JobEventV1 {
  return {
    version: 1,
    jobId: job.jobId,
    sequence,
    timestamp: new Date().toISOString(),
    type,
    receipt: {
      version: 1,
      jobId: job.jobId,
      nodeId: job.nodeId,
      state,
      finishedAt: new Date().toISOString(),
    },
  }
}
