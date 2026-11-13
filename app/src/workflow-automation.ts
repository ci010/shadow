import type { AutomationSummary } from './automations.ts'

/** Catalog identity, not titles, run-session targets or a recent-runs approximation. */
export function automationWorkflowId(job: AutomationSummary): string | undefined {
  return job.workflow?.id ?? (job.id === 'system:work-organizer' ? 'internal:work-organizer' : undefined)
}

/** Ambiguous associations are unavailable rather than silently mixing profiles. */
export function workflowAutomation(jobs: readonly AutomationSummary[], workflowId: string): AutomationSummary | undefined {
  if (!workflowId) return undefined
  const matches = jobs.filter(job => automationWorkflowId(job) === workflowId)
  return matches.length === 1 ? matches[0] : undefined
}
