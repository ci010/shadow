import type { AutomationSessionRef } from '../../src/cron/contracts.ts'

/** Dedicated run metadata is an admitted snapshot, not a prompt or today's job name.
 * Fixed-session deliveries have no fresh association and keep normal session titles. */
export function dedicatedRunTitle(session: { sessionId: string; automation?: AutomationSessionRef } | undefined): string | undefined {
  const automation = session?.automation
  if (automation?.contextMode !== 'fresh' || !automation.jobId || !automation.runId) return undefined
  return automation.name.trim() || undefined
}
