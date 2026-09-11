import type { SessionTraceResponse, SessionTraceSpan } from '../../src/otel/session-trace.ts'

export type { SessionTraceSpan } from '../../src/otel/session-trace.ts'
export type EventKind = 'SYSTEM' | 'USER' | 'CONTEXT' | 'ASSISTANT' | 'TOOL'
export interface DiagnosisEvent {
  id: string
  kind: EventKind
  turn: number
  title: string
  content: string
  timestamp?: number
  callId?: string
  arguments?: string
  result?: string
  reasoning?: string
  usage?: string
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function detailText(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  return JSON.stringify(value, null, 2)
}

export function formatTraceDuration(ms?: number): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return 'Unavailable'
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(2)} s`
  return `${Math.floor(ms / 60000)}m ${Math.floor(ms % 60000 / 1000)}s`
}

export function traceKey(span: Pick<SessionTraceSpan, 'traceId' | 'spanId'>): string {
  return `${span.traceId}:${span.spanId}`
}

export function spanDuration(span: SessionTraceSpan, now: number): number | undefined {
  const end = span.live ? now : span.endTime
  return end !== undefined && end >= span.startTime ? end - span.startTime : undefined
}

export function mergeTraceSpans(
  existing: readonly SessionTraceSpan[],
  incoming: readonly SessionTraceSpan[],
  latest = false,
): SessionTraceSpan[] {
  const byId = new Map(existing.filter(span => !latest || !span.live).map(span => [traceKey(span), span]))
  for (const span of incoming) byId.set(traceKey(span), span)
  return [...byId.values()].sort((a, b) => a.startTime - b.startTime || traceKey(a).localeCompare(traceKey(b)))
}

/** Use the union, not the sum, so nested spans and parallel tools count only once. */
export function traceDuration(spans: readonly SessionTraceSpan[], now: number): number | undefined {
  const intervals = spans.flatMap(span => {
    const duration = spanDuration(span, now)
    return duration === undefined ? [] : [[span.startTime, span.startTime + duration] as const]
  }).sort((a, b) => a[0] - b[0])
  if (!intervals.length) return undefined
  let total = 0
  let start = intervals[0][0]
  let end = intervals[0][1]
  for (const interval of intervals.slice(1)) {
    if (interval[0] > end) {
      total += end - start
      start = interval[0]
    }
    end = Math.max(end, interval[1])
  }
  return total + end - start
}

export type TracePage = SessionTraceResponse

function stringMap(value: unknown): value is Record<string, string> {
  return record(value) && Object.values(value).every(item => typeof item === 'string')
}

export function parseTracePage(value: unknown, sessionId: string, physicalSessionId?: string): TracePage {
  if (!record(value) || value.sessionId !== sessionId || value.physicalSessionId !== physicalSessionId
    || !Array.isArray(value.entries) || typeof value.hasMore !== 'boolean'
    || (value.nextBeforeId !== undefined && (!Number.isSafeInteger(value.nextBeforeId) || Number(value.nextBeforeId) <= 0))
    || (value.hasMore && value.nextBeforeId === undefined)) {
    throw new Error('Invalid session trace response.')
  }
  const entries = value.entries.map((entry): SessionTraceSpan => {
    if (!record(entry) || typeof entry.traceId !== 'string' || !entry.traceId
      || typeof entry.spanId !== 'string' || !entry.spanId || typeof entry.name !== 'string'
      || typeof entry.startTime !== 'number' || !Number.isFinite(entry.startTime) || entry.startTime < 0
      || typeof entry.live !== 'boolean' || !stringMap(entry.attributes) || !Array.isArray(entry.events)
      || (entry.id !== null && (!Number.isSafeInteger(entry.id) || Number(entry.id) <= 0))
      || (entry.endTime !== undefined && (typeof entry.endTime !== 'number' || !Number.isFinite(entry.endTime)))
      || (entry.parentSpanId !== undefined && typeof entry.parentSpanId !== 'string')
      || (entry.statusCode !== undefined && typeof entry.statusCode !== 'number')
      || (entry.statusMessage !== undefined && typeof entry.statusMessage !== 'string')) {
      throw new Error('Invalid session trace span.')
    }
    return {
      id: entry.id === null ? null : Number(entry.id),
      traceId: entry.traceId, spanId: entry.spanId, name: entry.name,
      parentSpanId: entry.parentSpanId,
      startTime: entry.startTime, endTime: entry.endTime,
      live: entry.live, statusCode: entry.statusCode, statusMessage: entry.statusMessage,
      attributes: entry.attributes,
      events: entry.events.map(event => {
        if (!record(event) || typeof event.name !== 'string' || typeof event.time !== 'number'
          || !Number.isFinite(event.time) || !stringMap(event.attributes)) {
          throw new Error('Invalid session trace event.')
        }
        return { name: event.name, time: event.time, attributes: event.attributes }
      }),
    }
  })
  return {
    sessionId, physicalSessionId, entries, hasMore: value.hasMore,
    nextBeforeId: value.nextBeforeId === undefined ? undefined : Number(value.nextBeforeId),
  }
}

export function parseDiagnosisHistory(value: unknown): { events: DiagnosisEvent[]; physicalId?: string } {
  if (!record(value) || !Array.isArray(value.messages)
    || (value.currentPhysicalId !== undefined && typeof value.currentPhysicalId !== 'string')) {
    throw new Error('Invalid session history response.')
  }
  const events: DiagnosisEvent[] = []
  const calls = new Map<string, DiagnosisEvent>()
  let turn = 0
  for (const [index, message] of value.messages.entries()) {
    if (!record(message) || typeof message.role !== 'string') throw new Error('Invalid session history message.')
    const parts = Array.isArray(message.content) ? message.content : undefined
    const content = parts ? parts.map(part => record(part) && part.type === 'text' ? detailText(part.text) : detailText(part)).join('\n') : detailText(message.content)
    const firstText = parts ? (record(parts[0]) && parts[0].type === 'text' ? detailText(parts[0].text) : '') : content
    const timestamp = typeof message.timestamp === 'string' ? Date.parse(message.timestamp) : NaN
    const time = Number.isFinite(timestamp) ? timestamp : undefined
    const isContext = message.name === '__compaction_summary__' || (message.role === 'user' && /^<event\s[^>]*\/>/.test(firstText))
    if (message.role === 'user' && !isContext) turn++
    if (message.role === 'tool') {
      const callId = typeof message.tool_call_id === 'string' ? message.tool_call_id : undefined
      const call = callId ? calls.get(callId) : undefined
      if (call) {
        call.result = content
        if (callId) calls.delete(callId)
      } else {
        events.push({ id: `message-${index}`, kind: 'TOOL', turn, title: String(message.name ?? 'Tool result'), content, result: content, timestamp: time, callId })
      }
      continue
    }
    const kind = isContext ? 'CONTEXT'
      : message.role === 'system' ? 'SYSTEM'
      : message.role === 'assistant' ? 'ASSISTANT'
      : message.role === 'user' ? 'USER' : 'CONTEXT'
    if (content || message.role !== 'assistant' || message.reasoning_content || message.reasoning_text) {
      events.push({
        id: `message-${index}`, kind, turn,
        title: kind === 'CONTEXT' ? (message.name === '__compaction_summary__' ? 'Compaction context' : 'Session event') : kind.toLowerCase(),
        content, timestamp: time,
        reasoning: detailText(message.reasoning_text ?? message.reasoning_content) || undefined,
        usage: message.usage ? detailText(message.usage) : undefined,
      })
    }
    if (message.tool_calls !== undefined && !Array.isArray(message.tool_calls)) throw new Error('Invalid tool calls in history.')
    for (const [callIndex, call] of (message.tool_calls ?? []).entries()) {
      if (!record(call) || typeof call.id !== 'string' || !record(call.function)
        || typeof call.function.name !== 'string') throw new Error('Invalid tool call in history.')
      const args = detailText(call.function.arguments)
      const event: DiagnosisEvent = {
        id: `message-${index}-call-${callIndex}`, kind: 'TOOL', turn,
        title: call.function.name, content: args, arguments: args, timestamp: time, callId: call.id,
      }
      events.push(event)
      calls.set(call.id, event)
    }
  }
  return { events, physicalId: value.currentPhysicalId }
}

export function eventMatches(event: DiagnosisEvent, query: string, kind = 'ALL'): boolean {
  return (kind === 'ALL' || event.kind === kind)
    && matchesTerms([event.kind, event.title, event.content, event.arguments, event.result, event.reasoning, event.callId, event.usage].join('\n'), query)
}

export function spanMatches(span: SessionTraceSpan, query: string): boolean {
  return matchesTerms([span.name, span.traceId, span.spanId, span.statusMessage, ...Object.values(span.attributes),
    ...span.events.map(event => `${event.name} ${Object.values(event.attributes).join(' ')}`)].join('\n'), query)
}

/** Call IDs are provider-owned and may be reused in a later turn. Never guess across duplicates. */
export function correlateToolSpans(events: readonly DiagnosisEvent[], spans: readonly SessionTraceSpan[]): Map<string, SessionTraceSpan> {
  const byCall = new Map<string, SessionTraceSpan[]>()
  const eventCounts = new Map<string, number>()
  for (const event of events) {
    if (event.kind === 'TOOL' && event.callId) eventCounts.set(event.callId, (eventCounts.get(event.callId) ?? 0) + 1)
  }
  for (const span of spans) {
    const id = span.attributes['tool.call_id']
    if (span.name !== 'agent.tool' || !id) continue
    const group = byCall.get(id) ?? []
    group.push(span)
    byCall.set(id, group)
  }
  const result = new Map<string, SessionTraceSpan>()
  for (const event of events) {
    const matches = event.callId ? byCall.get(event.callId) : undefined
    if (event.callId && eventCounts.get(event.callId) === 1 && matches?.length === 1) result.set(event.id, matches[0])
  }
  return result
}

function matchesTerms(text: string, query: string): boolean {
  const haystack = text.toLowerCase()
  return query.toLowerCase().trim().split(/\s+/).every(term => haystack.includes(term))
}

export interface TraceWindow { start: number; end: number }
export function fitTraceWindow(window: TraceWindow, full: TraceWindow): TraceWindow {
  const duration = Math.max(0, Math.min(window.end - window.start, full.end - full.start))
  const start = Math.max(full.start, Math.min(window.start, full.end - duration))
  return { start, end: start + duration }
}

export function stackTimelineItems<T extends TraceWindow>(items: readonly T[]): Array<T & { track: number }> {
  const trackEnds: number[] = []
  return [...items].sort((a, b) => a.start - b.start).map(item => {
    let track = trackEnds.findIndex(end => end < item.start)
    if (track < 0) track = trackEnds.length
    trackEnds[track] = item.end
    return { ...item, track }
  })
}

export async function fetchDiagnosisJson(url: URL, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { signal })
  if (response.status === 404 && url.pathname === '/v1/query/session-spans') {
    throw new Error('Session traces are unavailable on this backend. Restart Shadow after updating the backend.')
  }
  if (!response.ok) throw new Error(`Diagnosis request failed (HTTP ${response.status}).`)
  return response.json()
}
