import { isRecord } from './projects-sidebar.ts'

export interface ChatEventMeta {
  type: string
  source: string
  attrs: Record<string, string>
}

function decodeAttribute(value: string): string {
  return value.replace(/&(quot|apos|lt|gt|amp);/g, (_match, name: string) =>
    ({ quot: '"', apos: "'", lt: '<', gt: '>', amp: '&' })[name]!)
}

export function parseChatEvent(message: unknown): { content: string; eventMeta: ChatEventMeta; timestamp?: string } | undefined {
  if (!isRecord(message) || message.role !== 'user') return
  if (typeof message.content !== 'string' && (!Array.isArray(message.content)
    || !message.content.every(part => isRecord(part) && typeof part.type === 'string'
      && (part.type !== 'text' || typeof part.text === 'string')))) return
  const first = typeof message.content === 'string' ? message.content
    : message.content?.[0]?.type === 'text' ? message.content[0].text : undefined
  if (typeof first !== 'string') return
  const tag = first?.match(/^<event\s([^>]*)\/>\s*/)
  if (!tag) return
  const attrs: Record<string, string> = {}
  for (const match of tag[1].matchAll(/([\w.-]+)="([^"]*)"/g)) attrs[match[1]] = decodeAttribute(match[2])
  const content = typeof message.content === 'string' ? message.content.slice(tag[0].length)
    : [first!.slice(tag[0].length), ...(message.content ?? []).slice(1).flatMap(part => part.type === 'text' ? [part.text ?? ''] : [])].join('')
  return { content, timestamp: typeof message.timestamp === 'string' ? message.timestamp : undefined, eventMeta: {
    type: attrs.type || 'event', source: attrs.source || (typeof message.name === 'string' ? message.name : '') || attrs.kind || 'system', attrs,
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
