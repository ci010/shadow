export interface HistoryMessage {
  role: string
  content: string
  timestamp?: string
  event?: string
  isSystemEvent?: boolean
  isSummary?: boolean
}

export interface UserMessageMarker {
  index: number
  preview: string
  timestamp?: string
}

export function isUserMessage(message: HistoryMessage): boolean {
  return message.role === 'user' && !message.isSystemEvent && !message.isSummary && !message.event
}

export function resendableUserMessage<T extends HistoryMessage>(messages: readonly T[]): T | undefined {
  const last = messages.at(-1)
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

export function userMessageMarkers(messages: readonly HistoryMessage[]): UserMessageMarker[] {
  return messages.flatMap((message, index) => {
    if (!isUserMessage(message)) return []
    const text = message.content.replace(/\s+/g, ' ').trim()
    return [{ index, preview: text || 'Attachment', timestamp: message.timestamp }]
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
