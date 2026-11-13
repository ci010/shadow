import type { AutomationSessionRef } from '../../src/cron/contracts.ts'

/** Identity, not a title/content heuristic. Available in session summaries before
 * the workflow catalog/history loads, including direct links and old segments. */
export function isDedicatedRun(session: { automation?: AutomationSessionRef } | undefined): boolean {
  const automation = session?.automation
  return automation?.contextMode === 'fresh' && !!automation.jobId && !!automation.runId
}

/** Dedicated run metadata is an admitted snapshot, not a prompt or today's job name.
 * Fixed-session deliveries have no fresh association and keep normal session titles. */
export function dedicatedRunTitle(session: { sessionId: string; automation?: AutomationSessionRef } | undefined): string | undefined {
  const automation = session?.automation
  if (automation?.contextMode !== 'fresh' || !automation.jobId || !automation.runId) return undefined
  return automation.name.trim() || undefined
}
