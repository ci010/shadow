import type { ChildRuntimeService } from './child-runtime.ts'

interface ChildDesktopChannel {
  on(event: 'message' | 'disconnect', listener: (value: unknown) => void): unknown
  removeListener(event: 'message' | 'disconnect', listener: (value: unknown) => void): unknown
  send(value: object, callback: (error: Error | null) => void): unknown
  disconnect(): void
  readonly connected?: boolean
}

/** Inherited Node IPC, never a TCP or named-pipe server. The renderer cannot send raw messages. */
export class ChildDesktopControl implements ChildRuntimeService {
  private ready = false
  private pending = 0
  constructor(private readonly channel: ChildDesktopChannel, private readonly operations: {
    endpoint: string
    status(): unknown
    inventory(): unknown
    grant(signal: AbortSignal): Promise<unknown>
    invalidateGrant?(): void
    stop(): void | Promise<void>
  }) {}
  private readonly lifetime = new AbortController()
  private readonly stop = () => { void Promise.resolve(this.operations.stop()).catch(() => {
    // Runtime.finished reports the actual shutdown error to the process entry.
  }) }
  private readonly disconnected = this.stop
  private readonly receive = (message: unknown) => {
    if (!message || typeof message !== 'object' || this.lifetime.signal.aborted) return
    const { type, id, operation } = message as Record<string, unknown>
    if (type !== 'shadow-child-control-v1' || typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) return
    if (operation === 'shutdown') { this.stop(); return }
    if (this.pending >= 32) return
    this.pending++
    void this.dispatch(operation).catch(() => null).then(result => {
      if (this.channel.connected) this.channel.send({ type: 'shadow-child-control-v1', id, result }, () => {})
    }).finally(() => { this.pending-- })
  }
  private async dispatch(operation: unknown): Promise<unknown> {
    if (operation === 'readiness') return { ready: this.ready, endpoint: this.operations.endpoint }
    if (!this.ready) return null
    if (operation === 'status') return this.operations.status()
    if (operation === 'inventory') return this.operations.inventory()
    if (operation === 'invalidateGrant') { this.operations.invalidateGrant?.(); return null }
    if (operation === 'grant') return this.operations.grant(this.lifetime.signal)
    return null
  }
  async start() {
    this.channel.on('message', this.receive)
    this.channel.on('disconnect', this.disconnected)
    if (!this.channel.connected) this.disconnected()
  }
  markReady() { this.ready = true }
  async shutdown() {
    this.ready = false
    this.lifetime.abort()
    this.channel.removeListener('message', this.receive)
    this.channel.removeListener('disconnect', this.disconnected)
    if (this.channel.connected) this.channel.disconnect()
  }
}

export function desktopChildChannel(): ChildDesktopChannel | undefined {
  if (process.send) return {
    on: (event, listener) => process.on(event, listener),
    removeListener: (event, listener) => process.removeListener(event, listener),
    send: (value, callback) => process.send!(value, callback),
    disconnect: () => process.disconnect!(),
    get connected() { return process.connected ?? false },
  }
  // Electron UtilityProcess uses an inherited MessagePort rather than Node send().
  const port = (process as typeof process & { parentPort?: {
    on(event: string, listener: (event: { data?: unknown }) => void): void
    removeListener(event: string, listener: (event: { data?: unknown }) => void): void
    postMessage(data: object): void
  } }).parentPort
  if (!port) return
  const listeners = new Map<(value: unknown) => void, (event: { data?: unknown }) => void>()
  let connected = true
  return {
    on(event, listener) {
      const wrapper = (message: { data?: unknown }) => {
        if (event === 'disconnect') connected = false
        listener(message.data)
      }
      listeners.set(listener, wrapper)
      port.on(event === 'disconnect' ? 'close' : 'message', wrapper)
    },
    removeListener(event, listener) {
      const wrapper = listeners.get(listener)
      if (wrapper) { listeners.delete(listener); port.removeListener(event === 'disconnect' ? 'close' : 'message', wrapper) }
    },
    send(value, done) { try { port.postMessage(value); done(null) } catch { done(new Error('Desktop IPC unavailable')) } },
    disconnect() { connected = false },
    get connected() { return connected },
  }
}

