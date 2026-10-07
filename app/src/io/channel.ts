import { t } from '../i18n.ts'
import { apiUrl } from '../api-url.ts'
import { IO_MAX_BUFFER_BYTES, IO_MAX_CHUNK_BYTES, type IoPacket } from '../../../src/io/contracts.ts'

export interface IoCredentials { clientId: string; clientToken: string; leaseToken: string }
export class IoEventQueue {
  queuedBytes = 0
  private count = 0
  private tail = Promise.resolve()
  private abort = new AbortController()
  private failure?: Error
  constructor(private readonly base: string, private readonly runId: string, private readonly credentials: IoCredentials, private readonly request: typeof fetch = fetch) {}

  send(event: IoPacket): Promise<void> {
    if (this.abort.signal.aborted || this.failure) return Promise.reject(this.failure ?? new Error(t('I/O input is closed.')))
    const valueBytes = event.value === undefined ? 0 : new TextEncoder().encode(typeof event.value === 'string' ? event.value : JSON.stringify(event.value)).byteLength
    if (event.base64 !== undefined) {
      const value = event.base64
      const rawBytes = value.length / 4 * 3 - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0)
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value) || rawBytes > IO_MAX_CHUNK_BYTES) return Promise.reject(new Error(t('Input exceeds the 1 MiB raw payload limit or has invalid base64.')))
    }
    if (valueBytes > IO_MAX_CHUNK_BYTES) return Promise.reject(new Error(t('Input exceeds the 1 MiB value limit.')))
    const body = JSON.stringify({ ...this.credentials, event })
    const bytes = new TextEncoder().encode(body).byteLength
    // The other half of the shared input buffer is reserved for native capture blobs.
    if (bytes > 2 * 1024 * 1024 || this.queuedBytes + bytes > IO_MAX_BUFFER_BYTES / 2 || this.count >= 256) return Promise.reject(new Error(t('The backend cannot keep up with input. The bounded I/O queue is full.')))
    this.queuedBytes += bytes
    this.count++
    const pending = this.tail.then(async () => {
      if (this.abort.signal.aborted) throw new Error(t('I/O input is closed.'))
      const response = await this.request.call(globalThis, apiUrl(this.base, `/api/io/runs/${encodeURIComponent(this.runId)}/events`), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
        signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(35_000)]),
      })
      if (!response.ok) throw new Error(t('Backend did not accept input ({status}). Check the service and open a new I/O session.', { status: response.status }))
      const result = await response.json()
      if (result.accepted !== true) throw new Error(t('Backend did not acknowledge the input.'))
    }).catch(error => {
      this.failure = error instanceof Error ? error : new Error(t('Input transport failed.'))
      throw this.failure
    }).finally(() => { this.queuedBytes -= bytes; this.count-- })
    this.tail = pending
    void pending.catch(() => {})
    return pending
  }
  async drain() { await this.tail }
  close() { this.abort.abort() }
}
