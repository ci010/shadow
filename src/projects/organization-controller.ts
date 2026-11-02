import { z } from 'zod'
import { WorkConflict } from '../initiatives/work-contract.ts'
import type { ProjectScope } from './scope.ts'
export const organizationConfigSchema = z.object({
  enabled: z.boolean().default(true),
  model: z.string().trim().min(1).max(512).optional(),
})
export class OrganizationConflict extends WorkConflict {
  constructor(readonly code: 'organization_already_queued' | 'organization_no_topics' | 'organization_stopped' | 'organization_disabled') {
    super(code === 'organization_already_queued' ? 'Organization is already running or queued.' : code)
  }
}
/** Single-flight manual and debounced delta admission. Persisted source sequences, not
 * the in-memory hints, determine whether an automatic execution is necessary. */
export class OrganizationController {
  private organizerEnabled: boolean
  private stopped = false
  private started = false
  private controller?: AbortController
  private running?: Promise<void>
  private manualPending = false
  private manualJob?: Promise<void>
  private timer?: ReturnType<typeof setTimeout>
  private firstHint?: number
  private automaticJob?: Promise<void>
  private generation = 0
  private lastAutomaticError?: 'organization_delta_check_failed' | 'organization_execution_failed'
  private automaticFailures=0
  private lastCheckedAt?: string
  private nextAutomaticAt?: string
  constructor(private deps: {
    scope: ProjectScope
    organize?(mode: 'full' | 'delta', signal: AbortSignal): Promise<void>
    hasDelta?(): Promise<boolean>
    organizationStatus?(): { mode:'full'|'delta'; status:'running'|'completed'|'partial'; coveredCount:number; manifestCount:number; patches:number } | undefined
    changed(): void
    debounceMs?: number
    maxWaitMs?: number
    retryMs?: number
  }, enabled = true) { this.organizerEnabled = enabled }
  /** Startup/re-enable reconciliation also recovers changes made while disabled. */
  start(): void { if (this.started || this.stopped) return; this.started = true; this.notify() }
  notify(): void {
    if (this.stopped || !this.organizerEnabled || !this.deps.hasDelta) return
    this.generation++
    this.firstHint ??= Date.now()
    this.schedule()
  }
  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.nextAutomaticAt = undefined
  }
  private schedule(delay?: number): void {
    if (!this.started || this.stopped || !this.organizerEnabled || this.automaticJob || this.manualPending || this.running) return
    this.clearTimer()
    const wait = delay ?? Math.max(0, Math.min(this.deps.debounceMs ?? 30_000,
      (this.firstHint ?? Date.now()) + (this.deps.maxWaitMs ?? 120_000) - Date.now()))
    this.nextAutomaticAt = new Date(Date.now() + wait).toISOString()
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.nextAutomaticAt = undefined
      const job = this.automatic()
      this.automaticJob = job
      void job.finally(() => {
        this.automaticJob = undefined
        // Even a currently busy/cooling source must be reconsidered after idle or
        // deadline without relying on another metadata event. This is a cheap
        // store check; the executor never starts an empty model run.
        if (!this.stopped && this.organizerEnabled) {
          this.firstHint ??= Date.now()
          this.schedule(Math.min(3_600_000,(this.deps.retryMs ?? 30_000)*2**Math.min(7,this.automaticFailures)))
        }
      })
    }, wait)
    this.timer.unref?.()
  }
  private async automatic(): Promise<void> {
    const generation = this.generation
    this.firstHint = undefined
    let phase: 'check' | 'execute' = 'check'
    try {
      this.lastCheckedAt = new Date().toISOString()
      if (this.stopped || !this.organizerEnabled) return
      const pending = await this.deps.scope.run(() => this.deps.hasDelta!())
      this.lastAutomaticError = undefined
      if (!pending) { this.automaticFailures=0; return }
      if (this.stopped || !this.organizerEnabled) return
      phase = 'execute'
      await this.organizeNow(new AbortController().signal, 'delta')
      this.automaticFailures=0
      phase = 'check'
      // Delta is bounded to three topics. Continue draining persisted leftovers.
      if (!this.stopped && this.organizerEnabled && await this.deps.scope.run(() => this.deps.hasDelta!())) this.firstHint ??= Date.now()
    } catch {
      if (!this.stopped && this.organizerEnabled) {
        // Never surface provider/error payloads: they may contain evidence or prompts.
        this.automaticFailures++
        this.lastAutomaticError = phase === 'check' ? 'organization_delta_check_failed' : 'organization_execution_failed'
        console.warn(`[organization] ${this.lastAutomaticError}; automatic delta will retry`)
      }
      // Failure is not a permanent disable; retry at a bounded rate, never spin.
      if (!this.stopped && this.organizerEnabled) this.firstHint ??= Date.now()
    } finally {
      this.deps.changed()
      if (generation !== this.generation && !this.stopped && this.organizerEnabled) this.firstHint ??= Date.now()
    }
  }
  update(enabled: boolean): void {
    const previous = this.organizerEnabled
    this.organizerEnabled = enabled
    if (!enabled) {
      this.clearTimer(); this.firstHint = undefined
      this.controller?.abort(new OrganizationConflict('organization_disabled'))
    } else if (!previous) this.notify()
    this.deps.changed()
  }
  status() { return { enabled: this.organizerEnabled, running: !!this.running, organization: this.deps.organizationStatus?.(),
    lastAutomaticError: this.lastAutomaticError, lastCheckedAt: this.lastCheckedAt, nextAutomaticAt: this.nextAutomaticAt } }
  organize(signal: AbortSignal, mode: 'full' | 'delta' = 'full'): Promise<void> {
    signal.throwIfAborted()
    if (!this.organizerEnabled) return Promise.reject(new OrganizationConflict('organization_disabled'))
    if (this.manualPending || this.running || this.automaticJob) return Promise.reject(new OrganizationConflict('organization_already_queued'))
    this.clearTimer()
    this.manualPending = true
    const job = (async () => {
      try { await this.organizeNow(signal, mode) }
      finally {
        this.manualPending = false; this.manualJob = undefined
        if (this.firstHint !== undefined) this.schedule()
        this.deps.changed()
      }
    })()
    this.manualJob = job
    this.deps.changed()
    return job
  }
  private async organizeNow(signal: AbortSignal, mode: 'full' | 'delta'): Promise<void> {
    signal.throwIfAborted()
    if (!this.organizerEnabled) throw new OrganizationConflict('organization_disabled')
    if (this.stopped) throw new OrganizationConflict('organization_stopped')
    if (this.running) throw new OrganizationConflict('organization_already_queued')
    if (!this.deps.organize) throw new WorkConflict('Organization execution is unavailable')
    this.controller = new AbortController()
    const bounded = AbortSignal.any([signal, this.controller.signal, AbortSignal.timeout(120_000)])
    this.running = this.deps.scope.run(() => this.deps.organize!(mode, bounded))
    this.deps.changed()
    try { await this.running }
    finally { this.running = undefined; this.controller = undefined; this.deps.changed() }
  }
  async stop(): Promise<void> {
    this.stopped = true
    this.clearTimer(); this.firstHint = undefined
    this.controller?.abort(new OrganizationConflict('organization_stopped'))
    await Promise.allSettled([this.running, this.manualJob, this.automaticJob].filter((job): job is Promise<void> => !!job))
  }
}
