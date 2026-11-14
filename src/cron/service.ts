import type { WorkflowRuntime } from '../workflows/runtime.ts'
import { canonical } from '../workflows/json.ts'
import { Cron } from 'croner'
import { WORK_DISPATCH_ID, workDispatchConfigSchema, type WorkDispatchConfig } from './work-dispatch-contract.ts'
import { BotWakeSchema, type BotWake } from '../bots/host-contract.ts'
import { mkdir } from 'node:fs/promises'
import { writePrivateFile } from '../utils/private-file.ts'
import { readFileIfExists, workspacePath } from '../utils/paths.ts'
import { getProjectScope, type ProjectScope } from '../projects/scope.ts'
import type { CronContextMode } from './contracts.ts'
import { parseWorkdirRef, type WorkdirRefV2 } from '../sessions/locality.ts'
import { validateOwnership } from '../projects/ownership.ts'
import { normalizeInitiativeMetadata, parseInitiativeId } from '../sessions/initiative-metadata.ts'
import {
  isCronEventPayload,
  isCronEventTarget,
  type CronEventPayload,
  type CronEventTarget,
} from './events.ts'

import { scheduleDelivery } from './delivery.ts'

const JOBS_FILE = '.cron/jobs.json'

export interface CronJobDef {
  /** Trusted program action, dispatched before any agent/model path. */
  program?: WorkDispatchConfig
  /** Host-created binding-scoped Bot wake. Never dispatched as a generic cron event. */
  botWake?: BotWake
  /** Host-configured tool/budget ceiling for fresh agent executions. */
  executionLimits?: { allowedTools: string[]; inferenceRequests: number; toolCalls: number; argumentBytes: number }
  name?: string
  session?: CronContextMode
  agentType?: string
  source?: 'cron' | 'learning'
  enabled?: boolean
  originSessionId?: string
  folderId?: string
  initiativeId?: string
  workspaceRoot?: string
  workdir?: WorkdirRefV2
  schedule: string
  task?: string
  target?: CronEventTarget
  event?: CronEventPayload
  deleteAfterRun?: boolean
}

export interface CronJob extends CronJobDef {
  id: string
  createdAt: string
}

export interface CronJobHandler {
  (job: CronJob, signal: AbortSignal): Promise<void | { sessionId: string }>
}

function isCronJob(value: unknown): value is CronJob {
  if (!value || typeof value !== 'object') return false
  if (!('id' in value) || typeof value.id !== 'string' || !value.id) return false
  if (!('schedule' in value) || typeof value.schedule !== 'string' || !value.schedule) return false
  if (!('createdAt' in value) || typeof value.createdAt !== 'string') return false
  if ('task' in value && value.task !== undefined && typeof value.task !== 'string') return false
  if ('deleteAfterRun' in value && value.deleteAfterRun !== undefined && typeof value.deleteAfterRun !== 'boolean') return false
  if ('isolated' in value) return false
  if ('target' in value && value.target !== undefined && !isCronEventTarget(value.target)) return false
  if ('event' in value && value.event !== undefined && !isCronEventPayload(value.event)) return false
  const v = value as Record<string, unknown>
  if (v.program !== undefined) {
    const parsed = workDispatchConfigSchema.safeParse(v.program)
    if (!parsed.success || v.id !== WORK_DISPATCH_ID || v.session !== 'fresh' || v.source !== 'cron'
      || v.botWake !== undefined || v.executionLimits !== undefined || v.target !== undefined || v.event !== undefined) return false
    v.program = parsed.data
  }
  if (v.botWake !== undefined) {
    const parsed = BotWakeSchema.safeParse(v.botWake)
    if (!parsed.success || v.session !== 'existing' || !isCronEventTarget(v.target) || v.target.sessionId !== parsed.data.sessionId || v.schedule !== `every ${parsed.data.intervalMinutes}m`) return false
  }
  if (v.executionLimits !== undefined) {
    const limits = v.executionLimits as CronJobDef['executionLimits']
    if (!limits || typeof limits !== 'object' || !Array.isArray(limits.allowedTools) ||
      limits.allowedTools.some(name => typeof name !== 'string' || !name) ||
      ![limits.inferenceRequests, limits.toolCalls, limits.argumentBytes].every(n => Number.isSafeInteger(n) && n > 0) ||
      Object.keys(limits).some(key => !['allowedTools', 'inferenceRequests', 'toolCalls', 'argumentBytes'].includes(key)) ||
      v.session !== 'fresh') return false
  }
  parseInitiativeId(v)
  if (v.session !== undefined && v.session !== 'existing' && v.session !== 'fresh') return false
  if (v.session === 'fresh' ? v.target !== undefined : !isCronEventTarget(v.target)) return false
  if (v.source !== undefined && v.source !== 'cron' && v.source !== 'learning') return false
  if (v.enabled !== undefined && typeof v.enabled !== 'boolean') return false
  for (const field of ['name', 'agentType', 'originSessionId', 'folderId', 'initiativeId', 'workspaceRoot']) {
    if (v[field] !== undefined && (typeof v[field] !== 'string' || !v[field])) return false
  }
  if (v.workdir !== undefined) {
    const workdir = parseWorkdirRef(v.workdir)
    if (!workdir) return false
    v.workdir = workdir
  }
  return true
}

/** Pure persisted reader, also used by startup ownership scanning without starting timers. */
export function parseStoredCronJobs(store: unknown, projectId?: string): { jobs: CronJob[]; initializedDefaults: string[] } {
  if (Array.isArray(store)) throw new TypeError('Legacy cron schedules are not converted or executed; recreate them with standard cron weekdays')
  if (!store || typeof store !== 'object' || !('version' in store) || store.version !== 1 ||
    !('jobs' in store) || !Array.isArray(store.jobs)) throw new TypeError('Expected { version: 1, jobs: [...] } cron storage')
  if (!('ownershipVersion' in store) || store.ownershipVersion !== 2) throw new TypeError('Unsupported cron ownership version')
  const defaults = 'initializedDefaults' in store ? store.initializedDefaults : []
  if (!Array.isArray(defaults) || defaults.some(key => typeof key !== 'string' || !key)) throw new TypeError('Invalid automation defaults')
  const ids = new Set<string>()
  const jobs = store.jobs.map(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('Invalid cron job')
    const { ownershipVersion: _, projectId: owner, ...job } = normalizeInitiativeMetadata(validateOwnership({
      ...raw, projectId: raw.projectId === undefined ? projectId : raw.projectId, ownershipVersion: store.ownershipVersion,
    }))
    if (owner !== undefined && owner !== projectId) throw new TypeError('Cron job belongs to another project')
    if (!isCronJob(job) || ids.has(job.id)) throw new TypeError('Invalid or duplicate cron job')
    ids.add(job.id)
    return job
  })
  return { jobs, initializedDefaults: defaults as string[] }
}

export function cronContextMode(job: CronJobDef): CronContextMode {
  return job.session ?? 'existing'
}

/**
 * Persistent cron service backed by Node.js timers.
 *
 * Supports:
 * - Cron expressions (e.g., "0 9 * * *") — interpreted as local time in the
 *   configured timezone, including daylight-saving transitions.
 * - Interval shorthand (e.g., "every 5m", "every 1h") — always UTC, no shift.
 * - One-time schedules (`deleteAfterRun: true`)
 *
 * Source definitions are Project-local; the host attaches the shared Workflow
 * executor as a required constructor dependency. No standalone action fallback exists.
 *
 */
export class CronService {
  private jobs = new Map<string, CronJob>()
  private scheduledJobs = new Map<string, Cron>()
  private jobsPath: string
  private handler: CronJobHandler | null = null
  private onJobRemovedCb: ((jobId: string) => void) | null = null
  private timezone: string
  private stopped = false
  private lifecycleGeneration = 0
  private running = new Map<Promise<void>, AbortController>()
  private persistenceTail: Promise<void> = Promise.resolve()
  private persistenceError: unknown
  private managed = new Map<string, { job: CronJob; handler: CronJobHandler; intervalMs: number }>()
  private maintenance = new Map<string, { intervalMs: number; handler: (signal: AbortSignal) => Promise<void> }>()
  private intervals = new Map<string, ReturnType<typeof setInterval>>()
  private executing = new Map<string, Promise<void>>()
  private onChanged?: (reason: 'inventory' | 'execution') => void
  private initializedDefaults = new Set<string>()

  constructor(
    private workspace: string,
    private workflows: WorkflowRuntime,
    timezone = 'UTC',
    private scope: ProjectScope | undefined = getProjectScope(),
  ) {
    this.jobsPath = workspacePath(workspace, JOBS_FILE)
    this.timezone = timezone
    this.bindWorkflow()
  }

  setHandler(handler: CronJobHandler): void {
    this.handler = handler
  }

  setOnChanged(callback: (reason: 'inventory' | 'execution') => void): void { this.onChanged = callback }

  /** Config-owned jobs are reconstructed once per runtime, never duplicated in jobs.json. */
  registerManagedJob(id: string, def: CronJobDef, intervalMs: number, handler: CronJobHandler): void {
    if (this.stopped) throw new Error('CronService is stopped')
    if (!Number.isInteger(intervalMs) || intervalMs < 1 || intervalMs > 2_147_483_647) throw new TypeError('Invalid job interval')
    const job = { ...structuredClone(def), id, createdAt: this.managed.get(id)?.job.createdAt ?? new Date().toISOString() }
    if (!isCronJob(job) || this.jobs.has(id) || this.maintenance.has(id)) throw new TypeError('Invalid managed cron job')
    const previous = this.managed.get(id)
    this.managed.set(id, { job, intervalMs, handler })
    this.syncWorkflow(job)
    if (!previous || previous.intervalMs !== intervalMs || previous.job.enabled !== job.enabled) this.scheduleManaged(id)
    this.onChanged?.('inventory')
  }

  unregisterManagedJob(id: string): void {
    clearInterval(this.intervals.get(id))
    this.intervals.delete(id)
    if (this.managed.delete(id)) this.onChanged?.('inventory')
  }

  private scheduleManaged(id: string): void {
    const managed = this.managed.get(id)!
    this.scheduleInterval(id, managed.intervalMs, managed.job.enabled !== false)
  }

  /** Code-owned, non-agent work uses the same scoped execution and shutdown lifecycle. */
  registerMaintenanceJob(id: string, intervalMs: number, handler: (signal: AbortSignal) => Promise<void>): void {
    if (this.stopped) throw new Error('CronService is stopped')
    if (!id || this.jobs.has(id) || this.managed.has(id) || this.maintenance.has(id)) throw new TypeError('Invalid maintenance job ID')
    if (!Number.isInteger(intervalMs) || intervalMs < 1 || intervalMs > 2_147_483_647) throw new TypeError('Invalid job interval')
    this.maintenance.set(id, { intervalMs, handler })
    this.scheduleInterval(id, intervalMs, true)
  }

  async unregisterMaintenanceJob(id: string): Promise<void> {
    if (!this.maintenance.has(id)) return
    clearInterval(this.intervals.get(id))
    this.intervals.delete(id)
    this.maintenance.delete(id)
    const pending = this.executing.get(id)
    if (pending) {
      this.running.get(pending)?.abort(new Error('Maintenance job stopped'))
      await Promise.allSettled([pending])
    }
  }

  private scheduleInterval(id: string, intervalMs: number, enabled: boolean): void {
    clearInterval(this.intervals.get(id))
    this.intervals.delete(id)
    if (enabled) this.intervals.set(id, setInterval(() => {
      void this.runNow(id).catch(error => console.error('[cron]', error))
    }, intervalMs))
  }

  /** Schedule is an input adapter; only the Project host installs the action implementation. */
  private bindWorkflow(): void {
    const workflows = this.workflows
    if (this.scope && this.scope.projectId !== workflows.projectId) throw new Error('Schedule and Workflow must belong to the same Project')
    workflows.bindSchedule({
      current: raw => {
        if (this.stopped || !isCronJob(raw)) return false
        const live = this.managed.get(raw.id)?.job ?? this.jobs.get(raw.id)
        if (!live) return false
        // Disabling controls future ticks; it does not revoke an already admitted run.
        const config = ({ enabled: _enabled, ...rest }: CronJob) => {
          // Managed source registration time changes across process starts, not its identity/config.
          const value = JSON.parse(JSON.stringify(rest))
          if (this.managed.has(raw.id)) delete value.createdAt
          return value
        }
        return canonical(config(live)) === canonical(config(raw))
      },
      execute: async (raw, signal) => {
        if (!isCronJob(raw) || !scheduleDelivery(raw)) throw new Error('Invalid schedule delivery')
        const handler = this.managed.get(raw.id)?.handler ?? this.handler
        if (!handler) throw new Error('Schedule handler unavailable')
        const execute = async () => {
          let output: void | { sessionId: string }
          if (this.executing.has(raw.id)) output = await handler(raw, signal)
          else {
            // Recovered/retried Workflow runs still participate in cron cancellation/projection.
            await this.runOwned(raw.id, async abort => { output = await handler(raw, abort) }, signal)
          }
          if (raw.deleteAfterRun && !this.stopped) { this.removeJob(raw.id); await this.flush() }
          return output!
        }
        return await (this.scope ? this.scope.run(execute) : execute())
      },
    })
  }

  /** Manual and timer admissions share overlap protection, scope, abort and cleanup. */
  runNow(id: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    const maintenance = this.maintenance.get(id)
    if (maintenance) {
      const run = () => this.runOwned(id, abort => {
        abort.throwIfAborted()
        return maintenance.handler(abort)
      }, signal)
      return this.scope ? this.scope.run(run) : run()
    }

    const job = this.managed.get(id)?.job ?? this.jobs.get(id)
    if (!job) return Promise.reject(new Error(`Unknown cron job: ${id}`))
    return this.scope ? this.scope.run(() => this.runJob(job, signal)) : this.runJob(job, signal)
  }

  /** Cancellation is independent of enablement: disabling only prevents future timer admissions. */
  async cancelRun(id: string): Promise<boolean> {
    const pending = this.executing.get(id)
    if (!pending) return false
    this.running.get(pending)?.abort(new Error('Automation cancelled'))
    await Promise.allSettled([pending])
    return true
  }

  /** Install a normal persisted default once; user removal and preferences survive reload. */
  async ensureDefaultJob(key: string, def: CronJobDef): Promise<void> {
    if (this.stopped) throw new Error('CronService is stopped')
    if (!key || key.length > 100) throw new TypeError('Invalid automation default key')
    if (this.initializedDefaults.has(key)) return
    // A stable installation identity also deduplicates a restart between the job and marker writes.
    const id = `default:${key}`
    if (!this.jobs.has(id)) {
      const flow = this.workflows.inspect().definitions.find(d => d.id === `schedule:${id}`)
      const node = flow?.nodes[0]
      if (flow && flow.enabled && flow.source.kind === 'schedule' && flow.source.id === id && node?.kind === 'schedule-action'
        && isCronJob(node.job) && !this.workflows.hasAdmitted(flow.id)
        && canonical(node.job) === canonical({ ...def, id, createdAt: node.job.createdAt })) {
        // Resume only an identical default installation whose Workflow committed
        // before jobs.json. Retired/admitted/changed identities are never revived.
        this.jobs.set(id, structuredClone(node.job))
        this.scheduleCron(this.jobs.get(id)!)
      } else this.addJob(def, id)
    }
    this.initializedDefaults.add(key)
    await this.saveJobs()
  }

  /**
   * Register a callback invoked whenever a job is removed (including auto-removal
   * of `deleteAfterRun` one-shot jobs). Used to clean up linked resources such
   * as event subscriptions.
   */
  setOnJobRemoved(cb: (jobId: string) => void): void {
    this.onJobRemovedCb = cb
  }

  async start(): Promise<void> {
    if (!this.workflows.available) throw new Error('Schedule requires an active Workflow runtime')
    const generation = ++this.lifecycleGeneration
    await this.flush()
    await this.loadJobs()
    if (generation !== this.lifecycleGeneration || !this.workflows.available) throw new Error('Schedule startup superseded or Workflow stopped')
    this.stopped = false
    for (const job of this.jobs.values()) {
      this.syncWorkflow(job)
      this.scheduleCron(job)
    }
    for (const [id, { job }] of this.managed) { this.syncWorkflow(job); this.scheduleManaged(id) }
    for (const [id, task] of this.maintenance) this.scheduleInterval(id, task.intervalMs, true)
    console.info(`[cron] Cron service started (${this.jobs.size} jobs)`)
  }

  async stop(): Promise<void> {
    this.lifecycleGeneration++
    this.stopped = true
    for (const scheduled of this.scheduledJobs.values()) {
      scheduled.stop()
    }
    this.scheduledJobs.clear()
    for (const timer of this.intervals.values()) clearInterval(timer)
    this.intervals.clear()
    for (const controller of this.running.values()) controller.abort(new Error('Cron service stopped'))
    await Promise.allSettled(this.running.keys())
    await this.flush()
    console.info('[cron] Cron service stopped')
  }

  addJob(def: CronJobDef, id = globalThis.crypto.randomUUID().slice(0, 8)): string {
    if (this.stopped) throw new Error('CronService is stopped')
    if (this.workflows.inspect().definitions.some(d => d.id === `schedule:${id}`) || Object.hasOwn(this.workflows.inspect().dedupe, `schedule:${id}`) || this.workflows.hasAdmitted(`schedule:${id}`) || this.jobs.has(id) || this.managed.has(id) || this.maintenance.has(id)) throw new TypeError('Duplicate cron job ID')
    const job: CronJob = {
      ...structuredClone(def),
      id,
      createdAt: new Date().toISOString(),
    }
    if (!isCronJob(job)) throw new TypeError('Invalid cron job')
    const validation = new Cron(this.normalizeSchedule(job.schedule), { paused: true, timezone: this.timezone })
    validation.stop()
    this.jobs.set(id, job)
    this.syncWorkflow(job)
    this.scheduleCron(job)
    this.saveJobs().catch((error) => console.error('[cron] Failed to save jobs', error))
    this.onChanged?.('inventory')
    console.info(
      `[cron] Added cron job: id=${id}, schedule=${def.schedule}, target=${def.target?.sessionId ?? 'fresh session per run'}`,
    )
    return id
  }

  removeJob(id: string): boolean {
    if (this.stopped) throw new Error('CronService is stopped')
    const scheduled = this.scheduledJobs.get(id)
    if (scheduled) {
      scheduled.stop()
      this.scheduledJobs.delete(id)
    }
    const removed = this.jobs.delete(id)
    if (removed) {
      if (this.workflows.available && this.workflows.enabled(`schedule:${id}`) !== undefined) this.workflows.manage(`schedule:${id}`, 'pause')
      this.saveJobs().catch((error) => console.error('[cron] Failed to save jobs', error))
      console.info(`[cron] Removed cron job: ${id}`)
      this.onJobRemovedCb?.(id)
      this.onChanged?.('inventory')
    }
    return removed
  }

  /** Update a persisted user job without cancelling an admitted execution. */
  async setJobEnabled(id: string, enabled: boolean): Promise<boolean> {
    if (this.stopped) throw new Error('CronService is stopped')
    const job = this.jobs.get(id)
    if (!job) return false
    if (typeof enabled !== 'boolean') throw new TypeError('Enabled must be a boolean')
    if ((job.enabled !== false) !== enabled) {
      job.enabled = enabled
      this.scheduledJobs.get(id)?.stop()
      this.scheduledJobs.delete(id)
      this.scheduleCron(job)
    }
    // Retry persistence even when memory already reflects a previous failed save.
    await this.saveJobs()
    this.syncWorkflow(job)
    this.onChanged?.('inventory')
    return true
  }

  /** Same persistence/timer lifecycle as ordinary jobs; only host API can configure programs. */
  async configureProgram(id: string, program: WorkDispatchConfig, schedule?: string): Promise<void> {
    if (this.stopped) throw new Error('CronService is stopped')
    const prior = this.jobs.get(id)
    if (!prior?.program) throw new TypeError('Unknown program automation')
    const next = { ...prior, program, ...(schedule ? { schedule } : {}) }
    if (!isCronJob(next)) throw new TypeError('Invalid program automation')
    const validation = new Cron(this.normalizeSchedule(next.schedule), { paused: true, timezone: this.timezone })
    validation.stop()
    this.jobs.set(id, next)
    this.scheduledJobs.get(id)?.stop()
    this.scheduledJobs.delete(id)
    this.scheduleCron(next)
    await this.saveJobs()
    this.syncWorkflow(next)
    this.onChanged?.('inventory')
  }

  private syncWorkflow(job: CronJob): void {
    if (this.stopped || !this.workflows.available) return
    const id = `schedule:${job.id}`
    const old = this.workflows.inspect().definitions.find(d => d.id === id)
    const node = { kind: 'schedule-action' as const, action: job.program || job.source === 'learning' ? 'program' as const : scheduleDelivery(job)?.kind === 'automation' ? 'agent' as const : 'session' as const, job: JSON.parse(JSON.stringify(job)), delivery: scheduleDelivery(job)! }
    // Do not rewrite equivalent legacy definitions on startup. Saved run snapshots remain untouched.
    const comparable = (nodes: unknown[]) => nodes.map(raw => {
      const { delivery: _delivery, ...rest } = raw as Record<string, unknown>
      if (this.managed.has(job.id) && rest.job && typeof rest.job === 'object') {
        const { createdAt: _createdAt, ...config } = rest.job as Record<string, unknown>
        rest.job = config
      }
      return rest
    })
    const changed = !old || old.gate !== undefined || canonical(comparable(old.nodes)) !== canonical(comparable([node]))
    this.workflows.define({ id, name: job.name ?? job.task?.slice(0, 160) ?? job.id, owner: job.originSessionId ?? job.target?.sessionId,
      revision: old ? old.revision + Number(changed) : 1, source: { kind: 'schedule', id: job.id }, enabled: old?.enabled ?? true, nodes: !changed && old ? old.nodes : [node] })
  }
  async updateJob(id: string, definition: CronJobDef): Promise<string> {
    const old = this.jobs.get(id)
    if (this.stopped || !old || old.program || old.botWake || old.source === 'learning') throw new Error('Only user schedule jobs can be revised')
    const job = { ...structuredClone(definition), id, createdAt: old.createdAt, enabled: old.enabled }
    if (!isCronJob(job)) throw new TypeError('Invalid cron job')
    const validation = new Cron(this.normalizeSchedule(job.schedule), { paused: true, timezone: this.timezone }); validation.stop()
    this.jobs.set(id, job)
    this.scheduledJobs.get(id)?.stop(); this.scheduledJobs.delete(id)
    await this.saveJobs()
    if (this.stopped || this.jobs.get(id) !== job) return id
    this.syncWorkflow(job)
    this.scheduleCron(job)
    this.onChanged?.('inventory')
    return id
  }
  workflowStatus(id: string) {
    const pending = this.workflows.pending(`schedule:${id}`)
    return { id: `schedule:${id}`, pending: pending.length, blocked: pending.filter(r => r.status === 'blocked').length }
  }
  isRunning(id: string): boolean { return this.executing.has(id) }

  listJobs(): CronJob[] {
    return structuredClone([...this.jobs.values(), ...[...this.managed.values()].map(m => m.job)])
  }

  nextJobRun(id: string): string | null {
    return this.scheduledJobs.get(id)?.nextRun()?.toISOString() ?? null
  }

  // ── Internal ──────────────────────────────────────────────────────────

  private scheduleCron(job: CronJob): void {
    if (this.stopped || this.jobs.get(job.id) !== job) return
    if (job.enabled === false) return
    try {
      this.scheduledJobs.get(job.id)?.stop()
      const scheduled = new Cron(
        this.normalizeSchedule(job.schedule),
        {
          timezone: /^every\s+/i.test(job.schedule) ? 'UTC' : this.timezone,
          protect: true,
        },
        () => job.enabled === false ? undefined : this.scope ? this.scope.run(() => this.runJob(job)) : this.runJob(job),
      )
      this.scheduledJobs.set(job.id, scheduled)
    } catch (err) {
      console.error(
        `[cron] Invalid cron schedule: id=${job.id}, schedule=${job.schedule}`,
        err,
      )
    }
  }

  private async runJob(job: CronJob, signal?: AbortSignal): Promise<void> {
    return this.runOwned(job.id, abort => this.executeJob(structuredClone(job), abort), signal)
  }

  private async runOwned(id: string, execute: (signal: AbortSignal) => Promise<void>, signal?: AbortSignal): Promise<void> {
    if (this.stopped) return
    const existing = this.executing.get(id)
    if (existing) return existing
    const controller = new AbortController()
    const abort = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    const pending = Promise.resolve().then(() => execute(controller.signal))
    this.running.set(pending, controller)
    this.executing.set(id, pending)
    if (!this.maintenance.has(id)) this.onChanged?.('execution')
    try {
      await pending
    } finally {
      this.running.delete(pending)
      this.executing.delete(id)
      if (!this.maintenance.has(id)) this.onChanged?.('execution')
      signal?.removeEventListener('abort', abort)
    }
  }

  private async executeJob(job: CronJob, signal: AbortSignal): Promise<void> {
    const handler = this.managed.get(job.id)?.handler ?? this.handler
    if (!handler) {
      console.warn(`[cron] No handler configured, skipping job: ${job.id}`)
      return
    }

    console.info(
      `[cron] Executing cron job: id=${job.id}, schedule=${job.schedule}`,
    )
    try {
      signal.throwIfAborted()
      {
        await this.flush() // Admit only after user Schedule configuration is durable.
        const workflow = `schedule:${job.id}`
        if (this.workflows.enabled(workflow) === false) return
        // Drop overlapping ticks, including durable blocked/retry state after restart. No catch-up burst.
        if (!this.workflows.pending(workflow).length) {
          this.syncWorkflow(job)
          this.workflows.admit([{ workflow, source: { kind: 'schedule', id: job.id }, observations: [{ id: crypto.randomUUID(), data: { scheduledAt: new Date().toISOString() } }] }])
        }
        await this.workflows.drain(workflow, signal)
        if (this.workflows.pending(workflow).length) throw new Error('Workflow action pending or blocked; inspect v:workflows')
      }
    } catch (err) {
      console.error(`[cron] Cron job execution failed: ${job.id}`, err)
      return // Keep one-shot sources when admission/effect did not complete.
    }

    if (job.deleteAfterRun && !this.stopped) {
      this.removeJob(job.id)
    }
  }

  /**
   * Normalize shorthand interval syntax to cron expressions.
   * Examples: "every 5m" becomes a 5-minute interval, "every 1h" becomes hourly
   */
  private normalizeSchedule(schedule: string): string {
    const intervalMatch = schedule.match(/^every\s+(\d+)([smh])$/i)
    if (!intervalMatch) {
      return schedule
    }

    const amount = parseInt(intervalMatch[1], 10)
    if (amount < 1) throw new TypeError('Cron interval must be positive')
    const unit = intervalMatch[2].toLowerCase()

    switch (unit) {
      case 's':
        return `*/${amount} * * * * *`
      case 'm':
        return `*/${amount} * * * *`
      case 'h':
        return `0 */${amount} * * *`
      default:
        return schedule
    }
  }

  private async loadJobs(): Promise<void> {
    const raw = await readFileIfExists(this.jobsPath)
    if (raw === undefined) return
    const parsed = parseStoredCronJobs(JSON.parse(raw), this.scope?.projectId)
    if (parsed.jobs.some(job => this.maintenance.has(job.id))) throw new TypeError('Cron job conflicts with maintenance')
    this.jobs = new Map(parsed.jobs.map(job => [job.id, job]))
    this.initializedDefaults = new Set(parsed.initializedDefaults)
  }

  async flush(): Promise<void> {
    let pending: Promise<void>
    do {
      pending = this.persistenceTail
      await pending
    } while (pending !== this.persistenceTail)
    if (this.persistenceError !== undefined) throw this.persistenceError
  }

  private saveJobs(): Promise<void> {
    const contents = JSON.stringify({ version: 1, ownershipVersion: 2,
      ...(this.initializedDefaults.size ? { initializedDefaults: [...this.initializedDefaults] } : {}),
      jobs: Array.from(this.jobs.values()) }, null, 2)
    const pending = this.persistenceTail.then(async () => {
      await mkdir(workspacePath(this.workspace, '.cron'), { recursive: true })
      writePrivateFile(this.jobsPath, contents)
    })
    this.persistenceTail = pending.then(
      () => { this.persistenceError = undefined },
      (error) => { this.persistenceError = error },
    )
    return pending
  }
}
