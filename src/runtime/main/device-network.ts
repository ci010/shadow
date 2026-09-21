import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { isIPv4 } from 'node:net'
import { networkInterfaces } from 'node:os'
import { dirname, join } from 'node:path'
import { bodyLimit } from 'hono/body-limit'
import {
  MAIN_CLUSTER_LAUNCH_CREDENTIAL_EXEMPTIONS,
  type MainCluster,
} from '../../cluster/main-cluster.ts'
import {
  type GatewayClientAddressRegistry,
  type GatewayServer,
  registerGatewayRoutes,
  serveGateway,
} from '../../gateway/server.ts'
import type { GatewayPlugin } from '../../gateway/types.ts'
import { isNotFoundError } from '../../utils/runtime.ts'

export interface DeviceNetworkConfig {
  readonly version: 1
  readonly enabled: boolean
  readonly host: string
  readonly port: number
  readonly allowInsecureLocalTransport: boolean
}

export interface DeviceNetworkAddress {
  readonly name: string
  readonly address: string
}

export interface DeviceNetworkState extends DeviceNetworkConfig {
  readonly state: 'disabled' | 'listening' | 'error'
  readonly endpoint: string | null
  readonly error: string | null
  readonly addresses: readonly DeviceNetworkAddress[]
}

interface DeviceNetworkOptions {
  readonly configPath: string
  readonly cluster: MainCluster
  readonly clientAddresses: GatewayClientAddressRegistry
  readonly authorize: (request: Request) => boolean | Promise<boolean>
  readonly addresses?: () => readonly DeviceNetworkAddress[]
}

const DEFAULT_CONFIG: DeviceNetworkConfig = {
  version: 1, enabled: false, host: '127.0.0.1', port: 3124,
  allowInsecureLocalTransport: false,
}
const DEVICE_ROUTES = new Set(
  MAIN_CLUSTER_LAUNCH_CREDENTIAL_EXEMPTIONS.map(({ method, path }) => `${method} ${path}`),
)

export function isPrivateDeviceAddress(address: string): boolean {
  if (!isIPv4(address)) return false
  const [a, b] = address.split('.').map(Number)
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 169 && b === 254)
    || (a === 100 && b >= 64 && b <= 127)
}

export function deviceNetworkAddresses(): DeviceNetworkAddress[] {
  const addresses: DeviceNetworkAddress[] = []
  const seen = new Set<string>()
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal || !isPrivateDeviceAddress(entry.address) || seen.has(entry.address)) continue
      seen.add(entry.address)
      addresses.push({ name, address: entry.address })
    }
  }
  return [...addresses, { name: 'This device only', address: '127.0.0.1' }]
}

export function parseDeviceNetworkConfig(value: unknown): DeviceNetworkConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Device network settings must be an object')
  }
  const input = value as Record<string, unknown>
  if (
    Object.keys(input).length !== 5 || input.version !== 1
    || typeof input.enabled !== 'boolean' || typeof input.host !== 'string'
    || !isPrivateDeviceAddress(input.host)
    || !Number.isSafeInteger(input.port) || (input.port as number) < 1024 || (input.port as number) > 65535
    || typeof input.allowInsecureLocalTransport !== 'boolean'
    || (input.enabled && !input.allowInsecureLocalTransport)
  ) {
    throw new TypeError('Select a private IPv4 address, a port from 1024 to 65535, and acknowledge unencrypted trusted-network access')
  }
  return {
    version: 1, enabled: input.enabled, host: input.host, port: input.port as number,
    allowInsecureLocalTransport: input.allowInsecureLocalTransport,
  }
}

export class MainDeviceNetwork {
  private config: DeviceNetworkConfig = DEFAULT_CONFIG
  private server: GatewayServer | undefined
  private error: string | null = null
  private operation: Promise<unknown> = Promise.resolve()
  private closing = false

  constructor(private readonly options: DeviceNetworkOptions) {}

  async init(): Promise<void> {
    try {
      let contents: string
      try { contents = await readFile(this.options.configPath, 'utf8') }
      catch (error) {
        if (isNotFoundError(error)) return
        throw error
      }
      this.config = parseDeviceNetworkConfig(JSON.parse(contents))
      if (this.config.enabled) await this.startListener()
    } catch (error) {
      this.recordFailure(error)
    }
  }

  getState(): DeviceNetworkState {
    return {
      ...this.config,
      state: this.error ? 'error' : this.server ? 'listening' : 'disabled',
      endpoint: this.server && !this.error ? `http://${this.config.host}:${this.config.port}` : null,
      error: this.error,
      addresses: (this.options.addresses ?? deviceNetworkAddresses)(),
    }
  }

  configure(value: unknown): Promise<DeviceNetworkState> {
    return this.serialize(async () => {
      if (this.closing) throw new Error('Main is shutting down')
      const config = parseDeviceNetworkConfig(value)
      if (config.enabled) this.requireAddress(config.host)
      await this.save(config)
      await this.stopListener()
      this.config = config
      this.error = null
      if (config.enabled) {
        try { await this.startListener() }
        catch (error) { this.recordFailure(error) }
      }
      return this.getState()
    })
  }

  plugin(): GatewayPlugin {
    return app => {
      app.use('/nodes/v1/network', async (context, next) => {
        context.header('Cache-Control', 'no-store')
        if (!await this.options.authorize(context.req.raw)) {
          return context.json({ error: 'unauthorized' }, 401, { 'WWW-Authenticate': 'Bearer' })
        }
        await next()
      })
      app.get('/nodes/v1/network', context => context.json(this.getState()))
      app.put('/nodes/v1/network', bodyLimit({
        maxSize: 2048,
        onError: context => context.json({ error: 'body_too_large' }, 413),
      }), async context => {
        if (context.req.header('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
          return context.json({ error: 'content_type_required' }, 415)
        }
        let config: DeviceNetworkConfig
        try { config = parseDeviceNetworkConfig(await context.req.json()) }
        catch (error) {
          return context.json({ error: 'invalid_network_settings', message: error instanceof Error ? error.message : 'Invalid settings' }, 400)
        }
        try {
          const state = await this.configure(config)
          if (state.state === 'error') return context.json({ error: 'device_listener_failed', message: state.error, network: state }, 503)
          return context.json(state)
        } catch (error) {
          if (error instanceof TypeError) return context.json({ error: 'invalid_network_settings', message: error.message }, 400)
          console.error('[device-network] Settings could not be applied', error)
          return context.json({ error: 'device_network_update_failed', message: 'Device network settings could not be saved or applied. Retry and check Main diagnostics.' }, 500)
        }
      })
    }
  }

  shutdown(): Promise<void> {
    this.closing = true
    return this.serialize(() => this.stopListener())
  }

  private requireAddress(host: string): void {
    if (!(this.options.addresses ?? deviceNetworkAddresses)().some(entry => entry.address === host)) {
      throw new TypeError('The selected network address is unavailable. Select an address currently assigned to this device.')
    }
  }

  private async startListener(): Promise<void> {
    this.requireAddress(this.config.host)
    const app = new Hono()
    // Only device ingress is reachable here; the UI, launch token and administration stay on Main's gateway.
    app.use('*', async (context, next) => {
      if (!DEVICE_ROUTES.has(`${context.req.method} ${new URL(context.req.url).pathname}`)) {
        return context.json({ error: 'not_found' }, 404)
      }
      if (context.req.header('Origin')) return context.json({ error: 'browser_access_not_allowed' }, 403)
      await next()
    })
    registerGatewayRoutes(app, [...this.options.cluster.plugins], {
      clientAddresses: this.options.clientAddresses,
      launchCredentialExemptions: MAIN_CLUSTER_LAUNCH_CREDENTIAL_EXEMPTIONS,
    })
    const server = serveGateway(app, {
      host: this.config.host, port: this.config.port,
      clientAddresses: this.options.clientAddresses,
    })
    try { await server.ready }
    catch (error) {
      await server.shutdown()
      throw error
    }
    this.server = server
    void server.finished.catch(error => {
      if (this.server === server) this.recordFailure(error)
    })
  }

  private async stopListener(): Promise<void> {
    const server = this.server
    this.server = undefined
    if (server) await server.shutdown()
  }

  private recordFailure(error: unknown): void {
    const code = error instanceof Error && 'code' in error ? error.code : undefined
    this.error = code === 'EADDRINUSE' ? 'The device port is already in use. Choose a different port.'
      : code === 'EADDRNOTAVAIL' || error instanceof TypeError ? 'The saved network address is unavailable. Select a current address and retry.'
      : code === 'EACCES' ? 'Main cannot listen on this address or port. Check system permissions.'
      : 'Device network could not start. Check Main diagnostics and retry the network settings.'
    console.error('[device-network] Listener unavailable', error)
  }

  private async save(config: DeviceNetworkConfig): Promise<void> {
    const directory = dirname(this.options.configPath)
    await mkdir(directory, { recursive: true })
    const temporary = join(directory, `.${randomUUID()}.tmp`)
    try {
      const file = await open(temporary, 'wx', 0o600)
      try {
        await file.writeFile(`${JSON.stringify(config)}\n`, 'utf8')
        await file.sync()
      } finally { await file.close() }
      await rename(temporary, this.options.configPath)
    } catch (error) {
      await rm(temporary, { force: true })
      throw error
    }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation)
    this.operation = result.then(() => undefined, () => undefined)
    return result
  }
}
