import { Cron } from 'croner'
import { mkdir, writeFile } from 'node:fs/promises'
import { readFileIfExists, workspacePath } from '../utils/paths.ts'
import {
  isCronEventPayload,
  isCronEventTarget,
  type CronEventPayload,
  type CronEventTarget,
} from './events.ts'

const JOBS_FILE = '.cron/jobs.json'

export interface CronJobDef {
  schedule: string
  task?: string
  channel?: string
  chatId?: string
  target?: CronEventTarget
  event?: CronEventPayload
  deleteAfterRun?: boolean
  /**
   * When true, the job fires into a dedicated isolated `cron:<id>` session
   * instead of delivering an event to the originating session.
   */
  isolated?: boolean
}

export interface CronJob extends CronJobDef {
  id: string
  createdAt: string
}

export interface CronJobHandler {
  (job: CronJob): Promise<void>
}

function isCronJob(value: unknown): value is CronJob {
  if (!value || typeof value !== 'object') return false
  if (!('id' in value) || typeof value.id !== 'string' || !value.id) return false
  if (!('schedule' in value) || typeof value.schedule !== 'string' || !value.schedule) return false
  if (!('createdAt' in value) || typeof value.createdAt !== 'string') return false
  if ('task' in value && value.task !== undefined && typeof value.task !== 'string') return false
  if ('channel' in value && value.channel !== undefined && typeof value.channel !== 'string') return false
  if ('chatId' in value && value.chatId !== undefined && typeof value.chatId !== 'string') return false
  if ('deleteAfterRun' in value && value.deleteAfterRun !== undefined && typeof value.deleteAfterRun !== 'boolean') return false
  if ('isolated' in value && value.isolated !== undefined && typeof value.isolated !== 'boolean') return false
  if ('target' in value && value.target !== undefined && !isCronEventTarget(value.target)) return false
  if ('event' in value && value.event !== undefined && !isCronEventPayload(value.event)) return false
  return true
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

  constructor(private workspace: string, timezone = 'UTC') {
    this.jobsPath = workspacePath(workspace, JOBS_FILE)
    this.timezone = timezone
  }

  setHandler(handler: CronJobHandler): void {
    this.handler = handler
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
    await this.loadJobs()
    for (const job of this.jobs.values()) {
      this.scheduleCron(job)
    }
    console.info(`[cron] Cron service started (${this.jobs.size} jobs)`)
  }

  stop(): void {
    for (const scheduled of this.scheduledJobs.values()) {
      scheduled.stop()
    }
    this.scheduledJobs.clear()
    console.info('[cron] Cron service stopped')
  }

  addJob(def: CronJobDef): string {
    const id = globalThis.crypto.randomUUID().slice(0, 8)
    const job: CronJob = {
      ...def,
      id,
      createdAt: new Date().toISOString(),
    }
    this.jobs.set(id, job)
    this.scheduleCron(job)
    this.saveJobs().catch((error) => console.error('[cron] Failed to save jobs', error))
    console.info(
      `[cron] Added cron job: id=${id}, schedule=${def.schedule}, target=${def.target?.sessionId ?? `${def.channel ?? 'cron'}:${def.chatId ?? id}`}`,
    )
    return id
  }

  removeJob(id: string): boolean {
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
    }
    return removed
  }

  listJobs(): CronJob[] {
    return Array.from(this.jobs.values())
  }

  // ── Internal ──────────────────────────────────────────────────────────

  private scheduleCron(job: CronJob): void {
    try {
      this.scheduledJobs.get(job.id)?.stop()
      const scheduled = new Cron(
        this.normalizeSchedule(job.schedule),
        {
          timezone: /^every\s+/i.test(job.schedule) ? 'UTC' : this.timezone,
          protect: true,
        },
        async () => {
          await this.executeJob(job)
        },
      )
      this.scheduledJobs.set(job.id, scheduled)
    } catch (err) {
      console.error(
        `[cron] Invalid cron schedule: id=${job.id}, schedule=${job.schedule}`,
        err,
      )
    }
  }

  private async executeJob(job: CronJob): Promise<void> {
    if (!this.handler) {
      console.warn(`[cron] No handler configured, skipping job: ${job.id}`)
      return
    }

    console.info(
      `[cron] Executing cron job: id=${job.id}, schedule=${job.schedule}`,
    )
    try {
      await this.handler(job)
    } catch (err) {
      console.error(`[cron] Cron job execution failed: ${job.id}`, err)
    }

    if (job.deleteAfterRun) {
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
    for (const job of store.jobs) {
      if (!isCronJob(job) || jobs.has(job.id)) {
        throw new TypeError(`[cron] Invalid or duplicate job in ${this.jobsPath}`)
      }
      jobs.set(job.id, job)
    }
    this.jobs = jobs
  }

  private async saveJobs(): Promise<void> {
    await mkdir(workspacePath(this.workspace, '.cron'), { recursive: true })
    const store = { version: 1, jobs: Array.from(this.jobs.values()) }
    await writeFile(this.jobsPath, JSON.stringify(store, null, 2))
  }
}
