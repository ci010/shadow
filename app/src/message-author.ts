interface AuthorMessage {
  role: string
  name?: string
  content: string | ReadonlyArray<{ type: string; text?: string }> | null
}

function decodeAttribute(value: string): string {
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
  return value.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => entities[name])
}

function sender(message: AuthorMessage) {
  if (message.role !== 'user' || message.name === '__compaction_summary__') return undefined
  const first = typeof message.content === 'string' ? message.content
    : message.content?.[0]?.type === 'text' ? message.content[0].text ?? '' : ''
  if (/^<event\s/.test(first)) return undefined
  const tag = first.match(/^<sender\s([^>]*)\/>/)
  const attrs = new Map<string, string>()
  for (const match of tag?.[1].matchAll(/([\w-]+)="([^"]*)"/g) ?? []) {
    attrs.set(match[1], decodeAttribute(match[2]))
  }
  if (attrs.get('source') === 'session') return undefined
  const id = attrs.get('id')?.trim()
  const name = (typeof message.name === 'string' ? message.name.trim() : '')
    || attrs.get('name')?.trim() || id || 'Unknown sender'
  return { id, name, chat: attrs.get('chat') }
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
