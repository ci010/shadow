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
/** Admission and cancellation for independent explicit organization; no observation subscriptions. */
export class OrganizationController {
  private organizerEnabled: boolean
  private stopped = false
  private controller?: AbortController
  private running?: Promise<void>
  private manualPending = false
  private manualJob?: Promise<void>
  constructor(private deps: {
    scope: ProjectScope
    organize?(mode: 'full' | 'delta', signal: AbortSignal): Promise<void>
    organizationStatus?(): { mode:'full'|'delta'; status:'running'|'completed'|'partial'; coveredCount:number; manifestCount:number; patches:number } | undefined
    changed(): void
  }, enabled = true) { this.organizerEnabled = enabled }
  update(enabled: boolean): void {
    this.organizerEnabled = enabled
    if (!enabled) {
      this.controller?.abort(new OrganizationConflict('organization_disabled'))
    }
    this.deps.changed()
  }
  status() { return { enabled: this.organizerEnabled, running: !!this.running, organization: this.deps.organizationStatus?.() } }
  /** Explicit user action only; no automatic project-wide model calls. */
  organize(signal: AbortSignal, mode: "full" | "delta" = "full"): Promise<void> {
    signal.throwIfAborted()
    if (!this.organizerEnabled) return Promise.reject(new OrganizationConflict("organization_disabled"))
    if (this.manualPending) return Promise.reject(new OrganizationConflict('organization_already_queued'))
    this.manualPending = true
    const job = (async () => {
      try {
        await this.organizeNow(signal, mode)
      } finally {
        this.manualPending = false; this.manualJob = undefined
        this.deps.changed()
      }
    })()
    this.manualJob = job
    this.deps.changed()
    return job
  }
  private async organizeNow(signal: AbortSignal, mode: "full" | "delta"): Promise<void> {
    signal.throwIfAborted()
    if(!this.organizerEnabled) throw new OrganizationConflict("organization_disabled")
    if(this.stopped) throw new OrganizationConflict('organization_stopped')
    if(!this.deps.organize) throw new WorkConflict('Organization execution is unavailable')
    this.controller = new AbortController()
    const bounded = AbortSignal.any([signal,this.controller.signal,AbortSignal.timeout(120_000)])
    this.running = this.deps.scope.run(()=>this.deps.organize!(mode,bounded))
    this.deps.changed()
    try { await this.running }
    finally { this.running=undefined; this.controller=undefined; this.deps.changed() }
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.controller?.abort(new OrganizationConflict('organization_stopped'))
    await Promise.allSettled([this.running, this.manualJob].filter((job): job is Promise<void> => !!job))
  }
}
