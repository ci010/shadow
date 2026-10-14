import { finishStartupProfile, profileStartupPhase, startupProjectOrdinal } from './startup-profile.ts'

export type StartupPhase = 'catalog' | 'ownership' | 'cluster' | 'gateway' | 'projects'
  | 'config' | 'events' | 'folders' | 'sessions' | 'io' | 'channels' | 'agent' | 'cron' | 'recovery' | 'ready'
  | 'agent-mcp' | 'agent-skills' | 'agent-types' | 'agent-watchers' | 'agent-sessions'
  | 'session-load' | 'session-migrate' | 'session-lineage' | 'session-task-history' | 'session-reports' | 'session-recovery'

/** Fixed-shape startup diagnostics contain no configuration, paths, or error payloads. */
export class StartupTimings {
  private readonly started = performance.now()

  constructor(private readonly component: 'host' | 'project', private readonly projectId?: string) {
    if (component === 'host') profileStartupPhase('bootstrap', 'completed')
  }

  async measure<T>(phase: StartupPhase, operation: () => T | Promise<T>): Promise<T> {
    const started = performance.now()
    this.emit(phase, 'started')
    try {
      const value = await operation()
      this.emit(phase, 'completed', performance.now() - started)
      return value
    } catch (error) {
      this.emit(phase, 'failed', performance.now() - started)
      throw error
    }
  }

  ready(): void {
    this.emit('ready', 'completed')
    if (this.component === 'host') finishStartupProfile()
  }

  private emit(phase: StartupPhase, status: 'started' | 'completed' | 'failed', durationMs?: number): void {
    profileStartupPhase(`${this.component}-${phase}`, status, {
      ...(this.projectId === undefined ? {} : { projectOrdinal: startupProjectOrdinal(this.projectId) }),
    })
    console.info('[startup] ' + JSON.stringify({
      version: 1, component: this.component,
      ...(this.projectId === undefined ? {} : { projectId: this.projectId }),
      phase, status, elapsedMs: Math.round(performance.now() - this.started),
      ...(durationMs === undefined ? {} : { durationMs: Math.round(durationMs) }),
    }))
  }
}
