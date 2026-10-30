import type {
  ExecutionReceiptV1,
  JobEventV1,
  JobReasonV1,
  ExecutionRequestV2,
} from '../execution/contracts.ts'

export interface JobAuditContextV1 {
  version: 1
  traceId: string
  protocolMajor: number
  protocolMinor: number
  implementationVersion: string
}

export interface JobAuditCorrelationV2 {
  traceId: string
  jobId: string
  idempotencyKey: string
  sessionId: string
  turnId: string
  nodeId: string
  workdirId?: string
  projectScope?: string
  protocolMajor: number
  protocolMinor: number
  implementationVersion: string
}

export interface RedactedValueV1 {
  redacted: true
}

export type AuditValue =
  | null
  | boolean
  | number
  | string
  | RedactedValueV1
  | AuditValue[]
  | { [key: string]: AuditValue }

export type JobAuditRecordV2 =
  & {
    version: 2
    correlation: JobAuditCorrelationV2
    timestamp: string
  }
  & (
    | {
      kind: 'job-requested'
      operation: string
      createdAt: string
      deadlineAt: string
      args: AuditValue
    }
    | {
      kind: 'job-event'
      sequence: number
      eventType: JobEventV1['type']
      details?: { [key: string]: AuditValue }
      terminal?: {
        state: ExecutionReceiptV1['state']
        finishedAt: string
        reason?: AuditValue
      }
      artifactIds: string[]
    }
    | {
      kind: 'job-event-anomaly'
      sequence: number
      anomaly: 'duplicate' | 'out-of-order'
      lastSequence: number
    }
  )

export interface JobAuditSink {
  append(record: JobAuditRecordV2): void | Promise<void>
}

export interface JobAuditRedactor {
  redactArgs(args: unknown, request: ExecutionRequestV2): AuditValue
  redactOutput(chunk: string, event: JobEventV1): AuditValue
  redactReason(reason: JobReasonV1, receipt: ExecutionReceiptV1): AuditValue
}

const REDACTED: RedactedValueV1 = Object.freeze({ redacted: true })

export const defaultJobAuditRedactor: JobAuditRedactor = {
  redactArgs: () => REDACTED,
  redactOutput: () => REDACTED,
  redactReason: (reason) => ({
    code: reason.code,
    retryable: reason.retryable,
    message: REDACTED,
  }),
}

export class InMemoryJobAuditSink implements JobAuditSink {
  readonly records: JobAuditRecordV2[] = []

  append(record: JobAuditRecordV2): void {
    this.records.push(structuredClone(record))
  }
}

export class JobAuditRecorder {
  readonly #correlation: JobAuditCorrelationV2
  readonly #artifactIds = new Set<string>()
  readonly #seenSequences = new Set<number>()
  #lastSequence = -1

  constructor(
    readonly request: ExecutionRequestV2,
    readonly context: JobAuditContextV1,
    readonly sink: JobAuditSink,
    readonly redactor: JobAuditRedactor = defaultJobAuditRedactor,
  ) {
    this.#correlation = {
      traceId: context.traceId,
      jobId: request.jobId,
      idempotencyKey: request.idempotencyKey,
      sessionId: request.sessionId,
      turnId: request.turnId,
      nodeId: request.nodeId,
      ...(request.workdirId === undefined ? {} : { workdirId: request.workdirId }),
      ...(request.projectScope ? { projectScope: request.projectScope } : {}),
      protocolMajor: context.protocolMajor,
      protocolMinor: context.protocolMinor,
      implementationVersion: context.implementationVersion,
    }
  }

  appendRequest(): void | Promise<void> {
    return this.sink.append({
      version: 2,
      kind: 'job-requested',
      correlation: this.#correlation,
      timestamp: this.request.createdAt,
      operation: this.request.operation,
      createdAt: this.request.createdAt,
      deadlineAt: this.request.deadlineAt,
      args: this.redactor.redactArgs(this.request.args, this.request),
    })
  }

  appendEvent(event: JobEventV1): void | Promise<void> {
    if (event.jobId !== this.request.jobId) {
      throw new TypeError(`Event jobId does not match request jobId`)
    }
    if (event.sequence <= this.#lastSequence) {
      return this.sink.append({
        version: 2,
        kind: 'job-event-anomaly',
        correlation: this.#correlation,
        timestamp: event.timestamp,
        sequence: event.sequence,
        anomaly: this.#seenSequences.has(event.sequence)
          ? 'duplicate'
          : 'out-of-order',
        lastSequence: this.#lastSequence,
      })
    }

    this.#lastSequence = event.sequence
    this.#seenSequences.add(event.sequence)
    if (event.type === 'artifact-ready') this.#artifactIds.add(event.artifactId)

    const record: JobAuditRecordV2 = {
      version: 2,
      kind: 'job-event',
      correlation: this.#correlation,
      timestamp: event.timestamp,
      sequence: event.sequence,
      eventType: event.type,
      details: this.#eventDetails(event),
      terminal: 'receipt' in event ? this.#terminal(event.receipt) : undefined,
      artifactIds: [...this.#artifactIds],
    }
    return this.sink.append(record)
  }

  #eventDetails(event: JobEventV1): { [key: string]: AuditValue } | undefined {
    switch (event.type) {
      case 'started':
        return { pid: event.pid }
      case 'stdout':
      case 'stderr':
        return { chunk: this.redactor.redactOutput(event.chunk, event) }
      case 'artifact-ready':
        return {
          artifactId: event.artifactId,
          mediaType: event.mediaType,
          size: event.size,
        }
      default:
        return undefined
    }
  }

  #terminal(receipt: ExecutionReceiptV1): NonNullable<
    Extract<JobAuditRecordV2, { kind: 'job-event' }>['terminal']
  > {
    return {
      state: receipt.state,
      finishedAt: receipt.finishedAt,
      reason: receipt.reason
        ? this.redactor.redactReason(receipt.reason, receipt)
        : undefined,
    }
  }
}
