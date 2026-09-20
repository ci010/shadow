import { Cron } from 'croner'
import { mkdir, writeFile } from 'node:fs/promises'
import { readFileIfExists, workspacePath } from '../utils/paths.ts'
import { getProjectScope, type ProjectScope } from '../projects/scope.ts'
import type { CronContextMode } from './contracts.ts'
import { parseWorkdirRefV1, type WorkdirRefV1 } from '../sessions/locality.ts'
import { validateOwnership } from '../projects/ownership.ts'
import { normalizeInitiativeMetadata, parseInitiativeId } from '../sessions/initiative-metadata.ts'
import {
  isCronEventPayload,
  isCronEventTarget,
  type CronEventPayload,
  type CronEventTarget,
} from './events.ts'

const JOBS_FILE = '.cron/jobs.json'

export interface CronJobDef {
  name?: string
  session?: CronContextMode
  agentType?: string
  source?: 'cron' | 'learning'
  enabled?: boolean
  originSessionId?: string
  folderId?: string
  initiativeId?: string
  workspaceRoot?: string
  workdir?: WorkdirRefV1
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
  (job: CronJob, signal: AbortSignal): Promise<void>
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
  parseInitiativeId(v)
  if (v.session !== undefined && v.session !== 'existing' && v.session !== 'fresh') return false
  if (v.session === 'fresh' ? v.target !== undefined : !isCronEventTarget(v.target)) return false
  if (v.source !== undefined && v.source !== 'cron' && v.source !== 'learning') return false
  if (v.enabled !== undefined && typeof v.enabled !== 'boolean') return false
  for (const field of ['name', 'agentType', 'originSessionId', 'folderId', 'initiativeId', 'workspaceRoot']) {
    if (v[field] !== undefined && (typeof v[field] !== 'string' || !v[field])) return false
  }
  if (v.workdir !== undefined && !parseWorkdirRefV1(v.workdir)) return false
  return true
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
 * Jobs are persisted to `.cron/jobs.json` in the workspace and
 * execute through the agent via the message bus.
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
  private running = new Map<Promise<void>, AbortController>()
  private persistenceTail: Promise<void> = Promise.resolve()
  private persistenceError: unknown
  private managed = new Map<string, { job: CronJob; handler: CronJobHandler; intervalMs: number }>()
  private maintenance = new Map<string, { intervalMs: number; handler: (signal: AbortSignal) => Promise<void> }>()
  private intervals = new Map<string, ReturnType<typeof setInterval>>()
  private executing = new Map<string, Promise<void>>()
  private onChanged?: () => void

  constructor(
    private workspace: string,
    timezone = 'UTC',
    private scope: ProjectScope | undefined = getProjectScope(),
  ) {
    this.jobsPath = workspacePath(workspace, JOBS_FILE)
    this.timezone = timezone
  }

  setHandler(handler: CronJobHandler): void {
    this.handler = handler
  }

  setOnChanged(callback: () => void): void { this.onChanged = callback }

  /** Config-owned jobs are reconstructed once per runtime, never duplicated in jobs.json. */
  registerManagedJob(id: string, def: CronJobDef, intervalMs: number, handler: CronJobHandler): void {
    if (this.stopped) throw new Error('CronService is stopped')
    if (!Number.isInteger(intervalMs) || intervalMs < 1 || intervalMs > 2_147_483_647) throw new TypeError('Invalid job interval')
    const job = { ...structuredClone(def), id, createdAt: this.managed.get(id)?.job.createdAt ?? new Date().toISOString() }
    if (!isCronJob(job) || this.jobs.has(id) || this.maintenance.has(id)) throw new TypeError('Invalid managed cron job')
    this.managed.set(id, { job, intervalMs, handler })
    this.scheduleManaged(id)
    this.onChanged?.()
  }

  unregisterManagedJob(id: string): void {
    clearInterval(this.intervals.get(id))
    this.intervals.delete(id)
    this.managed.delete(id)
    this.onChanged?.()
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

  /**
   * Register a callback invoked whenever a job is removed (including auto-removal
   * of `deleteAfterRun` one-shot jobs). Used to clean up linked resources such
   * as event subscriptions.
   */
  setOnJobRemoved(cb: (jobId: string) => void): void {
    this.onJobRemovedCb = cb
  }

  async start(): Promise<void> {
    await this.flush()
    await this.loadJobs()
    this.stopped = false
    for (const job of this.jobs.values()) {
      this.scheduleCron(job)
    }
    for (const id of this.managed.keys()) this.scheduleManaged(id)
    for (const [id, task] of this.maintenance) this.scheduleInterval(id, task.intervalMs, true)
    console.info(`[cron] Cron service started (${this.jobs.size} jobs)`)
  }

  async stop(): Promise<void> {
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

  addJob(def: CronJobDef): string {
    if (this.stopped) throw new Error('CronService is stopped')
    const id = globalThis.crypto.randomUUID().slice(0, 8)
    const job: CronJob = {
      ...structuredClone(def),
      id,
      createdAt: new Date().toISOString(),
    }
    if (!isCronJob(job)) throw new TypeError('Invalid cron job')
    const validation = new Cron(this.normalizeSchedule(job.schedule), { paused: true, timezone: this.timezone })
    validation.stop()
    this.jobs.set(id, job)
    this.scheduleCron(job)
    this.saveJobs().catch((error) => console.error('[cron] Failed to save jobs', error))
    this.onChanged?.()
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
      this.saveJobs().catch((error) => console.error('[cron] Failed to save jobs', error))
      console.info(`[cron] Removed cron job: ${id}`)
      this.onJobRemovedCb?.(id)
      this.onChanged?.()
    }
    return removed
  }

  listJobs(): CronJob[] {
    return structuredClone([...this.jobs.values(), ...[...this.managed.values()].map(m => m.job)])
  }

  // ── Internal ──────────────────────────────────────────────────────────

  private scheduleCron(job: CronJob): void {
    if (job.enabled === false) return
    try {
      this.scheduledJobs.get(job.id)?.stop()
      const scheduled = new Cron(
        this.normalizeSchedule(job.schedule),
        {
          timezone: /^every\s+/i.test(job.schedule) ? 'UTC' : this.timezone,
          protect: true,
        },
        () => this.scope ? this.scope.run(() => this.runJob(job)) : this.runJob(job),
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
    try {
      await pending
    } finally {
      this.running.delete(pending)
      this.executing.delete(id)
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
      await handler(job, signal)
    } catch (err) {
      console.error(`[cron] Cron job execution failed: ${job.id}`, err)
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
    const store: unknown = JSON.parse(raw)
    if (Array.isArray(store)) {
      throw new Error(
        `[cron] Legacy jobs file: ${this.jobsPath}. Back it up outside jobs.json and recreate the jobs with standard cron weekdays (0=Sunday, 1=Monday). Legacy schedules are not converted or executed.`,
      )
    }
    if (
      !store || typeof store !== 'object' ||
      !('version' in store) || store.version !== 1 ||
      !('jobs' in store) || !Array.isArray(store.jobs)
    ) {
      throw new TypeError(`[cron] Expected { version: 1, jobs: [...] } in ${this.jobsPath}`)
    }
    const jobs = new Map<string, CronJob>()
    if (!('ownershipVersion' in store) || store.ownershipVersion !== 2) throw new TypeError('Unsupported cron ownership version')
    for (const raw of store.jobs) {
      if (!raw || typeof raw !== 'object') throw new TypeError('Invalid cron job')
      const { ownershipVersion: _, projectId, ...job } = normalizeInitiativeMetadata(validateOwnership({
        ...raw, ownershipVersion: store.ownershipVersion,
      }))
      if (projectId !== undefined && projectId !== this.scope?.projectId) throw new TypeError('Cron job belongs to another project')
      if (!isCronJob(job) || jobs.has(job.id) || this.maintenance.has(job.id)) {
        throw new TypeError(`[cron] Invalid or duplicate job in ${this.jobsPath}`)
      }
      jobs.set(job.id, job)
    }
    this.jobs = jobs
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
    const contents = JSON.stringify({ version: 1, ownershipVersion: 2, jobs: Array.from(this.jobs.values()) }, null, 2)
    const pending = this.persistenceTail.then(async () => {
      await mkdir(workspacePath(this.workspace, '.cron'), { recursive: true })
      await writeFile(this.jobsPath, contents)
    })
    this.persistenceTail = pending.then(
      () => { this.persistenceError = undefined },
      (error) => { this.persistenceError = error },
    )
    return pending
  }
}
