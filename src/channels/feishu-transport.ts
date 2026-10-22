import { Worker, type WorkerOptions } from 'node:worker_threads'

export interface FeishuTransportOptions {
  appId: string
  appSecret: string
  encryptKey: string
  verificationToken: string
}

export interface FeishuTransport {
  start(): void
  stop(): Promise<void>
}

export interface FeishuCardResponse {
  toast: { type: 'success' | 'error' | 'info'; content: string }
}

export type FeishuCardHandler = (event: Record<string, unknown>) => Promise<FeishuCardResponse>

/**
 * The SDK has no cancellable connect/retry API. Isolate its lifecycle so stop
 * also terminates pending endpoint requests and reconnect timers.
 */
export class FeishuWorkerTransport implements FeishuTransport {
  private worker?: Worker

  constructor(
    private readonly options: FeishuTransportOptions,
    private readonly onEvent: (data: Record<string, unknown>) => void,
    private readonly onState: (state: 'running' | 'error' | 'disconnected') => void,
    private readonly createWorker: (url: URL, options: WorkerOptions) => Worker = (url, options) => new Worker(url, options),
    private readonly onCard?: FeishuCardHandler,
  ) {}

  start(): void {
    if (this.worker) return
    const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js'
    const worker = this.createWorker(new URL(`./feishu-worker.${extension}`, import.meta.url), {
      workerData: this.options,
      stdout: true,
      stderr: true,
      // Source execution needs the same TypeScript loader as the backend.
      ...(extension === 'ts' ? { execArgv: ['--import', 'tsx'] } : {}),
    })
    this.worker = worker
    // EventDispatcher also writes raw event payloads outside the SDK logger.
    // Surface only the structured, sanitized lifecycle messages below.
    worker.stdout?.resume()
    worker.stderr?.resume()
    worker.on('message', (message: unknown) => {
      if (this.worker !== worker || !message || typeof message !== 'object') return
      if ('state' in message && (message.state === 'running' || message.state === 'error')) {
        this.onState(message.state)
      } else if ('event' in message && message.event && typeof message.event === 'object' && !Array.isArray(message.event)) {
        this.onEvent(message.event as Record<string, unknown>)
      } else if ('card' in message && message.card && typeof message.card === 'object' && !Array.isArray(message.card)
        && 'requestId' in message && typeof message.requestId === 'number') {
        const reply = (response: FeishuCardResponse) => {
          if (this.worker === worker) worker.postMessage({ requestId: message.requestId, response })
        }
        void Promise.resolve().then(() => this.onCard?.(message.card as Record<string, unknown>))
          .then(response => reply(response ?? { toast: { type: 'error', content: 'Decision handler unavailable.' } }))
          .catch(() => reply({ toast: { type: 'error', content: 'Unable to accept this decision.' } }))
      }
    })
    worker.on('error', () => {
      if (this.worker === worker) this.onState('error')
    })
    worker.on('exit', (code) => {
      if (this.worker !== worker) return
      this.worker = undefined
      this.onState(code === 0 ? 'disconnected' : 'error')
    })
  }

  async stop(): Promise<void> {
    const worker = this.worker
    this.worker = undefined
    if (worker) {
      await worker.terminate()
      worker.removeAllListeners()
    }
  }
}
