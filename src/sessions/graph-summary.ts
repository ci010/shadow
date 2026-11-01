import type { AutomationSessionRef } from '../cron/contracts.ts'

/** Graph labels are previews, not persisted names or task prompts. */
export const GRAPH_TITLE_LIMIT = 160
export function graphTitle(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  // Bound UTF-16 payload size without splitting a surrogate pair.
  if (value.length <= GRAPH_TITLE_LIMIT) return value
  let end = GRAPH_TITLE_LIMIT - 1
  if (/[\uD800-\uDBFF]/.test(value[end - 1])) end--
  return value.slice(0, end) + '…'
}

/** Association and source classification only; settings/outcomes are fetched on demand. */
export function graphAutomation(ref: AutomationSessionRef | undefined): AutomationSessionRef | undefined {
  if (!ref) return undefined
  return {
    jobId: ref.jobId,
    name: graphTitle(ref.name)!,
    runId: ref.runId,
    startedAt: ref.startedAt,
    contextMode: ref.contextMode,
    ...(ref.config ? { config: { source: ref.config.source, schedule: ref.config.schedule } } : {}),
    ...(ref.legacy !== undefined ? { legacy: ref.legacy } : {}),
  }
}
