import { Agent, Dispatcher, ProxyAgent } from 'undici'
import { EventEmitter } from 'node:events'
import { proxyForUrl, type ProxyConfiguration } from './proxy.ts'

export class LocalProxyDispatcher extends Dispatcher {
  private readonly direct = new Agent()
  private readonly proxies = new Map<string, ProxyAgent>()
  private readonly configuration: ProxyConfiguration

  constructor(configuration: ProxyConfiguration) {
    super()
    this.configuration = configuration
  }

  override dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    const proxy = proxyForUrl(this.configuration, String(options.origin))
    if (!proxy) return this.direct.dispatch(options, handler)
    let dispatcher = this.proxies.get(proxy)
    if (!dispatcher) {
      dispatcher = new ProxyAgent(proxy)
      this.proxies.set(proxy, dispatcher)
    }
    return dispatcher.dispatch(options, handler)
  }

  override close(): Promise<void>
  override close(callback: (error: Error | null) => void): void
  override close(callback?: (error: Error | null) => void): Promise<void> | void {
    const closing = Promise.all([this.direct.close(), ...[...this.proxies.values()].map(proxy => proxy.close())]).then(() => {})
    if (!callback) return closing
    void closing.then(() => callback(null), error => callback(error instanceof Error ? error : new Error('Proxy close failed')))
  }

  override destroy(): Promise<void>
  override destroy(error: Error | null): Promise<void>
  override destroy(callback: () => void): void
  override destroy(error: Error | null, callback: () => void): void
  override destroy(errorOrCallback?: Error | null | (() => void), callback?: () => void): Promise<void> | void {
    const error = typeof errorOrCallback === 'function' ? null : errorOrCallback ?? null
    const done = typeof errorOrCallback === 'function' ? errorOrCallback : callback
    const closing = Promise.all([this.direct.destroy(error), ...[...this.proxies.values()].map(proxy => proxy.destroy(error))]).then(() => {})
    if (!done) return closing
    void closing.then(done, error => { EventEmitter.prototype.emit.call(this, 'error', error) })
  }
}
