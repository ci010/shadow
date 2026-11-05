import { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { constants, createGzip } from 'node:zlib'
import { spanAttributes } from '../otel/tracing.ts'

/** Avoid compression overhead on small prompts. This is a byte threshold, not a token budget. */
export const REQUEST_GZIP_MIN_BYTES = 16 * 1024

export interface PreparedRequestBody {
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
  let encoding = 'identity'
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
  spanAttributes({
    // Preserve this attribute's original meaning: uncompressed serialized JSON.
    'llm.request.body_bytes': jsonBytes,
    'llm.request.wire_body_bytes': typeof body === 'string' ? jsonBytes : body.length,
    'llm.request.content_encoding': encoding,
  })
  return { body, headers: encoding === 'gzip' ? { 'content-encoding': 'gzip' } : {} }
}
