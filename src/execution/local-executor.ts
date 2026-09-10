import type {
  ManagedProcess,
  ManagedProcessStatus,
  ProcessManager,
} from '../agent/process-manager.ts'
import { decodeChunks } from '../utils/decode-chunks.ts'
import {
  type CancelReceiptV1,
  type ExecutionReceiptV1,
  type JobEventV1,
  type JobRequestV1,
  type JobStateV1,
  type JobStatusV1,
  validateJobRequestV1,
} from './contracts.ts'
import type {
  Executor,
  LocalProcessExecutor,
  ProcessExecuteArgsV1,
} from './executor.ts'
import type { LocalApprovalAuthority } from './local-approval.ts'

export const PROCESS_EXECUTE_OPERATION = 'process.execute'

export interface LocalJobOperationHandler {
  handles(operation: string): boolean
  execute(request: JobRequestV1, signal: AbortSignal): Promise<string>
}

type ProcessSpawner = Pick<ProcessManager, 'spawn'>
type JobEventPayload = JobEventV1 extends infer Event
  ? Event extends JobEventV1
    ? Omit<Event, 'version' | 'jobId' | 'sequence' | 'timestamp'>
  : never
  : never

interface JobRecord {
  request: JobRequestV1
  events: JobEventV1[]
  status: JobStatusV1
  process?: ManagedProcess
  operationController?: AbortController
  cancelRequested: boolean
  timedOut: boolean
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

function now(): string {
  return new Date().toISOString()
}

function createRecord(request: JobRequestV1): JobRecord {
  let notify = () => {}
  const changed = new Promise<void>((resolve) => notify = resolve)
  return {
    request,
    events: [],
    status: {
      version: 1,
      jobId: request.jobId,
      state: 'accepted',
      lastSequence: 0,
      updatedAt: now(),
    },
    cancelRequested: false,
    timedOut: false,
    changed,
    notify,
  }
}

function parseProcessArgs(value: unknown): ProcessExecuteArgsV1 | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  const args = value as Record<string, unknown>
  const allowed = new Set(['script', 'cwd', 'env', 'shell', 'args'])
  if (Object.keys(args).some((key) => !allowed.has(key))) return null
  if (typeof args.script !== 'string' || args.script.trim().length === 0) {
    return null
  }
  if (typeof args.cwd !== 'string' || args.cwd.length === 0) return null
  if (
    args.env !== undefined &&
    (typeof args.env !== 'object' || args.env === null ||
      Array.isArray(args.env) ||
      Object.values(args.env).some((entry) => typeof entry !== 'string'))
  ) return null
  if (
    args.shell !== undefined &&
    args.shell !== 'cmd' && args.shell !== 'sh' && args.shell !== 'bash' &&
    args.shell !== 'git-bash' && args.shell !== 'powershell' &&
    args.shell !== 'pwsh'
  ) return null
  if (
    args.args !== undefined &&
    (!Array.isArray(args.args) ||
      args.args.some((entry) => typeof entry !== 'string'))
  ) return null
  return args as unknown as ProcessExecuteArgsV1
}

export class LocalExecutor implements Executor, LocalProcessExecutor {
  private jobs = new Map<string, JobRecord>()

  constructor(
    private processManager: ProcessSpawner,
    private localNodeId = 'local',
    private operationHandlers: readonly LocalJobOperationHandler[] = [],
    private processCapabilityIds?: readonly string[],
    private approvalAuthority?: LocalApprovalAuthority,
  ) {}

  async startProcess(args: ProcessExecuteArgsV1): Promise<ManagedProcess> {
    const parsed = parseProcessArgs(args)
    if (!parsed) {
      throw new TypeError('Invalid ProcessExecuteArgsV1')
    }
    return await this.processManager.spawn(
      parsed.script,
      parsed.cwd,
      parsed.env,
      parsed.shell,
      parsed.args,
    )
  }

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

    let record = this.jobs.get(request.jobId)
    if (!record) {
      record = createRecord(request)
      this.jobs.set(request.jobId, record)
      this.push(record, { type: 'accepted' })
      void this.run(record)
    }

    const abort = () => void this.cancel(request.jobId)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()

    return this.readEvents(record, signal, abort)
  }

  async getStatus(jobId: string): Promise<JobStatusV1 | null> {
    const status = this.jobs.get(jobId)?.status
    return status ? structuredClone(status) : null
  }

  async cancel(jobId: string): Promise<CancelReceiptV1> {
    const record = this.jobs.get(jobId)
    if (!record) return this.cancelReceipt(jobId, 'not-found', null)
    if (TERMINAL_STATES.has(record.status.state)) {
      return this.cancelReceipt(jobId, 'already-terminal', record.status)
    }

    record.cancelRequested = true
    this.setState(record, 'cancelling')
    record.operationController?.abort()
    record.process?.process.kill()
    return this.cancelReceipt(jobId, 'requested', record.status)
  }

  private async *readEvents(
    record: JobRecord,
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

  private async run(record: JobRecord): Promise<void> {
    const request = record.request
    if (Date.parse(request.deadlineAt) <= Date.now()) {
      this.finish(record, 'expired', 'expired', {
        code: 'deadline-expired',
        message: 'Job deadline elapsed before execution',
        retryable: true,
      })
      return
    }
    if (request.nodeId !== this.localNodeId) {
      this.finish(record, 'rejected', 'rejected', {
        code: 'wrong-node',
        message: `Job targets node ${request.nodeId}, not ${this.localNodeId}`,
        retryable: true,
      })
      return
    }
    const operationHandler = this.operationHandlers.find((handler) =>
      handler.handles(request.operation)
    )
    if (operationHandler) {
      if (!await this.authorize(record)) return
      const controller = new AbortController()
      record.operationController = controller
      const remainingMs = Math.max(
        0,
        Date.parse(request.deadlineAt) - Date.now(),
      )
      const timeout = setTimeout(() => {
        record.timedOut = true
        controller.abort()
      }, remainingMs)
      try {
        const output = await operationHandler.execute(
          request,
          controller.signal,
        )
        if (record.timedOut) {
          this.finish(record, 'expired', 'expired', {
            code: 'deadline-expired',
            message: 'Job exceeded its deadline',
            retryable: true,
          })
          return
        }
        if (record.cancelRequested) {
          this.finish(record, 'cancelled', 'cancel-acknowledged', {
            code: 'cancelled',
            message: 'Operation cancellation was acknowledged',
            retryable: false,
          })
          return
        }
        if (output.length > 0) {
          this.push(record, { type: 'stdout', chunk: output })
        }
        this.finish(record, 'completed', 'completed')
      } catch (error) {
        if (record.timedOut) {
          this.finish(record, 'expired', 'expired', {
            code: 'deadline-expired',
            message: 'Job exceeded its deadline',
            retryable: true,
          })
          return
        }
        if (record.cancelRequested) {
          this.finish(record, 'cancelled', 'cancel-acknowledged', {
            code: 'cancelled',
            message: 'Operation cancellation was acknowledged',
            retryable: false,
          })
          return
        }
        const code = error instanceof Error && 'code' in error &&
            typeof error.code === 'string'
          ? error.code
          : 'operation-failed'
        this.finish(record, 'rejected', 'rejected', {
          code,
          message: error instanceof Error
            ? error.message
            : 'Local operation failed',
          retryable: false,
        })
      } finally {
        clearTimeout(timeout)
      }
      return
    }
    if (request.operation !== PROCESS_EXECUTE_OPERATION) {
      this.finish(record, 'rejected', 'rejected', {
        code: 'unsupported-operation',
        message: `Unsupported operation: ${request.operation}`,
        retryable: false,
      })
      return
    }
    if (
      this.processCapabilityIds !== undefined &&
      !this.processCapabilityIds.includes(request.capabilityId)
    ) {
      this.finish(record, 'rejected', 'rejected', {
        code: 'capability-denied',
        message: 'Process execution capability is not granted',
        retryable: false,
      })
      return
    }
    const args = parseProcessArgs(request.args)
    if (!args) {
      this.finish(record, 'rejected', 'rejected', {
        code: 'invalid-process-args',
        message: 'process.execute requires valid script and cwd arguments',
        retryable: false,
      })
      return
    }
    if (!await this.authorize(record)) return

    try {
      const process = await this.startProcess(args)
      record.process = process
      this.setState(record, record.cancelRequested ? 'cancelling' : 'running')
      this.push(record, { type: 'started', pid: process.pid })
      if (record.cancelRequested) process.process.kill()

      const remainingMs = Math.max(
        0,
        Date.parse(request.deadlineAt) - Date.now(),
      )
      let timeout: ReturnType<typeof setTimeout> | undefined
      const deadline = new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), remainingMs)
      })
      const status = await Promise.race([process.exitPromise, deadline])
      if (timeout !== undefined) clearTimeout(timeout)
      if (status === null) {
        record.timedOut = true
        process.process.kill()
        const finalStatus = await process.exitPromise
        this.emitOutput(record, process)
        this.finishFromStatus(record, finalStatus)
        return
      }
      this.emitOutput(record, process)
      this.finishFromStatus(record, status)
    } catch (error) {
      this.finish(record, 'failed', 'failed', {
        code: 'spawn-failed',
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      })
    }
  }

  private async authorize(record: JobRecord): Promise<boolean> {
    const request = record.request
    if (!this.approvalAuthority) {
      if (request.approval !== 'local-required') return true
      this.setState(record, 'awaiting-approval')
      this.push(record, { type: 'awaiting-approval' })
      this.finish(record, 'rejected', 'rejected', {
        code: 'approval-required',
        message: 'LocalExecutor has no approval grant for this job',
        retryable: true,
      })
      return false
    }

    const controller = new AbortController()
    record.operationController = controller
    if (record.cancelRequested) controller.abort()
    const remainingMs = Math.max(
      0,
      Date.parse(request.deadlineAt) - Date.now(),
    )
    const timeout = setTimeout(() => {
      record.timedOut = true
      controller.abort()
    }, remainingMs)
    try {
      const approved = await this.approvalAuthority.authorize(
        request,
        controller.signal,
        () => {
          if (TERMINAL_STATES.has(record.status.state)) return
          this.setState(record, 'awaiting-approval')
          this.push(record, { type: 'awaiting-approval' })
        },
      )
      if (record.timedOut) {
        this.finish(record, 'expired', 'expired', {
          code: 'deadline-expired',
          message: 'Job deadline elapsed while awaiting local approval',
          retryable: true,
        })
        return false
      }
      if (record.cancelRequested) {
        this.finish(record, 'cancelled', 'cancel-acknowledged', {
          code: 'cancelled',
          message: 'Approval wait cancellation was acknowledged',
          retryable: false,
        })
        return false
      }
      if (!approved) {
        this.finish(record, 'rejected', 'rejected', {
          code: 'local-approval-denied',
          message: 'The Child denied local execution approval',
          retryable: false,
        })
        return false
      }
      return true
    } finally {
      clearTimeout(timeout)
      if (record.operationController === controller) {
        record.operationController = undefined
      }
    }
  }

  private emitOutput(record: JobRecord, process: ManagedProcess): void {
    const stdout = decodeChunks(process.stdoutChunks, process.shell)
    const stderr = decodeChunks(process.stderrChunks, process.shell)
    if (stdout.length > 0) this.push(record, { type: 'stdout', chunk: stdout })
    if (stderr.length > 0) this.push(record, { type: 'stderr', chunk: stderr })
  }

  private finishFromStatus(
    record: JobRecord,
    status: ManagedProcessStatus,
  ): void {
    if (record.timedOut) {
      this.finish(record, 'expired', 'expired', {
        code: 'deadline-expired',
        message: 'Job exceeded its deadline',
        retryable: true,
      }, status)
    } else if (record.cancelRequested) {
      this.finish(record, 'cancelled', 'cancel-acknowledged', {
        code: 'cancelled',
        message: 'Process cancellation was acknowledged',
        retryable: false,
      }, status)
    } else if (status.success) {
      this.finish(record, 'completed', 'completed', undefined, status)
    } else {
      this.finish(record, 'failed', 'failed', {
        code: 'process-exit',
        message: `Process exited with code ${status.code}`,
        retryable: false,
      }, status)
    }
  }

  private finish(
    record: JobRecord,
    state: ExecutionReceiptV1['state'],
    eventType:
      | 'completed'
      | 'failed'
      | 'rejected'
      | 'expired'
      | 'cancel-acknowledged',
    reason?: ExecutionReceiptV1['reason'],
    processStatus?: ManagedProcessStatus,
  ): void {
    if (TERMINAL_STATES.has(record.status.state)) return
    const receipt: ExecutionReceiptV1 = {
      version: 1,
      jobId: record.request.jobId,
      nodeId: this.localNodeId,
      state,
      ...(record.process
        ? {
          startedAt: record.process.startedAt.toISOString(),
          pid: record.process.pid,
        }
        : {}),
      finishedAt: now(),
      ...(processStatus
        ? {
          exitCode: processStatus.code,
          ...(processStatus.signal ? { signal: processStatus.signal } : {}),
        }
        : {}),
      ...(reason ? { reason } : {}),
    }
    this.setState(record, state, receipt)
    this.push(record, { type: eventType, receipt } as JobEventPayload)
  }

  private push(
    record: JobRecord,
    event: JobEventPayload,
  ): void {
    const sequence = record.events.length
    record.events.push({
      version: 1,
      jobId: record.request.jobId,
      sequence,
      timestamp: now(),
      ...event,
    } as JobEventV1)
    record.status.lastSequence = sequence
    record.status.updatedAt = now()
    record.notify()
    record.changed = new Promise<void>((resolve) => record.notify = resolve)
  }

  private setState(
    record: JobRecord,
    state: JobStateV1,
    receipt?: ExecutionReceiptV1,
  ): void {
    record.status = {
      ...record.status,
      state,
      updatedAt: now(),
      ...(receipt ? { receipt } : {}),
    }
  }

  private cancelReceipt(
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
}
