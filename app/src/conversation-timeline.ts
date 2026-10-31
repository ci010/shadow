// A bounded segment window, not message virtualization. Never evict a reader's viewport.
export const TIMELINE_SEGMENT_LIMIT = 8
export const TIMELINE_MESSAGE_LIMIT = 2000

export interface TimelineSegment<M, D> {
  id: string
  previousId: string | null
  messages: M[]
  decisions: D[]
}

export function timelineCanPrepend<M, D>(segments: TimelineSegment<M, D>[], count: number): boolean {
  return segments.length < TIMELINE_SEGMENT_LIMIT && count < TIMELINE_MESSAGE_LIMIT
}

export function prependScrollTop(before: { top: number; height: number }, height: number): number {
  return Math.max(0, before.top + height - before.height)
}

/** Retain the just-closed current segment once; repeated snapshots must not duplicate it. */
export function retainTimelineRollover<M, D>(segments: TimelineSegment<M, D>[], current: M[], decisions: D[], before: string | null | undefined, after: string | null, closedId: string | null = after): TimelineSegment<M, D>[] {
  if (before === undefined || !after || after === before || segments.some(segment => segment.id === closedId)) return segments
  return [...segments, { id: closedId ?? after, previousId: before, messages: current, decisions }]
}

export function timelineBoundaryPositions<M, D>(segments: TimelineSegment<M, D>[], previousId: string | null): Map<number, string[]> {
  const result = new Map<number, string[]>()
  let index = 0
  for (const segment of segments) {
    if (segment.previousId) result.set(index, [...(result.get(index) ?? []), segment.previousId])
    index += segment.messages.length
  }
  if (previousId) result.set(index, [...(result.get(index) ?? []), previousId])
  return result
}

interface TimelineMessageIdentity {
  role: string
  content: string
  event?: string
  timestamp?: string
  toolCallId?: string
  responseContext?: { responseId?: string }
  timelineKey?: string
}

/** Match persisted identities, not flattened indices, including snapshots with leading rows. */
export function reconcileTimelineKeys<M extends TimelineMessageIdentity>(items: M[], previous: M[]): M[] {
  const identity = (message: M) => JSON.stringify([message.role, message.event, message.toolCallId,
    message.responseContext?.responseId, message.timestamp,
    message.toolCallId || message.responseContext?.responseId ? undefined : message.content])
  const keys = new Map<string, (string | undefined)[]>()
  for (const message of previous) {
    const id = identity(message)
    keys.set(id, [...(keys.get(id) ?? []), message.timelineKey])
  }
  return items.map(message => ({ ...message, timelineKey: keys.get(identity(message))?.shift() }))
}

/** Prune only while following latest; callers keep a reader's window intact. */
export function limitFollowingTimeline<M, D>(segments: TimelineSegment<M, D>[], currentCount: number): TimelineSegment<M, D>[] {
  let count = currentCount + segments.reduce((sum, segment) => sum + segment.messages.length, 0)
  let start = 0
  while (start < segments.length && (segments.length - start > TIMELINE_SEGMENT_LIMIT || count > TIMELINE_MESSAGE_LIMIT)) count -= segments[start++].messages.length
  return start ? segments.slice(start) : segments
}
