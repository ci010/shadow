import { t } from './i18n.ts'
import { messageEnvelope, parseSessionMessage } from './message-author.ts'

export interface ChatEventMeta {
  type: string
  source: string
  attrs: Record<string, string>
}

export function parseLiveSessionMessage(message: unknown) {
  const event = parseChatEvent(message)
  if (event) return { role: 'user', isSystemEvent: true, ...event }
  const session = parseSessionMessage(message)
  if (session) return { role: 'user', ...session }
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
  const label = meta.attrs.mode === 'task' ? t('Task') : meta.attrs.mode === 'call' ? t('Call') : t('Agent')
  return {
    completion,
    failed: completion && status === 'failed',
    title: completion
      ? t(status === 'failed' ? '{label} failed' : status === 'cancelled' ? '{label} cancelled' : '{label} completed', { label })
      : meta.attrs.title || meta.type.replace(/[-_]/g, ' '),
  }
}
