import { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { constants, createGzip } from 'node:zlib'
import type { ProviderRequestStats } from './provider.ts'
import { imagePartSizeMetadata } from '../utils/image-size-metadata.ts'
import { spanAttributes } from '../otel/tracing.ts'

/** Avoid compression overhead on small prompts. This is a byte threshold, not a token budget. */
export const REQUEST_GZIP_MIN_BYTES = 16 * 1024

export interface PreparedRequestBody {
  stats: ProviderRequestStats
  body: string | Buffer<ArrayBuffer>
  headers: Record<string, string>
}

/** Transport-only encoding: serialize exactly once; never rewrite model-visible input.
 * Opt-in belongs to the provider, not a model name or an arbitrary compatible endpoint.
 * Prepare once outside retry loops so retries reuse the exact same bytes.
 */
export async function prepareRequestBody(
  value: unknown, compression?: 'gzip', signal?: AbortSignal,
): Promise<PreparedRequestBody> {
  signal?.throwIfAborted()
  const json = JSON.stringify(value)
  const jsonBytes = Buffer.byteLength(json, 'utf8')
  let body: string | Buffer<ArrayBuffer> = json
  let encoding: 'gzip' | 'identity' = 'identity'
  if (compression === 'gzip' && jsonBytes >= REQUEST_GZIP_MIN_BYTES) {
    const chunks: Buffer[] = []
    // Streaming zlib uses the worker pool; pipeline destroys all streams on abort.
    // A fast compression level limits CPU cost for large image-bearing requests.
    await pipeline(
      Readable.from([json]),
      createGzip({ level: constants.Z_BEST_SPEED }),
      new Writable({ write(chunk: Buffer, _encoding, callback) { chunks.push(chunk); callback() } }),
      { signal },
    ).catch(error => { signal?.throwIfAborted(); throw error })
    signal?.throwIfAborted()
    const compressed = Buffer.concat(chunks)
    if (compressed.length < jsonBytes) {
      body = compressed
      encoding = 'gzip'
    }
  }
  signal?.throwIfAborted()
  // Only protocol content arrays, never arbitrary tool arguments or text.
  const serialized = JSON.parse(json) as Record<string, unknown> | null
  let imageCount = 0
  let imageBase64Bytes = 0
  const content = (parts: unknown) => {
    if (!Array.isArray(parts)) return
    for (const part of parts) {
      if (!part || typeof part !== 'object') continue
      if (part.type === 'image_url' || part.type === 'input_image' || part.type === 'image') {
        imageCount++
        imageBase64Bytes += imagePartSizeMetadata(part)?.base64Bytes ?? 0
      } else if (part.type === 'tool_result') content(part.content)
    }
  }
  if (serialized && typeof serialized === 'object') {
    for (const key of ['messages', 'input']) {
      const messages = serialized[key]
      if (Array.isArray(messages)) for (const message of messages) {
        if (message && typeof message === 'object' && typeof message.role === 'string') content(message.content)
      }
    }
  }
  const stats: ProviderRequestStats = { bodyBytes: jsonBytes,
    wireBodyBytes: typeof body === 'string' ? jsonBytes : body.length,
    contentEncoding: encoding, imageCount, imageBase64Bytes }
  spanAttributes({
    // Preserve this attribute's original meaning: uncompressed serialized JSON.
    'llm.request.body_bytes': jsonBytes,
    'llm.request.image_count': imageCount,
    'llm.request.image_base64_bytes': imageBase64Bytes,
    'llm.request.wire_body_bytes': typeof body === 'string' ? jsonBytes : body.length,
    'llm.request.content_encoding': encoding,
  })
  return { stats, body, headers: encoding === 'gzip' ? { 'content-encoding': 'gzip' } : {} }
}
