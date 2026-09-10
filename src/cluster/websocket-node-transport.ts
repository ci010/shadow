import {
  validateNodeSessionInboundFrameV1,
  validateNodeSessionOutboundFrameV1,
} from './node-session-contracts.ts'
import type { DuplexCloseInfo, NodeMessageDuplex } from './node-transport.ts'

export const DEFAULT_NODE_WEBSOCKET_LIMITS = {
  maxInboundMessageBytes: 256 * 1024,
  maxOutboundMessageBytes: 256 * 1024,
  maxPendingSends: 32,
  maxBufferedAmountBytes: 1024 * 1024,
  bufferedAmountPollMs: 10,
  sendTimeoutMs: 10_000,
} as const

export interface NodeWebSocketTransportOptions {
  maxInboundMessageBytes?: number
  maxOutboundMessageBytes?: number
  maxPendingSends?: number
  maxBufferedAmountBytes?: number
  bufferedAmountPollMs?: number
  sendTimeoutMs?: number
  signal?: AbortSignal
}

export type NodeWebSocketFactory = (
  url: string | URL,
  protocols?: string | string[],
) => WebSocket

type FrameValidator = (value: unknown) =>
  | { success: true; value: unknown }
  | { success: false; errors: string[] }

interface InboxReader {
  resolve(result: IteratorResult<unknown>): void
  reject(error: unknown): void
}

class WebSocketInbox implements AsyncIterable<unknown>, AsyncIterator<unknown> {
  readonly #values: unknown[] = []
  readonly #readers: InboxReader[] = []
  #ended = false
  #error: unknown

  push(value: unknown): void {
    if (this.#ended) return
    const reader = this.#readers.shift()
    if (reader) reader.resolve({ done: false, value })
    else this.#values.push(value)
  }

  end(): void {
    if (this.#ended) return
    this.#ended = true
    for (const reader of this.#readers.splice(0)) {
      reader.resolve({ done: true, value: undefined })
    }
  }

  fail(error: unknown): void {
    if (this.#ended) return
    this.#ended = true
    this.#error = error
    for (const reader of this.#readers.splice(0)) reader.reject(error)
  }

  next(): Promise<IteratorResult<unknown>> {
    const value = this.#values.shift()
    if (value !== undefined) return Promise.resolve({ done: false, value })
    if (this.#error !== undefined) return Promise.reject(this.#error)
    if (this.#ended) return Promise.resolve({ done: true, value: undefined })
    return new Promise((resolve, reject) => {
      this.#readers.push({ resolve, reject })
    })
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return this
  }
}

const encoder = new TextEncoder()

const SYMBOLIC_CLOSE_CODES: Readonly<Record<string, number>> = {
  'peer-closed': 1000,
  'test-complete': 1000,
  revoked: 1000,
  'invalid-frame': 1002,
  'unexpected-message': 1002,
  'sequence-mismatch': 1002,
  'protocol-error': 1002,
  'malformed-json': 1007,
  'authentication-failed': 1008,
  'authorization-failed': 1008,
  'message-too-large': 1009,
  'heartbeat-timeout': 1001,
  'outbound-queue-full': 1013,
  'backpressure-timeout': 1013,
  'transport-failed': 1011,
  aborted: 1000,
}

const NUMERIC_CLOSE_CODES: Readonly<Record<number, string>> = {
  1000: 'peer-closed',
  1001: 'peer-going-away',
  1002: 'protocol-error',
  1003: 'unsupported-data',
  1006: 'transport-failed',
  1007: 'malformed-json',
  1008: 'authorization-failed',
  1009: 'message-too-large',
  1011: 'transport-failed',
  1013: 'backpressure-timeout',
}

export function websocketCloseCode(code: string): number {
  return SYMBOLIC_CLOSE_CODES[code] ?? 1011
}

export function symbolicCloseCode(code: number): string {
  return NUMERIC_CLOSE_CODES[code] ?? `websocket-${code}`
}

function closeReason(reason: string): string {
  if (encoder.encode(reason).byteLength <= 123) return reason
  let shortened = ''
  for (const character of reason) {
    if (encoder.encode(shortened + character).byteLength > 120) break
    shortened += character
  }
  return `${shortened}...`
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`)
  }
  return value
}

function socketState(socket: WebSocket, name: 'OPEN' | 'CLOSING' | 'CLOSED') {
  return (socket.constructor as typeof WebSocket)[name]
}

export class WebSocketNodeMessageDuplex implements NodeMessageDuplex {
  readonly #socket: WebSocket
  readonly #inboundValidator: FrameValidator
  readonly #outboundValidator: FrameValidator
  readonly #inbox = new WebSocketInbox()
  readonly #closedResolver = Promise.withResolvers<DuplexCloseInfo>()
  readonly #maxInboundMessageBytes: number
  readonly #maxOutboundMessageBytes: number
  readonly #maxPendingSends: number
  readonly #maxBufferedAmountBytes: number
  readonly #bufferedAmountPollMs: number
  readonly #sendTimeoutMs: number
  readonly #signal?: AbortSignal
  #pendingSends = 0
  #sendChain: Promise<void> = Promise.resolve()
  #closeInfo: DuplexCloseInfo | undefined
  #processingMessages: Promise<void> = Promise.resolve()

  readonly incoming: AsyncIterable<unknown> = this.#inbox
  readonly closed = this.#closedResolver.promise

  constructor(
    socket: WebSocket,
    inboundValidator: FrameValidator,
    outboundValidator: FrameValidator,
    options: NodeWebSocketTransportOptions = {},
  ) {
    this.#socket = socket
    this.#inboundValidator = inboundValidator
    this.#outboundValidator = outboundValidator
    this.#maxInboundMessageBytes = positiveInteger(
      options.maxInboundMessageBytes ??
        DEFAULT_NODE_WEBSOCKET_LIMITS.maxInboundMessageBytes,
      'maxInboundMessageBytes',
    )
    this.#maxOutboundMessageBytes = positiveInteger(
      options.maxOutboundMessageBytes ??
        DEFAULT_NODE_WEBSOCKET_LIMITS.maxOutboundMessageBytes,
      'maxOutboundMessageBytes',
    )
    this.#maxPendingSends = positiveInteger(
      options.maxPendingSends ?? DEFAULT_NODE_WEBSOCKET_LIMITS.maxPendingSends,
      'maxPendingSends',
    )
    this.#maxBufferedAmountBytes = positiveInteger(
      options.maxBufferedAmountBytes ??
        DEFAULT_NODE_WEBSOCKET_LIMITS.maxBufferedAmountBytes,
      'maxBufferedAmountBytes',
    )
    this.#bufferedAmountPollMs = positiveInteger(
      options.bufferedAmountPollMs ??
        DEFAULT_NODE_WEBSOCKET_LIMITS.bufferedAmountPollMs,
      'bufferedAmountPollMs',
    )
    this.#sendTimeoutMs = positiveInteger(
      options.sendTimeoutMs ?? DEFAULT_NODE_WEBSOCKET_LIMITS.sendTimeoutMs,
      'sendTimeoutMs',
    )
    this.#signal = options.signal
    socket.addEventListener('message', this.#onMessage)
    socket.addEventListener('close', this.#onClose)
    socket.addEventListener('error', this.#onError)
    options.signal?.addEventListener('abort', this.#onAbort, { once: true })
    if (options.signal?.aborted) this.#onAbort()
  }

  send(message: unknown): Promise<void> {
    if (this.#closeInfo) return Promise.reject(new Error('WebSocket is closed'))
    if (this.#pendingSends >= this.#maxPendingSends) {
      return Promise.reject(new Error('WebSocket outbound queue is full'))
    }
    const validation = this.#outboundValidator(message)
    if (!validation.success) {
      return Promise.reject(
        new Error(
          `invalid outbound node frame: ${validation.errors.join('; ')}`,
        ),
      )
    }
    let encoded: string
    try {
      encoded = JSON.stringify(validation.value)
    } catch (error) {
      return Promise.reject(error)
    }
    const bytes = encoder.encode(encoded).byteLength
    if (bytes > this.#maxOutboundMessageBytes) {
      return Promise.reject(
        new Error(
          `outbound WebSocket message exceeds ${this.#maxOutboundMessageBytes} bytes`,
        ),
      )
    }
    this.#pendingSends++
    const send = this.#sendChain.then(() => this.#sendEncoded(encoded, bytes))
    this.#sendChain = send.catch(() => undefined)
    return send.finally(() => this.#pendingSends--)
  }

  close(info: DuplexCloseInfo): Promise<void> {
    this.#finish(info)
    const state = this.#socket.readyState
    if (
      state !== socketState(this.#socket, 'CLOSING') &&
      state !== socketState(this.#socket, 'CLOSED')
    ) {
      this.#socket.close(
        websocketCloseCode(info.code),
        closeReason(info.reason),
      )
    }
    return Promise.resolve()
  }

  async #sendEncoded(encoded: string, bytes: number): Promise<void> {
    const startedAt = Date.now()
    while (
      this.#socket.bufferedAmount + bytes > this.#maxBufferedAmountBytes
    ) {
      if (this.#closeInfo) throw new Error('WebSocket is closed')
      if (Date.now() - startedAt >= this.#sendTimeoutMs) {
        const error = new Error('WebSocket backpressure timeout')
        await this.#fail('backpressure-timeout', error)
        throw error
      }
      await new Promise((resolve) =>
        setTimeout(resolve, this.#bufferedAmountPollMs)
      )
    }
    if (this.#socket.readyState !== socketState(this.#socket, 'OPEN')) {
      throw new Error('WebSocket is not open')
    }
    this.#socket.send(encoded)
  }

  #onMessage = (event: MessageEvent): void => {
    this.#processingMessages = this.#processingMessages
      .then(() => this.#acceptMessage(event.data))
      .catch(() => undefined)
  }

  async #acceptMessage(data: unknown): Promise<void> {
    if (this.#closeInfo) return
    if (typeof data !== 'string') {
      await this.#fail(
        'unsupported-data',
        new Error('node WebSocket requires text JSON messages'),
      )
      return
    }
    if (encoder.encode(data).byteLength > this.#maxInboundMessageBytes) {
      await this.#fail(
        'message-too-large',
        new Error(
          `inbound WebSocket message exceeds ${this.#maxInboundMessageBytes} bytes`,
        ),
      )
      return
    }
    let decoded: unknown
    try {
      decoded = JSON.parse(data)
    } catch {
      await this.#fail('malformed-json', new Error('malformed JSON message'))
      return
    }
    const validation = this.#inboundValidator(decoded)
    if (!validation.success) {
      await this.#fail(
        'invalid-frame',
        new Error(`invalid node frame: ${validation.errors.join('; ')}`),
      )
      return
    }
    this.#inbox.push(validation.value)
  }

  #onClose = (event: CloseEvent): void => {
    this.#finish({
      code: symbolicCloseCode(event.code),
      reason: event.reason || 'WebSocket peer closed the connection',
      clean: event.wasClean,
    })
  }

  #onError = (): void => {
    void this.#fail('transport-failed', new Error('WebSocket transport error'))
  }

  #onAbort = (): void => {
    void this.close({
      code: 'aborted',
      reason: 'operation aborted',
      clean: true,
    })
  }

  async #fail(code: string, error: Error): Promise<void> {
    this.#inbox.fail(error)
    await this.close({ code, reason: error.message, clean: false })
  }

  #finish(info: DuplexCloseInfo): void {
    if (this.#closeInfo) return
    this.#closeInfo = structuredClone(info)
    this.#socket.removeEventListener('message', this.#onMessage)
    this.#socket.removeEventListener('close', this.#onClose)
    this.#socket.removeEventListener('error', this.#onError)
    this.#signal?.removeEventListener('abort', this.#onAbort)
    this.#inbox.end()
    this.#closedResolver.resolve(structuredClone(info))
  }
}

export function acceptAuthenticatedNodeWebSocket(
  socket: WebSocket,
  options: NodeWebSocketTransportOptions = {},
): NodeMessageDuplex {
  return new WebSocketNodeMessageDuplex(
    socket,
    validateNodeSessionInboundFrameV1,
    validateNodeSessionOutboundFrameV1,
    options,
  )
}

export async function connectNodeWebSocket(
  url: string | URL,
  options: NodeWebSocketTransportOptions & {
    protocols?: string | string[]
    webSocketFactory?: NodeWebSocketFactory
  } = {},
): Promise<NodeMessageDuplex> {
  const factory = options.webSocketFactory ??
    ((target, protocols) => new WebSocket(target, protocols))
  const socket = factory(url, options.protocols)
  if (socket.readyState !== socketState(socket, 'OPEN')) {
    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        cleanup()
        resolve()
      }
      const onClose = (event: CloseEvent) => {
        cleanup()
        reject(new Error(event.reason || 'WebSocket closed before opening'))
      }
      const onError = () => {
        cleanup()
        reject(new Error('WebSocket failed before opening'))
      }
      const onAbort = () => {
        cleanup()
        socket.close(1000, 'operation aborted')
        reject(
          options.signal?.reason ?? new DOMException('Aborted', 'AbortError'),
        )
      }
      const cleanup = () => {
        socket.removeEventListener('open', onOpen)
        socket.removeEventListener('close', onClose)
        socket.removeEventListener('error', onError)
        options.signal?.removeEventListener('abort', onAbort)
      }
      socket.addEventListener('open', onOpen, { once: true })
      socket.addEventListener('close', onClose, { once: true })
      socket.addEventListener('error', onError, { once: true })
      options.signal?.addEventListener('abort', onAbort, { once: true })
      if (options.signal?.aborted) onAbort()
    })
  }
  return new WebSocketNodeMessageDuplex(
    socket,
    validateNodeSessionOutboundFrameV1,
    validateNodeSessionInboundFrameV1,
    options,
  )
}
