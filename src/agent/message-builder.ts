import { isAbsolute } from 'node:path'
import type { ChannelMessageMetadata } from '../bus/events.ts'
import { inputSender, type EventInputSource, type SessionMessageInput } from '../sessions/input.ts'
import type { ChatMessage, ContentPart } from '../providers/provider.ts'
import { resolveAgentPath } from '../utils/paths.ts'
import { imageFromDataUrl, isImagePath, readImage } from '../utils/image-input.ts'

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
//  XML envelope builders
// ---------------------------------------------------------------------------

/** Escape XML special characters in attribute values. */
function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function platformAttributes(metadata: ChannelMessageMetadata | undefined): string {
  if (!metadata) return ''
  const attributes: Array<[string, string | number | boolean | undefined]> = [
    ['message-type', metadata.messageType],
    ['source', metadata.source],
    ['bot', metadata.author?.bot],
    ['role', metadata.author?.role],
  ]
  if (metadata.mentions?.length) {
    attributes.push(['mentions', metadata.mentions.map(mention => [
      mention.name ? `@${mention.name}` : undefined,
      mention.id ? `id=${mention.id}` : undefined,
      mention.isSelf === true ? 'self' : undefined,
      mention.bot === true ? 'bot' : undefined,
      mention.role ? `role=${mention.role}` : undefined,
    ].filter(Boolean).join(' ')).join('; ')])
  }
  if (metadata.attachments?.length) {
    attributes.push(['attachments', metadata.attachments.map(attachment => [
      attachment.path,
      attachment.contentType ? `type=${attachment.contentType}` : undefined,
      ...(['size', 'width', 'height'] as const).flatMap(key =>
        attachment[key] === undefined ? [] : [`${key}=${attachment[key]}`]),
    ].filter(Boolean).join(' ')).join('; ')])
  }
  return attributes.filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => ` platform-${key}="${escapeAttr(String(value))}"`).join('')
}

/**
 * Build a self-closing `<sender>` XML tag identifying the message author.
 * Injected as a separate content part so the user's actual text is untouched.
 */
export function buildSenderTag(msg: SessionMessageInput): string {
  const sender = inputSender(msg)
  const origin = msg.source.kind === 'session'
    ? ' source="session"'
    : msg.source.kind === 'user'
    ? ` chat="${msg.source.sender.isGroup ? 'group' : 'direct'}"`
    : ''
  const coordination = msg.source.kind === 'session' ? msg.source.coordination : undefined
  const work = coordination
    ? ` intent="${escapeAttr(coordination.intent)}"` +
      (coordination.initiativeId ? ` initiative-id="${escapeAttr(coordination.initiativeId)}"` : '') +
      (coordination.itemId ? ` item-id="${escapeAttr(coordination.itemId)}"` : '')
    : ''
  const revisions = msg.source.kind === 'session' && msg.source.workStamps?.length
    ? ` work-revisions="${escapeAttr(JSON.stringify(msg.source.workStamps.map(({ key, revision }) => ({ key, revision }))))}"` : ''
  const platform = msg.source.kind === 'user' ? platformAttributes(msg.source.sender.displayMetadata) : ''
  return `<sender id="${escapeAttr(sender.id)}" name="${escapeAttr(sender.name)}"${origin}${work}${revisions}${platform} />`
}

/**
 * Build an `<event>` XML tag with type and metadata attributes.
 * Injected as a separate content part; the event payload (msg.content) follows
 * as its own part.
 */
function buildEventTag(source: EventInputSource): string {
  const attrs = [
    `type="${escapeAttr(source.type)}"`,
    `source="${escapeAttr(source.source)}"`,
    `event-id="${escapeAttr(source.eventId)}"`,
  ]
  if (source.senderId) attrs.push(`sender-id="${escapeAttr(source.senderId)}"`)
  if (source.senderName) attrs.push(`sender-name="${escapeAttr(source.senderName)}"`)
  if (source.origin) {
    attrs.push(`source-session-id="${escapeAttr(source.origin.sessionId)}"`)
    attrs.push(`input-id="${escapeAttr(source.origin.inputId)}"`)
  }
  const reserved = new Set([
    'type', 'source', 'event-id', 'sender-id', 'sender-name', 'source-session-id',
    'input-id', 'urgency', 'silent', 'retry', 'delivery', 'policy', 'admin',
    'coalesceKey', 'debounceMs',
  ])
  for (const [key, value] of Object.entries(source.attributes ?? {})) {
    if (value == null || key.startsWith('__') || reserved.has(key)) continue
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key)) continue
    attrs.push(`${key}="${escapeAttr(String(value))}"`)
  }

  return `<event ${attrs.join(' ')} />`
}

// ---------------------------------------------------------------------------
//  Public API
// ---------------------------------------------------------------------------

/**
 * Build a user-role `ChatMessage` from typed content, using a `ContentPart[]`
 * with a metadata XML tag as the first block so the LLM can distinguish
 * user messages from system events without modifying the actual content.
 *
 * Provenance chooses the label; neither sender names nor payload metadata grant
 * a different provider role or carry internal scheduling instructions.
 */
export async function buildUserChatMessage(
  msg: SessionMessageInput,
  workspace: string,
  cwd: string,
): Promise<ChatMessage> {
  const senderName = inputSender(msg).name
  const metaTag = msg.source.kind === 'event'
    ? buildEventTag(msg.source)
    : buildSenderTag(msg)

  // Always use ContentPart[] so the metadata tag and user text are separate.
  const parts: ContentPart[] = [
    { type: 'text', text: metaTag },
    { type: 'text', text: msg.content },
  ]

  if (msg.media && msg.media.length > 0) {
    const media = await buildMediaParts(msg.media, workspace, cwd)
    const sender = msg.source.kind === 'user' ? msg.source.sender : undefined
    parts.push(...media.map((part, index) => part.type === 'image_url' && sender?.channel === 'qq'
      ? { ...part, displayOnly: sender.displayMetadata?.attachments?.some(
        attachment => attachment.path === msg.media![index] && attachment.sticker === true,
      ) ?? false } : part))
  }

  return {
    role: 'user',
    content: parts,
    name: senderName,
  }
}

/**
 * Build `ContentPart[]` entries for media attachments.
 *
 * - HTTPS/HTTP URLs → passed through as `image_url` parts.
 * - `data:...` URIs → passed through directly.
 * - Local file paths → read and base64-encoded into a data URI.
 * - Non-image media items → appended as text annotations.
 */
export async function buildMediaParts(
  media: string[],
  workspace: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<ContentPart[]> {
  const parts: ContentPart[] = []

  for (const src of media) {
    signal?.throwIfAborted()
    if (!isImagePath(src)) {
      // Non-image: append as a text annotation instead of an image part
      parts.push({ type: 'text', text: `[file: ${src}]` })
      continue
    }

    if (
      src.startsWith('data:') || src.startsWith('http://') ||
      src.startsWith('https://')
    ) {
      parts.push(src.startsWith('data:') ? imageFromDataUrl(src)
        : { type: 'image_url', image_url: { url: src, detail: 'auto' } })
      continue
    }

    // Local file path – resolve relative paths against the session cwd
    const resolvedSrc = isAbsolute(src)
      ? src
      : resolveAgentPath(workspace, cwd, src)
    parts.push((await readImage(resolvedSrc, signal)).part)
  }

  return parts
}
