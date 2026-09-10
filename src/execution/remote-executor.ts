import type {
  CancelReceiptV1,
  ExecutionReceiptV1,
  JobEventV1,
  JobRequestV1,
  JobStateV1,
  JobStatusV1,
} from './contracts.ts'
import { validateJobEventV1, validateJobRequestV1 } from './contracts.ts'
import type { Executor } from './executor.ts'

export interface RemoteNodeJobDispatcher {
  dispatchJob(
    request: JobRequestV1,
    callbacks: {
      readonly onEvent: (event: JobEventV1) => void
      readonly onDisconnect: (reason: string) => void
    },
  ): void
  dispatchCancellation(nodeId: string, jobId: string): void
}

interface RemoteJobRecord {
  readonly request: JobRequestV1
  readonly events: JobEventV1[]
  status: JobStatusV1
  changed: Promise<void>
  notify: () => void
}

const TERMINAL_STATES = new Set<JobStateV1>([
  'completed',
  'failed',
  'rejected',
  'expired',
  'cancelled',
])

export class RemoteExecutor implements Executor {
  readonly #jobs = new Map<string, RemoteJobRecord>()

  constructor(readonly dispatcher: RemoteNodeJobDispatcher) {}

  execute(
    request: JobRequestV1,
    signal: AbortSignal,
  ): AsyncIterable<JobEventV1> {
    const validation = validateJobRequestV1(request)
    if (!validation.success) {
      throw new TypeError(
        `Invalid JobRequestV1: ${validation.errors.join('; ')}`,
      )
    }
    let record = this.#jobs.get(request.jobId)
    if (!record) {
      record = createRecord(validation.value)
      this.#jobs.set(request.jobId, record)
      try {
        this.dispatcher.dispatchJob(validation.value, {
          onEvent: (event) => this.#acceptEvent(record!, event),
          onDisconnect: (reason) => this.#disconnect(record!, reason),
        })
      } catch (error) {
        this.#disconnect(
          record,
          error instanceof Error ? error.message : 'Remote node is unavailable',
        )
      }
    } else if (!sameRequest(record.request, validation.value)) {
      throw new TypeError('jobId is already bound to a different request')
    }

    const abort = () => void this.cancel(request.jobId)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    return this.#readEvents(record, signal, abort)
  }

  getStatus(jobId: string): Promise<JobStatusV1 | null> {
    const status = this.#jobs.get(jobId)?.status
    return Promise.resolve(status ? structuredClone(status) : null)
  }

  cancel(jobId: string): Promise<CancelReceiptV1> {
    const record = this.#jobs.get(jobId)
    if (!record) return Promise.resolve(cancelReceipt(jobId, 'not-found', null))
    if (TERMINAL_STATES.has(record.status.state)) {
      return Promise.resolve(
        cancelReceipt(jobId, 'already-terminal', record.status),
      )
    }
    try {
      this.dispatcher.dispatchCancellation(record.request.nodeId, jobId)
      record.status = {
        ...record.status,
        state: 'cancelling',
        updatedAt: now(),
      }
      return Promise.resolve(cancelReceipt(jobId, 'requested', record.status))
    } catch (error) {
      this.#disconnect(
        record,
        error instanceof Error ? error.message : 'Remote node is unavailable',
      )
      return Promise.resolve(
        cancelReceipt(jobId, 'already-terminal', record.status),
      )
    }
  }

  async *#readEvents(
    record: RemoteJobRecord,
    signal: AbortSignal,
    abort: () => void,
  ): AsyncIterable<JobEventV1> {
    let cursor = 0
    try {
      while (true) {
        while (cursor < record.events.length) {
          yield structuredClone(record.events[cursor++])
        }
        if (TERMINAL_STATES.has(record.status.state)) return
        const changed = record.changed
        if (cursor < record.events.length) continue
        await changed
      }
    } finally {
      signal.removeEventListener('abort', abort)
    }
  }

  #acceptEvent(record: RemoteJobRecord, event: JobEventV1): void {
    if (TERMINAL_STATES.has(record.status.state)) return
    const validation = validateJobEventV1(event)
    if (!validation.success || event.jobId !== record.request.jobId) {
      this.#disconnect(record, 'Remote node returned an invalid job event')
      return
    }
    if (event.sequence !== record.events.length) {
      this.#disconnect(record, 'Remote node returned an out-of-order job event')
      return
    }
    record.events.push(structuredClone(event))
    const state = eventState(event)
    record.status = {
      version: 1,
      jobId: record.request.jobId,
      state,
      lastSequence: event.sequence,
      updatedAt: event.timestamp,
      ...('receipt' in event
        ? { receipt: structuredClone(event.receipt) }
        : {}),
    }
    wake(record)
  }

  #disconnect(record: RemoteJobRecord, message: string): void {
    if (TERMINAL_STATES.has(record.status.state)) return
    const sequence = record.events.length
    const timestamp = now()
    const receipt: ExecutionReceiptV1 = {
      version: 1,
      jobId: record.request.jobId,
      nodeId: record.request.nodeId,
      state: 'failed',
      finishedAt: timestamp,
      reason: {
        code: 'remote-node-unavailable',
        message: sanitizeReason(message),
        retryable: true,
      },
    }
    record.events.push({
      version: 1,
      jobId: record.request.jobId,
      sequence,
      timestamp,
      type: 'failed',
      receipt,
    })
    record.status = {
      version: 1,
      jobId: record.request.jobId,
      state: 'failed',
      lastSequence: sequence,
      updatedAt: timestamp,
      receipt,
    }
    wake(record)
  }
}

function createRecord(request: JobRequestV1): RemoteJobRecord {
  let notify = () => {}
  const changed = new Promise<void>((resolve) => notify = resolve)
  return {
    request: structuredClone(request),
    events: [],
    status: {
      version: 1,
      jobId: request.jobId,
      state: 'accepted',
      lastSequence: -1,
      updatedAt: now(),
    },
    changed,
    notify,
  }
}

function wake(record: RemoteJobRecord): void {
  record.notify()
  record.changed = new Promise<void>((resolve) => record.notify = resolve)
}

function eventState(event: JobEventV1): JobStateV1 {
  if ('receipt' in event) return event.receipt.state
  if (event.type === 'awaiting-approval') return 'awaiting-approval'
  if (
    event.type === 'started' || event.type === 'stdout' ||
    event.type === 'stderr' || event.type === 'artifact-ready'
  ) return 'running'
  return 'accepted'
}

function sameRequest(left: JobRequestV1, right: JobRequestV1): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function cancelReceipt(
  jobId: string,
  outcome: CancelReceiptV1['outcome'],
  status: JobStatusV1 | null,
): CancelReceiptV1 {
  return {
    version: 1,
    jobId,
    outcome,
    timestamp: now(),
    status: status ? structuredClone(status) : null,
  }
}

function sanitizeReason(message: string): string {
  const singleLine = message.replaceAll(/\s+/g, ' ').trim()
  if (!singleLine) return 'Remote node is unavailable'
  return singleLine.length <= 200
    ? singleLine
    : `${singleLine.slice(0, 197)}...`
}

function now(): string {
  return new Date().toISOString()
}
