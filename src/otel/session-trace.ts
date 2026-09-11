/**
 * Normalized execution telemetry, not session history. Standalone administrative
 * reads are excluded; same-session descendants of execution spans are included.
 */
export interface SessionTraceSpan {
  id: number | null
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  /** Unix milliseconds from recorded telemetry, including sub-millisecond precision. */
  startTime: number
  /** Omitted for live spans or when a completed record has no end time. */
  endTime?: number
  live: boolean
  statusCode?: number
  statusMessage?: string
  attributes: Record<string, string>
  events: Array<{
    name: string
    time: number
    attributes: Record<string, string>
  }>
}

export interface SessionTraceResponse {
  sessionId: string
  physicalSessionId?: string
  /**
   * Completed entries in descending ID order (limit: default 200, maximum 500),
   * followed by active snapshots on latest-page requests only. Active entries
   * are additional to the completed limit; merge them by traceId + spanId.
   */
  entries: SessionTraceSpan[]
  /** Whether more completed spans precede this page. */
  hasMore: boolean
  /** Oldest positive persisted ID, excluding the latest-page live overlay. */
  nextBeforeId?: number
}
