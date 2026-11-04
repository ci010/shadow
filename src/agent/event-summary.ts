/** Shared wire/storage constraint; count Unicode code points, not UTF-16 units. */
export const EVENT_SUMMARY_MAX = 280

export function validateEventSummary(value: unknown): string | undefined {
  // Optional only for old records and backwards-compatible non-reflector callers.
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error('Event summary must be a string.')
  const summary = value.replace(/\s+/gu, ' ').trim()
  if (!summary || Array.from(summary).length > EVENT_SUMMARY_MAX) {
    throw new Error(`Event summary must contain 1–${EVENT_SUMMARY_MAX} Unicode code points.`)
  }
  return summary
}
