import { sessionMessageTitle, type SessionMessageSource } from './message-author.ts'
import { eventPresentation, eventSourceSession, type ChatEventMeta } from './chat-events.ts'
import { decisionStatusLabel, inlineYieldDecisions, type YieldDecision } from './yield-history.ts'
import type { ToolActivityMessage } from './tool-activity.ts'

export interface HistoryMessage extends ToolActivityMessage {
  role: string
  content: string
  timestamp?: string
  event?: string
  isSystemEvent?: boolean
  isSummary?: boolean
  sessionSource?: SessionMessageSource
  senderName?: string
  eventMeta?: ChatEventMeta
}

export interface MessageHistoryMarker {
  index: number
  preview: string
  timestamp?: string
  kind: 'user' | 'session' | 'event' | 'decision' | 'collaboration'
  label: string
  source: string
  sourceId?: string
  status?: YieldDecision['status']
  groupable?: boolean
  members?: readonly MessageHistoryMarker[]
}

export function isUserMessage(message: HistoryMessage): boolean {
  return message.role === 'user' && !message.isSystemEvent && !message.isSummary && !message.event && !message.sessionSource
}

export function resendableUserMessage<T extends HistoryMessage>(messages: readonly T[]): T | undefined {
  const last = messages.findLast(message => message.role !== 'command')
  return last && isUserMessage(last) ? last : undefined
}

export function messageTime(timestamp?: string, locale?: string): { dateTime?: string; label: string; title: string } {
  const date = typeof timestamp === 'string' && timestamp ? new Date(timestamp) : undefined
  if (!date || !Number.isFinite(date.getTime())) return { label: 'Time unavailable', title: 'No timestamp was recorded for this message.' }
  return {
    dateTime: date.toISOString(),
    label: new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date),
    title: new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'long' }).format(date),
  }
}

export function messageHistoryMarkers(
  messages: readonly HistoryMessage[],
  sessions: readonly { sessionId: string; label: string }[] = [],
  decisions: ReadonlyMap<number, YieldDecision> = inlineYieldDecisions(messages).entries,
): MessageHistoryMarker[] {
  const names = new Map(sessions.map(session => [session.sessionId, session.label]))
  const markers: MessageHistoryMarker[] = messages.flatMap((message, index) => {
    if (message.role !== 'user' || message.isSummary || message.event) return []
    let kind: MessageHistoryMarker['kind']
    let label: string
    let source: string
    let sourceId: string | undefined
    if (message.isSystemEvent) {
      if (!message.eventMeta) return []
      sourceId = eventSourceSession(message.eventMeta)
      const presentation = eventPresentation(message.eventMeta)
      if (!sourceId && !presentation.completion) return []
      kind = 'event'
      label = presentation.title
      source = (sourceId && names.get(sourceId)) || message.eventMeta.source || sourceId || 'Unknown session'
    } else if (message.sessionSource) {
      sourceId = message.sessionSource.id
      kind = 'session'
      label = sessionMessageTitle(message.sessionSource)
      source = (sourceId && names.get(sourceId)) || message.sessionSource.name || sourceId || 'Unknown session'
    } else {
      kind = 'user'
      label = 'User message'
      source = message.senderName || 'User'
    }
    const text = message.content.replace(/\s+/g, ' ').trim()
    return [{ index, preview: text || (kind === 'event' ? label : 'Attachment'), timestamp: message.timestamp, kind, label, source, sourceId,
      groupable: kind === 'session' && ['progress', 'acknowledgement'].includes(message.sessionSource?.intent ?? ''),
    }]
  })
  for (const [index, decision] of decisions) {
    markers.push({
      index, kind: 'decision', label: decisionStatusLabel(decision.status), source: 'Decision',
      status: decision.status, timestamp: decision.timestamp,
      preview: [decision.question, decision.answer ? `Response: ${decision.answer.option}` : ''].filter(Boolean).join('\n'),
    })
  }
  return markers.sort((a, b) => a.index - b.index)
}

/** Compress routine peer updates, never human turns, decisions, requests or completion events. */
export function groupMessageHistoryMarkers(
  markers: readonly MessageHistoryMarker[], messages: readonly HistoryMessage[],
): MessageHistoryMarker[] {
  const grouped: MessageHistoryMarker[] = []
  for (const marker of markers) {
    const previous = grouped.at(-1)
    const last = previous?.members?.at(-1) ?? previous
    const separated = last && messages.slice(last.index + 1, marker.index)
      .some(message => message.isSummary || message.role === 'command' || message.isSystemEvent)
    if (!marker.groupable || !previous?.groupable || separated) {
      grouped.push(marker)
      continue
    }
    const members = [...(previous.members ?? [previous]), marker]
    const sources = new Set(members.map(member => member.sourceId || member.source))
    grouped[grouped.length - 1] = {
      index: previous.index, kind: 'collaboration', label: 'Internal collaboration', groupable: true,
      source: `${members.length} messages · ${sources.size} ${sources.size === 1 ? 'session' : 'sessions'}`,
      preview: marker.preview, timestamp: marker.timestamp, members,
    }
  }
  return grouped
}

export function formatMessageTime(timestamp?: string, now = new Date(), locale?: string): string {
  if (typeof timestamp !== 'string' || !timestamp) return 'Time unavailable'
  const date = new Date(timestamp)
  if (!Number.isFinite(date.getTime())) return 'Time unavailable'
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  const day = date.toDateString() === now.toDateString() ? 'Today'
    : date.toDateString() === yesterday.toDateString() ? 'Yesterday'
    : new Intl.DateTimeFormat(locale, {
      month: 'short', day: 'numeric',
      ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
    }).format(date)
  const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date)
  return `${day}, ${time}`
}
