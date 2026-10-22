import WebSocket, { type RawData } from 'ws'
import { z } from 'zod'
import {
  IO_MAX_BUFFER_BYTES, IO_MAX_CHUNK_BYTES, IoError, ioOutputSchema, parseIoUi,
  type IoPacket, type IoRelayEffect, type IoSource,
} from './contracts.ts'

export const IO_EVENT_MAX_BYTES = 2 * IO_MAX_CHUNK_BYTES
export const IO_METADATA_MAX_BYTES = 16 * 1024
export const IO_CONNECT_MS = 5_000
export const IO_ACK_MS = 30_000
export const IO_PROCESSING_MS = 5 * 60_000

const mime = z.string().max(128).regex(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+(?:;[ a-zA-Z0-9=,._-]+)?$/)
const packetSchema = z.object({
  type: z.enum(['data', 'ui', 'start', 'end']),
  sourceId: z.string().max(64).optional(),
  mime: mime.optional(),
  base64: z.string().max(Math.ceil(IO_MAX_CHUNK_BYTES / 3) * 4).optional(),
  value: z.unknown().optional(),
  timestamp: z.number().finite().optional(),
  id: z.string().max(128).optional(),
}).strict()

export function decodeBase64(value: string): Buffer {
  if (value.length > Math.ceil(IO_MAX_CHUNK_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new IoError('invalid_base64', 'Use canonical base64 for media')
  }
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length > IO_MAX_CHUNK_BYTES) throw new IoError('chunk_too_large', 'Media exceeds 1 MiB', 413)
  if (bytes.toString('base64') !== value) throw new IoError('invalid_base64', 'Invalid base64 media')
  return bytes
}

export function parseIoPacket(value: unknown, sources: readonly IoSource[]): { event: IoPacket; bytes: number; encodedBytes: number } {
  const encodedBytes = Buffer.byteLength(JSON.stringify(value) ?? '')
  if (encodedBytes > IO_EVENT_MAX_BYTES) throw new IoError('event_too_large', 'Event exceeds 2 MiB', 413)
  const event = packetSchema.parse(value)
  if (event.sourceId && !sources.some(source => source.id === event.sourceId)) {
    throw new IoError('invalid_source', 'Unknown capture source')
  }
  if (event.type === 'data' && (!event.sourceId || (event.base64 === undefined && event.value === undefined))) {
    throw new IoError('invalid_data', 'Data requires a source and base64 or value')
  }
  if ((event.type === 'start' || event.type === 'end') && (event.base64 !== undefined || event.value !== undefined)) {
    throw new IoError('invalid_event', 'Lifecycle events cannot carry source data')
  }
  if (event.base64 !== undefined && !event.mime) throw new IoError('invalid_mime', 'Media requires a MIME type')
  const valueBytes = event.value === undefined ? 0
    : Buffer.byteLength(typeof event.value === 'string' ? event.value : JSON.stringify(event.value))
  if (event.base64 !== undefined && event.value !== undefined &&
    (!event.value || typeof event.value !== 'object' || Array.isArray(event.value))) {
    throw new IoError('invalid_metadata', 'Binary input value must be a metadata object')
  }
  const valueLimit = event.base64 === undefined ? IO_MAX_CHUNK_BYTES : IO_METADATA_MAX_BYTES
  if (valueBytes > valueLimit) throw new IoError('chunk_too_large', 'Input value or media metadata exceeds its byte limit', 413)
  const bytes = valueBytes + (event.base64 !== undefined ? decodeBase64(event.base64).length : 0)
  return { event, bytes, encodedBytes }
}

const backendMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }).strict(),
  z.object({ type: z.literal('ack'), sequence: z.number().int().nonnegative().safe() }).strict(),
  z.object({ type: z.literal('ui'), nodes: z.unknown() }).strict(),
  z.object({ type: z.literal('preview'), mime, base64: z.string().optional(), text: z.string().optional() }).strict(),
  z.object({ type: z.literal('status'), text: z.string().max(4000) }).strict(),
  z.object({ type: z.literal('artifact'), path: z.string().min(1).max(4096), name: z.string().min(1).max(200).optional(), mime: mime.optional() }).strict(),
  z.object({ type: z.literal('done') }).strict(),
  z.object({ type: z.literal('error'), message: z.string().max(2000) }).strict(),
])

export interface IoRelayOptions {
  endpoint: string
  runId: string
  sources: IoSource[]
  onEffect(effect: IoRelayEffect): Promise<void>
  onDone(): Promise<void>
  onError(error: Error): void
  connectTimeoutMs?: number
  ackTimeoutMs?: number
}

/** A JSON bridge to an already-running, trusted local service; never executes code. */
export class IoRelay {
  private socket?: WebSocket
  private closed = false
  private ready = false
  private sequence = 0
  private queue = Promise.resolve()
  private queuedBytes = 0
  private queuedMessages = 0
  private rejectOpen?: (error: Error) => void
  private openTimer?: ReturnType<typeof setTimeout>
  private ack?: { sequence: number; resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }

  constructor(private readonly options: IoRelayOptions) {}

  connect(): Promise<void> {
    if (this.socket || this.closed) return Promise.reject(new Error('Backend connection has already been used'))
    return new Promise((resolve, reject) => {
      this.rejectOpen = reject
      this.openTimer = setTimeout(() => this.fail(new Error('Backend ready handshake timed out')), this.options.connectTimeoutMs ?? IO_CONNECT_MS)
      try {
        const socket = this.socket = new WebSocket(this.options.endpoint, {
          maxPayload: IO_EVENT_MAX_BYTES, perMessageDeflate: false, followRedirects: false,
          handshakeTimeout: this.options.connectTimeoutMs ?? IO_CONNECT_MS,
        })
        socket.on('open', () => {
          socket.send(JSON.stringify({ type: 'open', protocol: 'shadow.io.v1', runId: this.options.runId, sources: this.options.sources }),
            error => { if (error) this.fail(error) })
        })
        socket.on('message', (data, binary) => {
          if (this.closed) return
          try {
            if (binary) throw new Error('Backend must use JSON messages, not binary framing')
            const bytes = rawBuffer(data)
            const message = backendMessage.parse(JSON.parse(bytes.toString('utf8')))
            if (message.type === 'ready') {
              if (this.ready) throw new Error('Backend sent duplicate ready')
              this.ready = true
              clearTimeout(this.openTimer)
              this.rejectOpen = undefined
              resolve()
              return
            }
            if (!this.ready) throw new Error('Backend must send ready before other messages')
            if (message.type === 'ack') {
              if (this.ack?.sequence === message.sequence) {
                clearTimeout(this.ack.timer)
                this.ack.resolve()
                this.ack = undefined
              } else if (message.sequence > this.sequence) throw new Error('Backend acknowledged an unknown sequence')
              return
            }
            if (++this.queuedMessages > 256 || this.queuedBytes + bytes.length > IO_MAX_BUFFER_BYTES) {
              throw new Error('Backend effect buffer exceeded')
            }
            this.queuedBytes += bytes.length
            const work = this.queue.then(async () => {
              if (this.closed) return
              switch (message.type) {
                case 'ui':
                  await this.options.onEffect({ method: 'ui.render', args: [parseIoUi(message.nodes)] })
                  break
                case 'preview': {
                  const { type: _type, ...output } = message
                  const parsed = ioOutputSchema.parse(output)
                  if (parsed.base64 !== undefined) decodeBase64(parsed.base64)
                  if (parsed.text !== undefined && Buffer.byteLength(parsed.text) > IO_MAX_CHUNK_BYTES) throw new Error('Preview exceeds 1 MiB')
                  await this.options.onEffect({ method: 'preview', args: [parsed] })
                  break
                }
                case 'status': await this.options.onEffect({ method: 'status', args: [message.text] }); break
                case 'artifact': {
                  const { type: _type, ...artifact } = message
                  await this.options.onEffect({ method: 'artifact', args: [artifact] })
                  break
                }
                case 'done': await this.options.onDone(); break
                case 'error': throw new Error(message.message || 'Backend reported an error')
              }
            })
            this.queue = work.catch(error => this.fail(asError(error))).finally(() => {
              this.queuedMessages--
              this.queuedBytes -= bytes.length
            })
          } catch (error) { this.fail(asError(error)) }
        })
        socket.on('error', error => this.fail(error))
        socket.on('close', () => {
          // Drain already-received artifact/done messages before interpreting a normal peer close.
          void this.queue.then(() => { if (!this.closed) this.fail(new Error('Backend disconnected before completion')) })
        })
      } catch (error) { this.fail(asError(error)) }
    })
  }

  send(event: IoPacket): Promise<void> {
    if (!this.ready || this.closed || this.socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Backend is not connected'))
    if (this.ack) return Promise.reject(new Error('Wait for the previous backend acknowledgement'))
    const sequence = ++this.sequence
    const encoded = JSON.stringify({ type: 'event', sequence, event })
    if (Buffer.byteLength(encoded) + this.socket.bufferedAmount > IO_MAX_BUFFER_BYTES) return Promise.reject(new Error('Backend send buffer exceeded'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error('Backend event acknowledgement timed out')), this.options.ackTimeoutMs ?? IO_ACK_MS)
      this.ack = { sequence, resolve, reject, timer }
      this.socket!.send(encoded, error => { if (error) this.fail(error) })
    })
  }

  close(reason = new Error('Backend connection closed')): void {
    if (this.closed) return
    this.closed = true
    this.ready = false
    clearTimeout(this.openTimer)
    this.rejectOpen?.(reason)
    this.rejectOpen = undefined
    if (this.ack) {
      clearTimeout(this.ack.timer)
      this.ack.reject(reason)
      this.ack = undefined
    }
    this.socket?.terminate()
  }

  private fail(error: Error): void {
    if (this.closed) return
    this.close(error)
    this.options.onError(error)
  }
}

function rawBuffer(data: RawData): Buffer {
  return Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)
}

function asError(error: unknown): Error { return error instanceof Error ? error : new Error(String(error)) }
