import { Agent, Dispatcher, ProxyAgent } from 'undici'
import { EventEmitter } from 'node:events'
import { proxyForUrl, resolveProxyForUrl, type ProxyConfiguration } from './proxy.ts'

export class LocalProxyDispatcher extends Dispatcher {
  private readonly direct = new Agent()
  private readonly proxies = new Map<string, ProxyAgent>()
  private readonly configuration: ProxyConfiguration | (() => ProxyConfiguration)
  private readonly resolveProxy: typeof resolveProxyForUrl
  private readonly pending = new Map<AbortController, Promise<void>>()
  private closed = false

  constructor(configuration: ProxyConfiguration | (() => ProxyConfiguration), resolveProxy = resolveProxyForUrl) {
    super()
    this.configuration = configuration
    this.resolveProxy = resolveProxy
  }

  override dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    if (this.closed) throw new Error('Proxy dispatcher is closed.')
    const configuration = typeof this.configuration === 'function' ? this.configuration() : this.configuration
    if (configuration.source === 'windows-auto') return this.dispatchAutomatic(options, handler, configuration)
    const proxy = proxyForUrl(configuration, String(options.origin))
    return this.dispatcher(proxy).dispatch(options, handler)
  }

  private dispatcher(proxy: string | undefined): Dispatcher {
    if (!proxy) return this.direct
    let dispatcher = this.proxies.get(proxy)
    if (!dispatcher) {
      dispatcher = new ProxyAgent(proxy)
      this.proxies.set(proxy, dispatcher)
    }
    return dispatcher
  }

  private dispatchAutomatic(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler, configuration: ProxyConfiguration): boolean {
    const abort = new AbortController()
    let active: Dispatcher.DispatchController | undefined
    let cancel: ((error?: Error) => void) | undefined
    let paused = false
    const controller: Dispatcher.DispatchController = {
      get aborted() { return abort.signal.aborted || active?.aborted === true },
      get paused() { return active?.paused ?? paused },
      get reason() { return abort.signal.aborted ? abort.signal.reason : active?.reason ?? null },
      abort(error) { abort.abort(error); active?.abort(error); cancel?.(error) },
      pause() { paused = true; active?.pause() },
      resume() { paused = false; active?.resume() },
    }
    const forwarding = new Proxy(handler, {
      get(target, key) {
        if (key === 'onRequestStart' && target.onRequestStart) {
          return (current: Dispatcher.DispatchController) => {
            active = current
            if (abort.signal.aborted) current.abort(abort.signal.reason)
            else if (paused) current.pause()
          }
        }
        if (key === 'onConnect' && target.onConnect) {
          return (current: (error?: Error) => void) => {
            cancel = current
            if (abort.signal.aborted) current(abort.signal.reason)
          }
        }
        const value = Reflect.get(target, key)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const request = Promise.resolve().then(async () => {
      try {
        abort.signal.throwIfAborted()
        const url = new URL(options.path, String(options.origin))
        const proxy = await this.resolveProxy(configuration, url, abort.signal)
        abort.signal.throwIfAborted()
        this.dispatcher(proxy).dispatch(options, forwarding)
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error('Automatic proxy resolution failed.')
        if (handler.onResponseError) handler.onResponseError(controller, error)
        else handler.onError?.(error)
      }
    })
    this.pending.set(abort, request)
    void request.finally(() => this.pending.delete(abort)).catch(error => { EventEmitter.prototype.emit.call(this, 'error', error) })
    if (handler.onRequestStart) handler.onRequestStart(controller, null)
    else handler.onConnect?.(error => controller.abort(error ?? new DOMException('Proxy resolution aborted', 'AbortError')))
    return true
  }

  override close(): Promise<void>
  override close(callback: (error: Error | null) => void): void
  override close(callback?: (error: Error | null) => void): Promise<void> | void {
    this.closed = true
    const closing = Promise.all(this.pending.values()).then(async () => {
      await Promise.all([this.direct.close(), ...[...this.proxies.values()].map(proxy => proxy.close())])
    })
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
    this.closed = true
    for (const pending of this.pending.keys()) pending.abort(error ?? new Error('Proxy dispatcher destroyed.'))
    const closing = Promise.all(this.pending.values()).then(async () => {
      await Promise.all([this.direct.destroy(error), ...[...this.proxies.values()].map(proxy => proxy.destroy(error))])
    })
    if (!done) return closing
    void closing.then(done, error => { EventEmitter.prototype.emit.call(this, 'error', error) })
  }
}
