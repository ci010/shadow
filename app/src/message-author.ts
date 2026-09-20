import { isRecord } from './folders-sidebar.ts'

interface AuthorMessage {
  role: string
  name?: string
  content: string | ReadonlyArray<{ type: string; text?: string }> | null
}

function decodeAttribute(value: string): string {
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
  return value.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => entities[name])
}

/** Display metadata only: an envelope never authorizes an action or changes a provider role. */
export function messageEnvelope(message: unknown) {
  if (!isRecord(message) || message.role !== 'user' || message.name === '__compaction_summary__') return
  if (typeof message.content !== 'string' && (!Array.isArray(message.content)
    || !message.content.every(part => isRecord(part) && typeof part.type === 'string'
      && (part.type !== 'text' || typeof part.text === 'string')))) return
  const first = typeof message.content === 'string' ? message.content
    : message.content[0]?.type === 'text' ? message.content[0].text : undefined
  if (typeof first !== 'string') return
  const tag = first.match(/^<(sender|event)\s([^>]*)\/>\s*/)
  if (!tag) return
  const attrs: Record<string, string> = Object.fromEntries([...tag[2].matchAll(/([\w.-]+)="([^"]*)"/g)]
    .map(match => [match[1], decodeAttribute(match[2])]))
  const content = typeof message.content === 'string' ? message.content.slice(tag[0].length)
    : [first.slice(tag[0].length), ...message.content.slice(1).flatMap(part => part.type === 'text' ? [part.text] : [])].join('')
  return {
    tag: tag[1], attrs, content,
    name: typeof message.name === 'string' ? message.name : undefined,
    timestamp: typeof message.timestamp === 'string' ? message.timestamp : undefined,
  }
}

export interface SessionMessageSource {
  id?: string
  name?: string
  intent?: string
}

export function parseSessionMessage(message: unknown) {
  const envelope = messageEnvelope(message)
  if (envelope?.tag !== 'sender' || envelope.attrs.source !== 'session') return
  const sessionSource: SessionMessageSource = {
    id: envelope.attrs.id?.trim() || undefined,
    name: envelope.attrs.name?.trim() || envelope.name?.trim() || undefined,
    intent: envelope.attrs.intent?.trim() || undefined,
  }
  return { content: envelope.content, timestamp: envelope.timestamp, sessionSource }
}

export function sessionMessageTitle(source: SessionMessageSource): string {
  const labels: Record<string, string> = {
    request: 'Session request', question: 'Session question', progress: 'Session progress',
    handoff: 'Session handoff', acknowledgement: 'Session acknowledgement',
  }
  return source.intent && Object.hasOwn(labels, source.intent) ? labels[source.intent] : 'Session message'
}

export function messageRoleLabel(message: unknown): string {
  const session = parseSessionMessage(message)
  if (session) return sessionMessageTitle(session.sessionSource)
  if (messageEnvelope(message)?.tag === 'event') return 'System event'
  if (isRecord(message) && message.role === 'user' && message.name === '__compaction_summary__') return 'Context summary'
  return isRecord(message) && typeof message.role === 'string' ? message.role : 'Unknown role'
}

function sender(message: AuthorMessage) {
  if (message.role !== 'user' || message.name === '__compaction_summary__') return undefined
  const first = typeof message.content === 'string' ? message.content
    : message.content?.[0]?.type === 'text' ? message.content[0].text ?? '' : ''
  if (/^<event\s/.test(first)) return undefined
  const attrs = messageEnvelope(message)?.attrs ?? {}
  if (attrs.source === 'session') return undefined
  const id = attrs.id?.trim()
  const name = (typeof message.name === 'string' ? message.name.trim() : '')
    || attrs.name?.trim() || id || 'Unknown sender'
  return { id, name, chat: attrs.chat }
}

/** Names are presentation metadata, never identity or authorization evidence. */
export function groupSenderNames(history: readonly AuthorMessage[], directChat = false): Array<string | undefined> {
  if (directChat) return history.map(() => undefined)
  const senders = history.map(sender)
  const legacyIds = new Set(senders.flatMap(author => author?.id && author.chat === undefined ? [author.id] : []))
  // Older envelopes have no chat type. Only multiple recorded sender IDs establish a multi-person history.
  const groupHistory = senders.some(author => author?.chat === 'group') || legacyIds.size > 1
  return senders.map(author => author && author.chat !== 'direct' && groupHistory ? author.name : undefined)
}
