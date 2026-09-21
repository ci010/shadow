import { Hono } from 'hono'
import {
  type GatewayAddress,
  type GatewayServer,
  registerGatewayRoutes,
  serveGateway,
  validateLaunchCredential,
} from '../gateway/server.ts'
import { LocalRuntimeControl } from './local-control.ts'
import type { ChildRuntimeService } from './child-runtime.ts'
import { nodeInventoryApiPlugin, type NodeInventoryEntry } from '../cluster/node-inventory.ts'

export interface ChildLocalControlOptions {
  readonly port: number
  readonly launchCredential: string
  readonly requestShutdown: () => void | Promise<void>
  readonly nodeInventory?: () => NodeInventoryEntry | Promise<NodeInventoryEntry>
  readonly childStatus?: () => unknown
}

export class ChildLocalControlService implements ChildRuntimeService {
  readonly #control: LocalRuntimeControl
  #server?: GatewayServer
  #shutdownPromise?: Promise<void>
  #signal?: AbortSignal
  #abort?: () => void

  constructor(readonly options: ChildLocalControlOptions) {
    if (
      !Number.isInteger(options.port) || options.port < 0 ||
      options.port > 65535
    ) {
      throw new TypeError('Child local control port is invalid')
    }
    if (!options.launchCredential) {
      throw new TypeError('Child local control requires a launch credential')
    }
    this.#control = new LocalRuntimeControl('child', options.requestShutdown)
  }

  get address(): GatewayAddress | undefined {
    return this.#server?.addr
  }

  start(signal: AbortSignal): Promise<void> {
    if (this.#server) throw new Error('Child local control is already started')
    const app = new Hono()
    registerGatewayRoutes(app, [
      this.#control.plugin(),
      ...(this.options.nodeInventory ? [nodeInventoryApiPlugin({
        path: '/local/v1/nodes',
        authorize: (request) => validateLaunchCredential(
          request.headers.get('Authorization') ?? undefined,
          this.options.launchCredential,
        ),
        inventory: async () => ({
          version: 1,
          nodes: [await this.options.nodeInventory!()],
        }),
      })] : []),
    ], { launchCredential: this.options.launchCredential })
    if (this.options.childStatus) {
      app.get('/local/v1/child', (context) => context.json(this.options.childStatus!() as Record<string, unknown>, 200, { 'Cache-Control': 'no-store' }))
    }
    this.#server = serveGateway(app, {
      host: '127.0.0.1',
      port: this.options.port,
    })
    this.#signal = signal
    this.#abort = () => void this.shutdown()
    signal.addEventListener('abort', this.#abort, { once: true })
    if (signal.aborted) this.#abort()
    return this.#server?.ready ?? Promise.resolve()
  }

  markReady(): void {
    this.#control.markReady()
  }

  shutdown(): Promise<void> {
    if (this.#shutdownPromise) return this.#shutdownPromise
    this.#control.markStopping()
    if (this.#signal && this.#abort) {
      this.#signal.removeEventListener('abort', this.#abort)
    }
    this.#signal = undefined
    this.#abort = undefined
    const server = this.#server
    this.#server = undefined
    this.#shutdownPromise = server?.shutdown() ?? Promise.resolve()
    return this.#shutdownPromise
  }
}
