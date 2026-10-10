import type { EnsureRuntimeResult, MainRuntimeStatus } from './coordinator.js'
import { startupFailure } from '../sidecar/startup-diagnostics.js'

/** Electron owns startup; rendering or reloading a window only observes it. */
export class RuntimeStartup {
  private attempt: Promise<EnsureRuntimeResult> = Promise.resolve({ ok: false, code: 'invalid-state' })
  private pending = false

  constructor(
    private readonly launch: () => Promise<EnsureRuntimeResult>,
    private readonly status: () => MainRuntimeStatus,
  ) {}

  async current(): Promise<EnsureRuntimeResult> {
    const result = await this.attempt
    if (!result.ok) return result
    const status = this.status()
    if (status.phase === 'ready') return result
    const failure = startupFailure(status)
    return { ok: false, code: 'runtime-unavailable', ...(failure ? { failure } : {}) }
  }

  start(): Promise<EnsureRuntimeResult> {
    if (this.pending) return this.attempt
    this.pending = true
    this.attempt = Promise.resolve().then(this.launch).catch((): EnsureRuntimeResult => {
      console.error('[desktop] Runtime startup failed; retry from the recovery screen.')
      return { ok: false, code: 'runtime-unavailable' }
    }).finally(() => { this.pending = false })
    return this.attempt
  }
}
