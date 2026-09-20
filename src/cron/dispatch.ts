import type { SessionManager } from '../sessions/session-manager.ts'
import { cronContextMode, type CronJob } from './service.ts'
import type { AutomationSessionRef } from './contracts.ts'

/** All fresh executions, including learning, enter the normal SessionManager lifecycle. */
export class CronDispatcher {
  constructor(
    private sessions: SessionManager,
    private deliverEvent: (job: CronJob, targetSessionId: string, signal: AbortSignal) => Promise<void>,
    private changed: (sessionId?: string) => void = () => {},
  ) {}

  async dispatch(job: CronJob, signal: AbortSignal, task = job.task ?? '', onAccepted?: (sessionId: string) => void): Promise<string> {
    signal.throwIfAborted()
    const mode = cronContextMode(job)
    if (mode === 'existing') {
      const target = job.target?.sessionId
      if (!target) throw new Error('Existing-session cron requires a target session.')
      this.sessions.assertCanScheduleSession(job.originSessionId ?? target, target)
      await this.deliverEvent(job, target, signal)
      return target
    }
    // Revalidate the owning session and folder/capability through SessionManager.
    if (job.originSessionId && !this.sessions.getSessionState(job.originSessionId)) {
      throw new Error('Automation origin session is no longer available')
    }
    const runId = crypto.randomUUID()
    const automation: AutomationSessionRef = {
      jobId: job.id, name: job.name ?? job.task ?? job.id, runId,
      startedAt: new Date().toISOString(), contextMode: 'fresh',
      config: {
        source: job.source ?? 'cron', schedule: job.schedule, task,
        agentType: job.agentType ?? 'general', originSessionId: job.originSessionId,
      },
    }
    const sessionId = `cron:${runId}`
    try {
      const started = await this.sessions.startSession({
        channel: 'cron', chatId: runId, agentType: job.agentType ?? 'general',
        task, signal, mode: 'task', automation, waitForCompletion: true,
        onAccepted,
        locality: {
          folderId: job.folderId, initiativeId: job.initiativeId,
          workspaceRoot: job.workspaceRoot, workdir: job.workdir,
        },
      })
      if (!started) throw new Error(`Automation session was not accepted (agent type: ${job.agentType})`)
      const status = this.sessions.getSessionState(started)?.executionStatus
      if (status === 'failed' || status === 'cancelled') throw new Error(`Automation execution ${status}: ${started}`)
      return started
    } finally { this.changed(sessionId) }
  }
}
