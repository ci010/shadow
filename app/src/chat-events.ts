import { messageEnvelope } from './message-author.ts'

export interface ChatEventMeta {
  type: string
  source: string
  attrs: Record<string, string>
}

export function parseChatEvent(message: unknown): { content: string; eventMeta: ChatEventMeta; timestamp?: string } | undefined {
  const envelope = messageEnvelope(message)
  if (envelope?.tag !== 'event') return
  const { attrs, content, timestamp, name } = envelope
  return { content, timestamp, eventMeta: {
    type: attrs.type || 'event', source: attrs.source || name || attrs.kind || 'system', attrs,
  } }
}

export function eventSourceSession(meta: ChatEventMeta): string | undefined {
  return meta.attrs['source-session-id'] || meta.attrs.sourceSessionId || meta.attrs.executionId || undefined
}

export function eventPresentation(meta: ChatEventMeta) {
  const completion = /^subagent-(?:complete|failed|cancelled)$/.test(meta.type)
  const status = meta.type === 'subagent-failed' ? 'failed'
    : meta.type === 'subagent-cancelled' ? 'cancelled' : 'completed'
  const label = meta.attrs.mode === 'task' ? 'Task' : meta.attrs.mode === 'call' ? 'Call' : 'Agent'
  return {
    completion,
    failed: completion && status === 'failed',
    title: completion ? `${label} ${status}` : meta.attrs.title || meta.type.replace(/[-_]/g, ' '),
  }
}
