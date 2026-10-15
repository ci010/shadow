import type { CronService } from '../../cron/service.ts'
import type { SessionRetirement } from '../../sessions/retirement.ts'

export const SESSION_RETIREMENT_JOB_ID = 'maintenance:session-retirement'
export const SESSION_RETIREMENT_INTERVAL_MS = 86_400_000

export function scheduleSessionRetirement(
  cron: CronService,
  retirement: Pick<SessionRetirement, 'scan' | 'stop'>,
): { start(): Promise<void>; stop(): Promise<void> } {
  let active = false
  cron.registerMaintenanceJob(SESSION_RETIREMENT_JOB_ID, SESSION_RETIREMENT_INTERVAL_MS,
    signal => active ? retirement.scan(signal) : Promise.resolve())
  return {
    start: () => {
      active = true
      return cron.runNow(SESSION_RETIREMENT_JOB_ID)
    },
    stop: async () => {
      active = false
      await retirement.stop()
      await cron.unregisterMaintenanceJob(SESSION_RETIREMENT_JOB_ID)
    },
  }
}
