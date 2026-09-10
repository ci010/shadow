import { isAbsolute } from 'node:path'
import { readFile } from 'node:fs/promises'
import type { InboundMessage } from '../bus/events.ts'
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

/** Prefix convention: senderIds starting with 'event:' are system events. */
const EVENT_PREFIX = 'event:'

/**
 * Build a self-closing `<sender>` XML tag identifying the message author.
 * Injected as a separate content part so the user's actual text is untouched.
 */
function buildSenderTag(msg: InboundMessage): string {
  const id = escapeAttr(msg.senderId)
  const name = escapeAttr(msg.senderName ?? msg.senderId)
  return `<sender id="${id}" name="${name}" />`
}

/**
 * Build an `<event>` XML tag with type and metadata attributes.
 * The event type is extracted from the `event:` prefix in senderId.
 * Injected as a separate content part; the event payload (msg.content) follows
 * as its own part.
 */
function buildEventTag(msg: InboundMessage): string {
  const type = escapeAttr(msg.senderId.slice(EVENT_PREFIX.length))
  const attrs = [`type="${type}"`]

  if (msg.eventMeta) {
    for (const [key, value] of Object.entries(msg.eventMeta)) {
      if (value == null) continue
      // Internal routing keys (e.g. __eventDispatch) are not for the model.
      if (key.startsWith('__')) continue
      attrs.push(`${key}="${escapeAttr(String(value))}"`)
    }
  }

  return `<event ${attrs.join(' ')} />`
}

// ---------------------------------------------------------------------------
//  Public API
// ---------------------------------------------------------------------------

/**
 * Build a `ChatMessage` from an `InboundMessage`, using a `ContentPart[]`
 * with a metadata XML tag as the first block so the LLM can distinguish
 * user messages from system events without modifying the actual content.
 *
 * - Messages with `senderId` starting with `event:` → `<event type="..." ... />` + content
 * - All other messages → `<sender id="..." name="..." />` + content
 */
export async function buildUserChatMessage(
  msg: InboundMessage,
  workspace: string,
  cwd: string,
): Promise<ChatMessage> {
  const senderName = msg.senderName ?? msg.senderId
  const isEvent = msg.senderId.startsWith(EVENT_PREFIX)
  const metaTag = isEvent ? buildEventTag(msg) : buildSenderTag(msg)

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
