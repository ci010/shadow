import type { DuplexCloseInfo, NodeMessageDuplex } from './node-transport.ts'

interface PendingRead {
  resolve(result: IteratorResult<unknown>): void
}

class InMemoryInbox implements AsyncIterable<unknown>, AsyncIterator<unknown> {
  readonly #values: unknown[] = []
  readonly #readers: PendingRead[] = []
  #ended = false

  push(value: unknown): void {
    if (this.#ended) throw new Error('in-memory duplex peer is closed')
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

  next(): Promise<IteratorResult<unknown>> {
    const value = this.#values.shift()
    if (value !== undefined) return Promise.resolve({ done: false, value })
    if (this.#ended) return Promise.resolve({ done: true, value: undefined })
    return new Promise((resolve) => this.#readers.push({ resolve }))
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return this
  }
}

export class InMemoryNodeDuplex implements NodeMessageDuplex {
  readonly #inbox = new InMemoryInbox()
  readonly #closedResolver = Promise.withResolvers<DuplexCloseInfo>()
  #peer: InMemoryNodeDuplex | undefined
  #closeInfo: DuplexCloseInfo | undefined

  readonly incoming: AsyncIterable<unknown> = this.#inbox
  readonly closed = this.#closedResolver.promise

  connect(peer: InMemoryNodeDuplex): void {
    if (this.#peer) throw new Error('in-memory duplex is already connected')
    this.#peer = peer
  }

  send(message: unknown): Promise<void> {
    if (this.#closeInfo) {
      return Promise.reject(new Error('in-memory duplex is closed'))
    }
    if (!this.#peer) {
      return Promise.reject(new Error('in-memory duplex is not connected'))
    }
    this.#peer.#inbox.push(structuredClone(message))
    return Promise.resolve()
  }

  close(info: DuplexCloseInfo): Promise<void> {
    this.#finish(info)
    if (this.#peer) this.#peer.#finish(info)
    return Promise.resolve()
  }

  #finish(info: DuplexCloseInfo): void {
    if (this.#closeInfo) return
    this.#closeInfo = structuredClone(info)
    this.#inbox.end()
    this.#closedResolver.resolve(structuredClone(info))
  }
}

export function createInMemoryNodeDuplexPair(): {
  server: InMemoryNodeDuplex
  client: InMemoryNodeDuplex
} {
  const server = new InMemoryNodeDuplex()
  const client = new InMemoryNodeDuplex()
  server.connect(client)
  client.connect(server)
  return { server, client }
}
