import type { GatewayPlugin } from '../gateway/types.ts'

export type LocalRuntimeRole = 'main' | 'child'
export type LocalRuntimeStatus = 'starting' | 'ready' | 'stopping'

export interface LocalReadinessResponse {
  version: 1
  role: LocalRuntimeRole
  status: LocalRuntimeStatus
}

export interface LocalShutdownResponse {
  version: 1
  accepted: true
}

export class LocalRuntimeControl {
  #status: LocalRuntimeStatus = 'starting'
  #shutdownScheduled = false

  constructor(
    readonly role: LocalRuntimeRole,
    private readonly requestShutdown: () => void | Promise<void>,
  ) {}

  get status(): LocalRuntimeStatus {
    return this.#status
  }

  markReady(): void {
    if (this.#status === 'starting') this.#status = 'ready'
  }

  markStopping(): void {
    this.#status = 'stopping'
  }

  scheduleShutdown(): void {
    this.markStopping()
    if (this.#shutdownScheduled) return
    this.#shutdownScheduled = true
    queueMicrotask(() => {
      Promise.resolve(this.requestShutdown()).catch((error) => {
        console.error('[local-control] Graceful shutdown failed', error)
      })
    })
  }

  plugin(): GatewayPlugin {
    return (app) => {
      app.get('/local/v1/readiness', (c) => {
        const body: LocalReadinessResponse = {
          version: 1,
          role: this.role,
          status: this.#status,
        }
        return c.json(body, this.#status === 'ready' ? 200 : 503)
      })

      app.post('/local/v1/shutdown', (c) => {
        this.scheduleShutdown()
        const body: LocalShutdownResponse = { version: 1, accepted: true }
        return c.json(body, 202)
      })
    }
  }
}
