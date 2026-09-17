import { deepEqual as assertEquals, throws as assertThrows } from 'node:assert/strict'
import { test } from 'node:test'
import type {
  ExecutionReceiptV1,
  JobEventV1,
  JobRequestV1,
} from '../execution/contracts.ts'
import {
  InMemoryJobAuditSink,
  JobAuditRecorder,
  type JobAuditRedactor,
} from './job-audit.ts'

const timestamp = '2026-08-26T10:00:00.000Z'

function request(): JobRequestV1 {
  return {
    version: 1,
    jobId: 'job-1',
    idempotencyKey: 'idempotency-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    nodeId: 'node-1',
    capabilityId: 'shell-1',
    operation: 'process.execute',
    args: { command: 'secret-command', token: 'secret-token' },
    createdAt: timestamp,
    deadlineAt: '2026-08-26T10:01:00.000Z',
  }
}

function recorder(redactor?: JobAuditRedactor) {
  const sink = new InMemoryJobAuditSink()
  return {
    sink,
    recorder: new JobAuditRecorder(
      request(),
      {
        version: 1,
        traceId: 'trace-1',
        protocolMajor: 1,
        protocolMinor: 3,
        implementationVersion: '0.8.0',
      },
      sink,
      redactor,
    ),
  }
}

type JobEventInput<Event> = Event extends JobEventV1
  ? Omit<Event, 'version' | 'jobId' | 'sequence' | 'timestamp'>
  : never

function event(
  sequence: number,
  value: JobEventInput<JobEventV1>,
): JobEventV1 {
  return {
    version: 1,
    jobId: 'job-1',
    sequence,
    timestamp,
    ...value,
  } as JobEventV1
}

function receipt(
  overrides: Partial<ExecutionReceiptV1> = {},
): ExecutionReceiptV1 {
  return {
    version: 1,
    jobId: 'job-1',
    nodeId: 'node-1',
    state: 'failed',
    startedAt: timestamp,
    finishedAt: '2026-08-26T10:00:03.000Z',
    reason: {
      code: 'PROCESS_FAILED',
      message: 'secret failure details',
      retryable: false,
    },
    ...overrides,
  }
}

test('job audit records carry complete request and event correlation', async () => {
  const { recorder: audit, sink } = recorder()
  await audit.appendRequest()
  await audit.appendEvent(event(0, { type: 'accepted' }))

  const expectedCorrelation = {
    traceId: 'trace-1',
    jobId: 'job-1',
    idempotencyKey: 'idempotency-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    nodeId: 'node-1',
    capabilityId: 'shell-1',
    protocolMajor: 1,
    protocolMinor: 3,
    implementationVersion: '0.8.0',
  }
  assertEquals(sink.records.length, 2)
  assertEquals(sink.records[0].correlation, expectedCorrelation)
  assertEquals(sink.records[1].correlation, expectedCorrelation)
})

test('job audit terminal records include receipt outcome and artifact IDs', async () => {
  const { recorder: audit, sink } = recorder()
  await audit.appendEvent(event(0, {
    type: 'artifact-ready',
    artifactId: 'artifact-1',
    mediaType: 'text/plain',
    size: 42,
  }))
  await audit.appendEvent(event(1, {
    type: 'artifact-ready',
    artifactId: 'artifact-2',
    mediaType: 'application/json',
    size: 84,
  }))
  await audit.appendEvent(event(2, { type: 'failed', receipt: receipt() }))

  const terminal = sink.records[2]
  assertEquals(terminal.kind, 'job-event')
  if (terminal.kind !== 'job-event') throw new Error('expected job event')
  assertEquals(terminal.eventType, 'failed')
  assertEquals(terminal.artifactIds, ['artifact-1', 'artifact-2'])
  assertEquals(terminal.terminal, {
    state: 'failed',
    finishedAt: '2026-08-26T10:00:03.000Z',
    reason: {
      code: 'PROCESS_FAILED',
      retryable: false,
      message: { redacted: true },
    },
  })
})

test('job audit redacts arguments and output by default and supports policy hooks', async () => {
  const defaults = recorder()
  await defaults.recorder.appendRequest()
  await defaults.recorder.appendEvent(event(0, {
    type: 'stdout',
    chunk: 'secret output',
  }))
  assertEquals(JSON.stringify(defaults.sink.records).includes('secret'), false)

  const custom = recorder({
    redactArgs: () => ({ allowedKeys: ['command'] }),
    redactOutput: (chunk) => ({ length: chunk.length }),
    redactReason: (reason) => ({ code: reason.code }),
  })
  await custom.recorder.appendRequest()
  await custom.recorder.appendEvent(event(0, {
    type: 'stderr',
    chunk: 'secret output',
  }))
  await custom.recorder.appendEvent(event(1, {
    type: 'failed',
    receipt: receipt(),
  }))

  const requestRecord = custom.sink.records[0]
  const outputRecord = custom.sink.records[1]
  const terminalRecord = custom.sink.records[2]
  assertEquals(
    requestRecord.kind === 'job-requested' ? requestRecord.args : null,
    { allowedKeys: ['command'] },
  )
  assertEquals(
    outputRecord.kind === 'job-event' ? outputRecord.details : null,
    { chunk: { length: 13 } },
  )
  assertEquals(
    terminalRecord.kind === 'job-event'
      ? terminalRecord.terminal?.reason
      : null,
    { code: 'PROCESS_FAILED' },
  )
})

test('job audit identifies duplicate and out-of-order events without replaying them', async () => {
  const { recorder: audit, sink } = recorder()
  await audit.appendEvent(event(0, { type: 'accepted' }))
  await audit.appendEvent(event(2, { type: 'started', pid: 123 }))
  await audit.appendEvent(event(0, { type: 'accepted' }))
  await audit.appendEvent(event(1, { type: 'accepted' }))

  assertEquals(sink.records.map((record) => record.kind), [
    'job-event',
    'job-event',
    'job-event-anomaly',
    'job-event-anomaly',
  ])
  assertEquals(
    sink.records.map((record) =>
      record.kind === 'job-event-anomaly' ? record.anomaly : null
    ),
    [null, null, 'duplicate', 'out-of-order'],
  )
})

test('job audit rejects events correlated to a different job', () => {
  const { recorder: audit } = recorder()
  const mismatched = {
    ...event(0, { type: 'accepted' }),
    jobId: 'job-2',
  }
  assertThrows(
    () => audit.appendEvent(mismatched),
    { name: 'TypeError', message: /does not match/ },
  )
})
