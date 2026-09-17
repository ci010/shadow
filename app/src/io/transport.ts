import { apiUrl } from '../api-url.ts'
import { IO_MAX_CHUNK_BYTES, ioOutputSchema, type IoOutput } from '../../../src/io/contracts.ts'

export class IoBudget {
  bytes = 0
  constructor(readonly maxBytes: number) {}
  consume(bytes: number) {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || this.bytes + bytes > this.maxBytes) throw new Error('The confirmed data budget has been reached.')
    this.bytes += bytes
  }
}

export function decodeOutput(value: unknown): { mime: string; bytes: Uint8Array } {
  const output: IoOutput = ioOutputSchema.parse(value)
  let bytes: Uint8Array
  if (output.text !== undefined) bytes = new TextEncoder().encode(output.text)
  else {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(output.base64!)) throw new Error('Invalid base64 output')
    const decoded = atob(output.base64!)
    if (btoa(decoded) !== output.base64) throw new Error('Invalid canonical base64 output')
    bytes = Uint8Array.from(decoded, char => char.charCodeAt(0))
  }
  if (bytes.byteLength > IO_MAX_CHUNK_BYTES) throw new Error('Output exceeds the 1 MiB chunk limit.')
  return { mime: output.mime, bytes }
}

export function encodeBytes(bytes: Uint8Array): string {
  let text = ''
  for (let offset = 0; offset < bytes.length; offset += 16_384) text += String.fromCharCode(...bytes.subarray(offset, offset + 16_384))
  return btoa(text)
}

export async function ioRequest<T>(base: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(apiUrl(base, `/api/io${path}`), {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(10_000),
  })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(typeof data.message === 'string' ? data.message : typeof data.error === 'string' ? data.error : `I/O request failed (${response.status})`)
  }
  return response.json() as Promise<T>
}

export class ResourceScope {
  closed = false
  private resources: Array<() => void> = []
  add(cleanup: () => void) {
    if (this.closed) cleanup()
    else this.resources.push(cleanup)
  }
  close() {
    if (this.closed) return
    this.closed = true
    for (const cleanup of this.resources.reverse()) {
      try { cleanup() } catch { /* Continue releasing other independently owned devices. */ }
    }
    this.resources = []
  }
}
