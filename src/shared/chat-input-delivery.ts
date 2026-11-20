export interface ChatInputDelivery {
  requestId: string
  status: 'sending' | 'queue' | 'steer' | 'failed'
  content: string
  timestamp: string
  media?: string[]
}

// Only the separate host-authored sender part may carry a web request ID.
export function webInputRequestId(content: unknown): string | undefined {
  if (!Array.isArray(content) || content[0]?.type !== 'text') return
  const text = content[0].text
  if (typeof text !== 'string' || !/^<sender [^>]+ \/>$/.test(text)) return
  return / web-request-id="([a-f0-9-]{36})"/.exec(text)?.[1]
}

export function isChatInputDelivery(value: unknown): value is ChatInputDelivery {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return typeof item.requestId === 'string' && typeof item.content === 'string'
    && typeof item.timestamp === 'string'
    && (item.status === 'sending' || item.status === 'queue' || item.status === 'steer' || item.status === 'failed')
    && (item.media === undefined || Array.isArray(item.media) && item.media.every(path => typeof path === 'string'))
}
