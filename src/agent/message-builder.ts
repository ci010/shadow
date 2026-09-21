import { isAbsolute } from 'node:path'
import { readFile } from 'node:fs/promises'
import { inputSender, type EventInputSource, type SessionMessageInput } from '../sessions/input.ts'
import type { ChatMessage, ContentPart } from '../providers/provider.ts'
import { resolveAgentPath } from '../utils/paths.ts'

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

const IMAGE_EXTENSIONS = new Set([
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'bmp',
  'tiff',
  'tif',
  'svg',
  'avif',
  'heic',
  'heif',
])

function isImagePath(src: string): boolean {
  try {
    const pathname = src.startsWith('data:') ? '' : new URL(src).pathname
    const ext = pathname.split('.').pop()?.toLowerCase() ?? ''
    return IMAGE_EXTENSIONS.has(ext) || src.startsWith('data:image/')
  } catch {
    // local file path
    const ext = src.split('.').pop()?.toLowerCase() ?? ''
    return IMAGE_EXTENSIONS.has(ext)
  }
}

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
  return `<sender id="${escapeAttr(sender.id)}" name="${escapeAttr(sender.name)}"${origin}${work}${revisions} />`
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
    parts.push(...await buildMediaParts(msg.media, workspace, cwd))
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
async function buildMediaParts(
  media: string[],
  workspace: string,
  cwd: string,
): Promise<ContentPart[]> {
  const parts: ContentPart[] = []

  for (const src of media) {
    if (!isImagePath(src)) {
      // Non-image: append as a text annotation instead of an image part
      parts.push({ type: 'text', text: `[file: ${src}]` })
      continue
    }

    if (
      src.startsWith('data:') || src.startsWith('http://') ||
      src.startsWith('https://')
    ) {
      parts.push({ type: 'image_url', image_url: { url: src, detail: 'auto' } })
      continue
    }

    // Local file path – resolve relative paths against the session cwd
    const resolvedSrc = isAbsolute(src)
      ? src
      : resolveAgentPath(workspace, cwd, src)
    try {
      const bytes = await readFile(resolvedSrc)
      const ext = resolvedSrc.split('.').pop()?.toLowerCase() ?? 'jpeg'
      const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`
      const b64 = btoa(String.fromCharCode(...bytes))
      parts.push({
        type: 'image_url',
        image_url: { url: `data:${mime};base64,${b64}`, detail: 'auto' },
      })
    } catch (e) {
      console.warn(`[agent] Could not read media file ${resolvedSrc}:`, e)
      parts.push({ type: 'text', text: `[file: ${src}]` })
    }
  }

  return parts
}
