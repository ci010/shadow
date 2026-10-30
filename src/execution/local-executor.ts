import type {
  ManagedProcess,
  ManagedProcessStatus,
  ProcessManager,
} from './processes/manager.ts'
import { terminateProcessTree } from './processes/manager.ts'
import type { ProcessSupervision } from './processes/guardian.ts'
import { decodeChunks } from '../utils/decode-chunks.ts'
import {
  type CancelReceiptV1,
  type ExecutionReceiptV1,
  type JobEventV1,
  type ExecutionRequestV2,
  type JobStateV1,
  type JobStatusV1,
  validateExecutionRequestV2,
} from './contracts.ts'
import type {
  Executor,
  LocalProcessExecutor,
  ProcessExecuteArgsV1,
} from './executor.ts'

export const PROCESS_EXECUTE_OPERATION = 'process.execute'

export interface LocalJobOperationHandler {
  handles(operation: string): boolean
  execute(request: ExecutionRequestV2, signal: AbortSignal): Promise<string>
}

export interface LocalProcessOperationHandler {
  handles(operation: string): boolean
  prepareProcess(request: ExecutionRequestV2, signal: AbortSignal): Promise<ProcessExecuteArgsV1>
}

type ProcessSpawner = Pick<ProcessManager, 'spawn'>
type JobEventPayload = JobEventV1 extends infer Event
  ? Event extends JobEventV1
    ? Omit<Event, 'version' | 'jobId' | 'sequence' | 'timestamp'>
  : never
  : never

interface JobRecord {
  request: ExecutionRequestV2
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

const MAX_WORKDIR_PROCESS_OUTPUT_BYTES = 128 * 1024

async function terminateWorkdirProcess(managed: ManagedProcess): Promise<ManagedProcessStatus> {
  return await (managed.terminate?.() ?? terminateProcessTree(managed.process, managed.exitPromise, true))
}

function now(): string {
  return new Date().toISOString()
}

function createRecord(request: ExecutionRequestV2): JobRecord {
  let notify = () => {}
  const changed = new Promise<void>((resolve) => notify = resolve)
  return {
    request: structuredClone(request),
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
    private operationHandlers: readonly (LocalJobOperationHandler | LocalProcessOperationHandler)[] = [],
    private admission?: (request: ExecutionRequestV2, signal: AbortSignal) => void | Promise<void>,
    private processResultPath?: (request: ExecutionRequestV2) => string | undefined,
  ) {}

  async startProcess(args: ProcessExecuteArgsV1, options?: { isolated?: boolean; signal?: AbortSignal; supervision?: ProcessSupervision }): Promise<ManagedProcess> {
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
      ...(options === undefined ? [] as const : [options] as const),
    )
  }

  async assertCanExecute(request: ExecutionRequestV2, signal: AbortSignal): Promise<void> {
    const validation = validateExecutionRequestV2(request)
    if (!validation.success) throw Object.assign(new TypeError(validation.errors.join('; ')), { code: 'invalid-request' })
    signal.throwIfAborted()
    if (request.nodeId !== this.localNodeId) throw Object.assign(new Error('Request targets a different node'), { code: 'wrong-node' })
    if (this.admission) await this.admission(request, signal)
    else if (request.workdirId !== undefined || request.operation !== PROCESS_EXECUTE_OPERATION) throw Object.assign(new Error('Resource execution requires explicit local admission'), { code: 'workdir-unavailable' })
  }

  execute(
    request: ExecutionRequestV2,
    signal: AbortSignal,
  ): AsyncIterable<JobEventV1> {
    const validation = validateExecutionRequestV2(request)
    if (!validation.success) {
      throw new TypeError(
        `Invalid ExecutionRequestV2: ${validation.errors.join('; ')}`,
      )
    }

    let record = this.jobs.get(request.jobId)
    if (record && JSON.stringify(record.request) !== JSON.stringify(request)) throw new TypeError('jobId is already bound to a different request')
    if (!record) {
      record = createRecord(request)
      this.jobs.set(request.jobId, record)
      this.push(record, { type: 'accepted' })
      if (signal.aborted) {
        record.cancelRequested = true
        this.finish(record, 'cancelled', 'cancel-acknowledged', {
          code: 'cancelled', message: 'Job was cancelled before execution', retryable: false,
        })
      } else {
        void this.run(record)
      }
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
    if (!record.process?.isolated) record.process?.process.kill()
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
    try { await this.assertCanExecute(request, new AbortController().signal) }
    catch (error) {
      this.finish(record, 'rejected', 'rejected', {
        code: error instanceof Error && 'code' in error ? String(error.code) : 'admission-denied',
        message: error instanceof Error ? error.message : 'Execution admission denied', retryable: false,
      })
      return
    }
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
    if (operationHandler && 'prepareProcess' in operationHandler) {
      await this.runWorkdirProcess(record, operationHandler)
      return
    }
    if (operationHandler) {
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
        for (let offset = 0; offset < output.length; offset += 8192) {
          this.push(record, { type: 'stdout', chunk: output.slice(offset, offset + 8192) })
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
    const args = parseProcessArgs(request.args)
    if (!args) {
      this.finish(record, 'rejected', 'rejected', {
        code: 'invalid-process-args',
        message: 'process.execute requires valid script and cwd arguments',
        retryable: false,
      })
      return
    }

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

  private async runWorkdirProcess(record: JobRecord, handler: LocalProcessOperationHandler): Promise<void> {
    const controller = new AbortController()
    record.operationController = controller
    if (record.cancelRequested) controller.abort()
    const remainingMs = Math.min(120_000, Math.max(0, Date.parse(record.request.deadlineAt) - Date.now()))
    const timer = setTimeout(() => {
      record.timedOut = true
      controller.abort()
    }, remainingMs)
    let abort: (() => void) | undefined
    let cleanup: Promise<ManagedProcessStatus> | undefined
    let status: ManagedProcessStatus | undefined
    let cleaned = false
    let outputLimitTimer: ReturnType<typeof setInterval> | undefined
    try {
      if (remainingMs === 0) {
        record.timedOut = true
        controller.abort()
      }
      controller.signal.throwIfAborted()
      const args = await handler.prepareProcess(record.request, controller.signal)
      controller.signal.throwIfAborted()
      const process = await this.startProcess(args, {
        isolated: true, signal: controller.signal, supervision: {
          deadlineAt: Math.min(Date.parse(record.request.deadlineAt), Date.now() + remainingMs),
          resultPath: this.processResultPath?.(record.request),
        },
      })
      record.process = process
      const terminate = () => cleanup ??= terminateWorkdirProcess(process)
      const interrupted = Promise.withResolvers<ManagedProcessStatus>()
      abort = () => { void terminate().then(interrupted.resolve, interrupted.reject) }
      controller.signal.addEventListener('abort', abort, { once: true })
      outputLimitTimer = setInterval(() => {
        const size = [...process.stdoutChunks, ...process.stderrChunks]
          .reduce((total, chunk) => total + chunk.byteLength, 0)
        if (size > MAX_WORKDIR_PROCESS_OUTPUT_BYTES) controller.abort()
      }, 20)
      this.setState(record, record.cancelRequested ? 'cancelling' : 'running')
      this.push(record, { type: 'started', pid: process.pid })
      if (controller.signal.aborted) abort()
      // Await cleanup as well as exit: an acknowledgement must not precede tree termination.
      status = await Promise.race([
        process.exitPromise,
        interrupted.promise,
      ])
      await terminate()
      cleaned = true
      const tooLarge = this.emitBoundedProcessOutput(record, process)
      if ((tooLarge || status.guardian?.reason === 'output-limit') && !record.cancelRequested && !record.timedOut) {
        this.finish(record, 'failed', 'failed', {
          code: 'process-output-too-large',
          message: 'Remote shell output exceeded 128 KiB; output is truncated',
          retryable: false,
        }, status)
      } else this.finishFromStatus(record, status)
    } catch (error) {
      if (record.process) {
        try {
          await (cleanup ??= terminateWorkdirProcess(record.process))
          cleaned = true
        } catch (cleanupError) {
          this.finish(record, 'failed', 'failed', {
            code: 'process-cleanup-failed',
            message: cleanupError instanceof Error ? cleanupError.message : 'Process cleanup failed',
            retryable: false,
          })
          return
        }
        this.emitBoundedProcessOutput(record, record.process)
      }
      if (record.cancelRequested || record.timedOut) {
        this.finishFromStatus(record, status ?? { success: false, code: -1, signal: null })
      } else {
        this.finish(record, record.process ? 'failed' : 'rejected', record.process ? 'failed' : 'rejected', {
          code: error instanceof Error && 'code' in error && typeof error.code === 'string'
            ? error.code : 'process-execution-failed',
          message: error instanceof Error ? error.message : 'Workdir shell execution failed',
          retryable: false,
        }, status)
      }
    } finally {
      clearTimeout(timer)
      clearInterval(outputLimitTimer)
      if (abort) controller.signal.removeEventListener('abort', abort)
      record.operationController = undefined
      if (cleaned && record.process && 'remove' in this.processManager && typeof this.processManager.remove === 'function') {
        this.processManager.remove(record.process.pid)
      }
    }
  }

  private emitBoundedProcessOutput(record: JobRecord, process: ManagedProcess): boolean {
    let remaining = MAX_WORKDIR_PROCESS_OUTPUT_BYTES
    let truncated = false
    for (const [type, chunks] of [['stdout', process.stdoutChunks], ['stderr', process.stderrChunks]] as const) {
      const kept: Uint8Array[] = []
      for (const chunk of chunks) {
        if (chunk.byteLength > remaining) truncated = true
        kept.push(chunk.subarray(0, remaining))
        remaining = Math.max(0, remaining - chunk.byteLength)
      }
      const output = decodeChunks(kept, process.shell)
      // Keep JSON-escaped events comfortably below the transport's 256 KiB frame limit.
      for (let offset = 0; offset < output.length; offset += 8192) {
        this.push(record, { type, chunk: output.slice(offset, offset + 8192) })
      }
    }
    if (truncated) this.push(record, { type: 'stderr', chunk: '\n[Remote shell output truncated at 128 KiB]\n' })
    return truncated
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
    if (status.guardian?.reason === 'supervisor-failed' || status.guardian?.reason === 'cleanup-failed') {
      this.finish(record, 'failed', 'failed', {
        code: status.guardian.reason,
        message: status.guardian.error ?? 'Process ownership could not be confirmed; execution outcome is unknown',
        retryable: false,
      }, status)
    } else if (record.timedOut || status.guardian?.reason === 'deadline-expired') {
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
