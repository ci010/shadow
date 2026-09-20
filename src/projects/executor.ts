import { isManagedWorkdir, managedProjectScope, MANAGED_SESSION_CAPABILITY, projectExecutionKey } from '../execution/managed-workdir.ts'
import type { CancelReceiptV1, ExecutionReceiptV1, JobEventV1, JobRequestV1, JobStatusV1 } from '../execution/contracts.ts'
import type { Executor } from '../execution/executor.ts'

/** One shared device transport, with disjoint execution identities and cancellation authority. */
export class ProjectExecutor implements Executor {
  #jobs = new Map<string, string>()
  #pending = new Set<string>()
  get hasPendingJobs(): boolean { return this.#pending.size > 0 }
  constructor(readonly projectId: string, private readonly executor: Executor,
    private readonly authorize?: (request: JobRequestV1) => void,
    private readonly recordJob?: (jobId: string, pending: boolean) => void) {}

  #settle(jobId: string, receipt: ExecutionReceiptV1): void {
    if (['remote-node-unavailable', 'process-cleanup-failed'].includes(receipt.reason?.code ?? '')) return
    this.recordJob?.(jobId, false)
    this.#pending.delete(jobId)
  }

  #key(kind: string, value: string): string {
    return projectExecutionKey(this.projectId, kind, value)
  }

  async *execute(request: JobRequestV1, signal: AbortSignal): AsyncIterable<JobEventV1> {
    this.authorize?.(request)
    this.recordJob?.(request.jobId, true)
    const jobId = this.#key('job', request.jobId)
    this.#jobs.set(request.jobId, jobId)
    this.#pending.add(request.jobId)
    const scoped = {
      ...request, jobId,
      sessionId: this.#key('session', request.sessionId),
      turnId: this.#key('turn', request.turnId),
      idempotencyKey: this.#key('idempotency', request.idempotencyKey),
      ...((isManagedWorkdir(request.capabilityId) || request.capabilityId === MANAGED_SESSION_CAPABILITY)
        ? { managedProject: managedProjectScope(this.projectId) } : {}),
    }
    for await (const event of this.executor.execute(scoped, signal)) {
      if (event.jobId !== jobId) throw new Error('Project executor received an unowned job event')
      if ('receipt' in event) this.#settle(request.jobId, event.receipt)
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
