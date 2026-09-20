import { sessionMessageTitle, type SessionMessageSource } from './message-author.ts'
import { eventPresentation, eventSourceSession, type ChatEventMeta } from './chat-events.ts'

export interface HistoryMessage {
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
  kind: 'user' | 'session' | 'event'
  label: string
  source: string
  sourceId?: string
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
): MessageHistoryMarker[] {
  const names = new Map(sessions.map(session => [session.sessionId, session.label]))
  return messages.flatMap((message, index) => {
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
    return [{ index, preview: text || (kind === 'event' ? label : 'Attachment'), timestamp: message.timestamp, kind, label, source, sourceId }]
  })
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
