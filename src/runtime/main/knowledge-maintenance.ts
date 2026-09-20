import type { CronService } from '../../cron/service.ts'
import type { KnowledgeMaintenanceService } from '../../knowledge/maintenance.ts'

export const KNOWLEDGE_MAINTENANCE_JOB_ID = 'maintenance:knowledge'
export const KNOWLEDGE_MAINTENANCE_CHECK_MS = 60_000

/** Check the durable scan timestamp, so restarting Main does not reset the daily cadence. */
export function scheduleKnowledgeMaintenance(
  cron: CronService,
  maintenance: Pick<KnowledgeMaintenanceService, 'status' | 'scan'>,
  now: () => number = Date.now,
): { start(): Promise<void>; stop(): Promise<void> } {
  let lastAttempt: number | undefined
  let active = false
  cron.registerMaintenanceJob(KNOWLEDGE_MAINTENANCE_JOB_ID, KNOWLEDGE_MAINTENANCE_CHECK_MS, async signal => {
    if (!active) return
    const status = maintenance.status()
    const time = now()
    if (status.scanning || (lastAttempt !== undefined && time - lastAttempt < KNOWLEDGE_MAINTENANCE_CHECK_MS)) return
    if (status.report && time - Date.parse(status.report.scannedAt) < status.intervalMs) return
    lastAttempt = time
    await maintenance.scan(signal)
  })
  return {
    start: () => { active = true; return cron.runNow(KNOWLEDGE_MAINTENANCE_JOB_ID) },
    stop: () => { active = false; return cron.unregisterMaintenanceJob(KNOWLEDGE_MAINTENANCE_JOB_ID) },
  }
}
