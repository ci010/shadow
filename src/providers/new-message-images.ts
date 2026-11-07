import type { ChatMessage, ContentPart, ImageContentPart } from './provider.ts'
import { imageFromBytes, imageFromDataUrlForModel, MAX_IMAGE_BYTES } from '../utils/image-input.ts'

const REMOTE_IMAGE_TIMEOUT_MS = 15_000

/** Snapshot a new URL once. Do not fetch mutable URLs again while replaying history. */
async function snapshotImage(url: string, signal?: AbortSignal): Promise<string> {
  const parsed = new URL(url)
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('New image URLs must use HTTP(S) without embedded credentials.')
  }
  const timeout = AbortSignal.timeout(REMOTE_IMAGE_TIMEOUT_MS)
  const response = await fetch(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`Could not snapshot new image (HTTP ${response.status}).`)
  }
  if (!response.body) throw new Error('New image response has no content.')
  const reader = response.body.getReader()
  try {
    const length = response.headers.get('content-length')
    if (length && Number(length) > MAX_IMAGE_BYTES) throw new Error('New image exceeds 5 MiB.')
    const chunks: Uint8Array[] = []
    let total = 0
    while (true) {
      signal?.throwIfAborted()
      const { value, done } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_IMAGE_BYTES) throw new Error('New image exceeds 5 MiB.')
      chunks.push(value)
    }
    const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
    return imageFromBytes(Buffer.concat(chunks, total), mime?.startsWith('image/') ? mime : undefined).part.image_url.url
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

/** Prepare only newly admitted content, BEFORE adding it to durable history.
 * Never call this on loaded/replayed history: that would rewrite cache prefixes.
 * The chosen URL (optimized or original fallback) is persisted as the model copy.
 * No process-local memo cache or wire-only marker is needed for restart stability.
 */
export async function prepareNewMessageImages(messages: ChatMessage[], signal?: AbortSignal): Promise<ChatMessage[]> {
  const prepared: ChatMessage[] = []
  for (const message of messages) {
    signal?.throwIfAborted()
    if (!Array.isArray(message.content)) { prepared.push(message); continue }
    const content: ContentPart[] = []
    for (const part of message.content) {
      signal?.throwIfAborted()
      if (part.type !== 'image_url' || part.displayOnly === true) { content.push(part); continue }
      let url = part.image_url.url
      if (/^https?:\/\//i.test(url)) url = await snapshotImage(url, signal)
      // Validation, eligibility, conversion and safe fallback are shared for all sources.
      const image = await imageFromDataUrlForModel(url, signal)
      content.push({ ...part, image_url: { ...part.image_url, url: image.image_url.url } } satisfies ImageContentPart)
    }
    prepared.push({ ...message, content })
  }
  return prepared
}
