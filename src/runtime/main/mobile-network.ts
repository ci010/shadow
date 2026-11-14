import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { MobileAccess, type MobileGatewayConfig } from '../../gateway/mobile-access.ts'
import { privateLanAddresses } from '../../gateway/lan-browser.ts'
import { serveGateway, isLoopbackGatewayRequest, validateLaunchCredential, type GatewayClientAddressRegistry, type GatewayServer } from '../../gateway/server.ts'
import type { GatewayPlugin } from '../../gateway/types.ts'

export interface MobileNetworkSettings { enabled: boolean; port: number; allowLanHttp: boolean }
export function parseMobileNetworkSettings(value: unknown): MobileNetworkSettings {
  const v = value as MobileNetworkSettings
  if (!v || typeof v !== 'object' || Object.keys(v).sort().join(',') !== 'allowLanHttp,enabled,port'
    || typeof v.enabled !== 'boolean' || typeof v.allowLanHttp !== 'boolean'
    || !Number.isInteger(v.port) || v.port < 1024 || v.port > 65535 || (v.enabled && !v.allowLanHttp)) {
    throw new TypeError('Choose a port from 1024 to 65535 and acknowledge trusted LAN HTTP.')
  }
  return { enabled: v.enabled, port: v.port, allowLanHttp: v.allowLanHttp }
}

/** A separate, opt-in authenticated phone ingress. Never serves the desktop management app. */
export class MainMobileNetwork {
  private settings: MobileNetworkSettings = { enabled: false, port: 3125, allowLanHttp: false }
  private access?: MobileAccess
  private server?: GatewayServer
  private error: string | null = null
  private operation: Promise<unknown> = Promise.resolve()
  private closing = false
  constructor(private readonly options: {
    configPath: string; launchCredential: string; clientAddresses: GatewayClientAddressRegistry
    main: Hono; environment?: MobileGatewayConfig; addresses?: () => string[]
  }) {}
  authorizeMain(request: Request) { return this.access?.authorizeMain(request) ?? false }
  state() {
    return { ...this.settings, ...(this.options.environment ? { enabled: true, port: this.options.environment.port, allowLanHttp: !!this.options.environment.allowLanHttp } : {}), managedByEnvironment: !!this.options.environment,
      state: this.error ? 'error' : this.server ? 'listening' : 'disabled',
      endpoint: this.server ? this.access!.publicOrigin : null, error: this.error,
      sessions: this.access?.listSessions() ?? [] }
  }
  init() {
    return this.serialize(async () => {
      if (this.closing) return
      try {
        if (!this.options.environment) {
          try { this.settings = parseMobileNetworkSettings(JSON.parse(await readFile(this.options.configPath, 'utf8'))) }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        }
        if (this.options.environment || this.settings.enabled) await this.start()
      } catch (error) { this.fail(error) }
    })
  }
  private async start() {
    if (!this.options.launchCredential) throw new Error('Main desktop authorization is unavailable. Restart from the desktop app.')
    const host = (this.options.addresses ?? privateLanAddresses)()[0]
    const config = this.options.environment ?? (host ? { publicOrigin: `http://${host}:${this.settings.port}`, port: this.settings.port, allowLanHttp: true } : undefined)
    if (!config) throw new Error('No private LAN IPv4 address. Connect to Wi-Fi or Ethernet and retry.')
    const access = new MobileAccess({ ...config, launchCredential: this.options.launchCredential, clientAddresses: this.options.clientAddresses })
    const server = serveGateway(access.createGateway(this.options.main), {
      host: config.publicOrigin.startsWith('http:') ? new URL(config.publicOrigin).hostname.replace(/^\[|\]$/g, '') : '127.0.0.1',
      port: config.port, clientAddresses: this.options.clientAddresses,
    })
    try { await server.ready } catch (error) { access.close(); await server.shutdown(); throw error }
    this.access = access
    this.server = server
    void server.finished.catch(error => this.serialize(async () => {
      if (this.server === server) { this.fail(error); await this.stop() }
    })).catch(error => console.error('[mobile-network] Listener cleanup failed', error))
  }
  private fail(error: unknown) {
    const code = (error as NodeJS.ErrnoException).code
    this.error = code === 'EADDRINUSE' ? 'Phone port is already in use. Choose another port and retry.'
      : code === 'EACCES' ? 'Permission denied starting phone access. Check system permissions.'
      : error instanceof Error ? error.message : 'Phone access failed. Retry and check Main diagnostics.'
  }
  private async stop() {
    this.access?.close(); this.access = undefined
    const server = this.server; this.server = undefined
    await server?.shutdown()
  }
  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = this.operation.then(action, action)
    this.operation = result.catch(() => {})
    return result
  }
  configure(value: unknown) {
    return this.serialize(async () => {
      if (this.closing) throw new Error('Main is stopping')
      if (this.options.environment) throw new TypeError('Remove SHADOW_MOBILE_* environment overrides before using app settings.')
      const settings = parseMobileNetworkSettings(value)
      await mkdir(dirname(this.options.configPath), { recursive: true })
      const temporary = `${this.options.configPath}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, JSON.stringify(settings) + '\n', { mode: 0o600, flag: 'wx' })
        await rename(temporary, this.options.configPath)
      } finally { await rm(temporary, { force: true }) }
      await this.stop()
      this.settings = settings; this.error = null
      if (settings.enabled) try { await this.start() } catch (error) { this.fail(error) }
      return this.state()
    })
  }
  shutdown() { this.closing = true; return this.serialize(() => this.stop()) }
  plugin(): GatewayPlugin {
    return app => {
      // Preserve the launch-credential CLI management API for existing deployments.
      app.all('/local/v1/mobile-*', c => {
        if (!this.access) return c.json({ error: 'mobile_access_disabled' }, 409)
        const management = new Hono()
        this.access.managementPlugin()(management)
        return management.fetch(c.req.raw)
      })
      app.use('/nodes/v1/mobile/*', async (c, next) => {
        c.header('Cache-Control', 'no-store')
        if (!isLoopbackGatewayRequest(c.req.raw, this.options.clientAddresses)
          || !await validateLaunchCredential(c.req.header('Authorization'), this.options.launchCredential)) return c.json({ error: 'unauthorized' }, 401)
        await next()
      })
      app.get('/nodes/v1/mobile/settings', c => c.json(this.state()))
      app.put('/nodes/v1/mobile/settings', bodyLimit({ maxSize: 2048 }), async c => {
        if (c.req.header('Content-Type')?.split(';')[0].trim() !== 'application/json') return c.json({ error: 'content_type_required' }, 415)
        try { return c.json(await this.configure(await c.req.json())) }
        catch (error) { return c.json({ error: error instanceof Error ? error.message : 'Phone settings could not be saved' }, error instanceof TypeError || error instanceof SyntaxError ? 400 : 500) }
      })
      app.post('/nodes/v1/mobile/pairing', c => {
        if (!this.access || this.closing) return c.json({ error: 'Enable phone access first' }, 409)
        try { return c.json(this.access.createPairing()) }
        catch { return c.json({ error: 'Pairing capacity reached. Wait five minutes and retry.' }, 429) }
      })
      app.delete('/nodes/v1/mobile/sessions/:id', c => {
        if (!this.access?.revokeSession(c.req.param('id'))) return c.json({ error: 'session_not_found' }, 404)
        return c.json(this.state())
      })
    }
  }
}
