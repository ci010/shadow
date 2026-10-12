import { Worker } from 'node:worker_threads'

export const MIN_OPTIMIZE_IMAGE_BYTES = 256 * 1024
export const IMAGE_OPTIMIZATION_TIMEOUT_MS = 10_000
let active = false

/** Best-effort model-copy optimization; never mutate the attachment or block the event loop. */
export async function optimizePngForModel(
  bytes: Uint8Array, width: number, height: number, signal?: AbortSignal,
): Promise<Uint8Array | undefined> {
  signal?.throwIfAborted()
  if (bytes.length < MIN_OPTIMIZE_IMAGE_BYTES || active) return
  // Don't reduce high-bit-depth images, flatten APNG, or discard color/orientation metadata.
  if (bytes[24] !== 8 || hasUnsupportedChunks(bytes)) return
  active = true
  try {
    return await new Promise<Uint8Array | undefined>((resolve, reject) => {
      let worker: Worker
      try {
        worker = new Worker(new URL('./image-codec-worker.js', import.meta.url), {
          execArgv: [],
          workerData: { bytes: Uint8Array.from(bytes), width, height },
          resourceLimits: { maxOldGenerationSizeMb: 128 },
        })
      } catch { resolve(undefined); return }
      let settled = false
      const finish = (result?: Uint8Array, aborted = false) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        // Hold the single-worker slot until termination completes, including timeout.
        void worker.terminate().then(() => {
          if (aborted) reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
          else resolve(result)
        }, () => aborted ? reject(signal?.reason) : resolve(undefined))
      }
      const onAbort = () => finish(undefined, true)
      const timer = setTimeout(() => finish(), IMAGE_OPTIMIZATION_TIMEOUT_MS)
      signal?.addEventListener('abort', onAbort, { once: true })
      worker.once('message', (result: unknown) => {
        finish(result instanceof Uint8Array && result.length < bytes.length ? result : undefined)
      })
      worker.once('error', () => finish())
      worker.once('exit', () => finish())
      if (signal?.aborted) onAbort()
    })
  } finally { active = false }
}

function hasUnsupportedChunks(bytes: Uint8Array): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const size = view.getUint32(offset)
    if (size > bytes.length - offset - 12) return true // malformed: don't decode
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8))
    if (['acTL', 'iCCP', 'eXIf', 'cHRM'].includes(type)) return true
    if (type === 'gAMA' && (size !== 4 || view.getUint32(offset + 8) !== 45455)) return true
    offset += size + 12
  }
  return false
}
