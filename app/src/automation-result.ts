import type { AutomationRunSummary } from './automations.ts'

export interface ResultMessage {
  role: string
  content: string
  timestamp?: string
  event?: string
  isSummary?: boolean
  isSystemEvent?: boolean
  sessionSource?: unknown
  commandReceipt?: unknown
  media?: string[]
}
export interface AutomationResult {
  key: string
  run: AutomationRunSummary
  summary: string
  timestamp?: string
  /** Existing final response projected as a result, or metadata at completion order. */
  source: 'response' | 'metadata'
  replaceIndex?: number
}

/** View-only projection. Never append a fabricated user/assistant record to history.
 * Run receipts belong to the current tail, not a targeted older physical segment.
 * Legacy receipts have no recorded completion time: keep completion order, don't
 * misrepresent startedAt (or the last tool timestamp) as the receipt time.
 */
export function automationResult(run: AutomationRunSummary | undefined, sessionId: string,
  messages: readonly ResultMessage[], historical = false, loading = false, currentStartIndex = 0): AutomationResult | undefined {
  if (!run || run.sessionId !== sessionId || historical || loading || run.status === 'running' || run.status === 'unknown') return
  // A seeded older segment must not supply a final response for an empty current segment.
  const last = messages.length > currentStartIndex ? messages.at(-1) : undefined
  const final = last?.role === 'assistant' && !last.event && !last.isSummary && !last.isSystemEvent
    && !last.sessionSource && !last.commandReceipt && !last.media?.length && !!last.content.trim()
  const summary = run.learning?.summary ?? (final ? last.content : '')
  const replaceIndex = final && (!run.learning || last.content.trim() === summary.trim()) ? messages.length - 1 : undefined
  return { key: `automation-result:${sessionId}:${run.id}`, run, summary,
    source: run.learning || !final ? 'metadata' : 'response',
    ...(replaceIndex !== undefined ? { replaceIndex } : {}),
    ...(!run.learning && final && last.timestamp ? { timestamp: last.timestamp } : {}),
  }
}
