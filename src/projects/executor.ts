import { managedProjectScope, projectExecutionKey } from '../execution/managed-workdir.ts'
import type { CancelReceiptV1, ExecutionReceiptV1, JobEventV1, ExecutionRequestV2, JobRequestV2, JobStatusV1 } from '../execution/contracts.ts'
import { validateExecutionRequestV2 } from '../execution/contracts.ts'
import type { Executor } from '../execution/executor.ts'
import { isUnknownShellReceipt } from '../execution/shell-journal.ts'

/** Fixed host-owned directory operation profile; advertisements cannot widen it. */
export const DIRECTORY_OPERATIONS = Object.freeze([
  'filesystem.read', 'filesystem.write', 'workdir.git.status', 'workdir.git.diff', 'workdir.identity',
  'workdir.process.execute', 'workdir.process.execute-once', 'workdir.process.reconcile',
])

/** Shared transport; access checks and disjoint execution/cancellation identities are Project-owned. */
export class ProjectExecutor implements Executor {
  #jobs = new Map<string, string>()
  #pending = new Set<string>()
  #executionKeys = new Map<string, string>()
  get hasPendingJobs(): boolean { return this.#pending.size > 0 }
  constructor(readonly projectId: string, private readonly executor: Executor,
    private readonly assertAccess: (request: ExecutionRequestV2, signal: AbortSignal) => void | Promise<void>,
    private readonly recordJob?: (jobId: string, pending: boolean) => void,
    private readonly recordReconciliation?: (originalScopedJobId: string) => void,
    private readonly acquireAccess?: () => () => void) {}

  #settle(jobId: string, receipt: ExecutionReceiptV1): void {
    if (isUnknownShellReceipt(receipt)) return
    this.recordJob?.(jobId, false)
    this.#pending.delete(jobId)
    this.#executionKeys.delete(jobId)
  }

  #key(kind: string, value: string): string {
    return projectExecutionKey(this.projectId, kind, value)
  }

  async *execute(input: ExecutionRequestV2, signal: AbortSignal): AsyncIterable<JobEventV1> {
    const release = this.acquireAccess?.()
    try { yield* this.#executeAuthorized(input, signal) }
    finally { release?.() }
  }

  async *#executeAuthorized(input: ExecutionRequestV2, signal: AbortSignal): AsyncIterable<JobEventV1> {
    signal.throwIfAborted()
    const validation = validateExecutionRequestV2(input)
    if (!validation.success) throw new TypeError(`Invalid execution request: ${validation.errors.join('; ')}`)
    // Async identity checks must authorize a stable admission snapshot, not a
    // mutable caller object that can change target or command while awaiting.
    const request = structuredClone(validation.value)
    await this.assertAccess(request, signal)
    signal.throwIfAborted()
    const reconciliation = request.operation === 'workdir.process.reconcile'
    // Read-only identity and reconciliation queries cannot own a process. A
    // transport failure must not create an unresolvable durable reservation.
    const readOnlyQuery = reconciliation || request.operation === 'workdir.identity'
    if (!readOnlyQuery) this.recordJob?.(request.jobId, true)
    const jobId = this.#key('job', request.jobId)
    this.#jobs.set(request.jobId, jobId)
    if (!readOnlyQuery) this.#pending.add(request.jobId)
    const executionKey = JSON.stringify([
      request.idempotencyKey, request.nodeId,
      request.workdirId !== undefined ? request.workdirId : undefined,
      request.sessionId, request.turnId,
    ])
    if (request.operation === 'workdir.process.execute-once') {
      this.#executionKeys.set(request.jobId, executionKey)
    }
    const scoped: JobRequestV2 = {
      ...request, jobId,
      sessionId: this.#key('session', request.sessionId),
      turnId: this.#key('turn', request.turnId),
      idempotencyKey: this.#key('idempotency', request.idempotencyKey),
      // Keep the old scope algorithm; a caller's Project scope is never authority.
      projectScope: managedProjectScope(this.projectId),
    }
    for await (const event of this.executor.execute(scoped, signal)) {
      if (event.jobId !== jobId) throw new Error('Project executor received an unowned job event')
      if ('receipt' in event) {
        if (reconciliation) {
          // Refusing or losing the query says nothing about the original process.
          // Only a correlated journal replay can release its ownership protection.
          if (event.receipt.reconciledJobId && !isUnknownShellReceipt(event.receipt)) {
            this.recordReconciliation?.(event.receipt.reconciledJobId)
            for (const [id, key] of this.#executionKeys) {
              if (key === executionKey) this.#settle(id, event.receipt)
            }
          }
        } else if (!readOnlyQuery) this.#settle(request.jobId, event.receipt)
      }
      yield { ...event, jobId: request.jobId, ...('receipt' in event ? { receipt: { ...event.receipt, jobId: request.jobId } } : {}) }
    }
  }

  async getStatus(jobId: string): Promise<JobStatusV1 | null> {
    const key = this.#jobs.get(jobId)
    if (!key) return null
    return this.#status(jobId, await this.executor.getStatus(key))
  }

  #status(jobId: string, status: JobStatusV1 | null): JobStatusV1 | null {
    if (!status) return null
    if (status.jobId !== this.#jobs.get(jobId)) throw new Error('Project executor received an unowned job status')
    if (status.receipt) this.#settle(jobId, status.receipt)
    return { ...status, jobId, ...(status.receipt ? { receipt: { ...status.receipt, jobId } } : {}) }
  }

  async cancel(jobId: string): Promise<CancelReceiptV1> {
    const key = this.#jobs.get(jobId)
    if (!key) return { version: 1, jobId, outcome: 'not-found', timestamp: new Date().toISOString(), status: null }
    const result = await this.executor.cancel(key)
    if (result.jobId !== key) throw new Error('Project executor received an unowned cancellation receipt')
    return { ...result, jobId, status: this.#status(jobId, result.status) }
  }
}
