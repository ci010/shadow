import WebSocket from 'ws'
import { upgradeGatewayWebSocket } from '../gateway/websocket.ts'
import { bridgeSockets } from '../gateway/socket-bridge.ts'
import { isBackendPath } from '../gateway/route-kind.ts'
import type { GatewayClientAddressRegistry } from '../gateway/server.ts'
import { deviceChallengeApiPlugin } from './device-challenge-api.ts'
import { decodeDeviceChallengeProtocol } from './device-challenge.ts'
import type { MainCluster } from './main-cluster.ts'
import type { DeviceAuthenticationV1 } from './registry.ts'
import type { GatewayPlugin } from '../gateway/types.ts'

export const DEVICE_UI_CHALLENGE = '/cluster/v1/ui/challenges'
export const DEVICE_UI_HMR = '/cluster/v1/ui/hmr'
export const DEVICE_UI_REQUEST = '/cluster/v1/ui/request'
export const DEVICE_UI_ROUTES = [
  { method: 'POST', path: DEVICE_UI_CHALLENGE }, { method: 'POST', path: DEVICE_UI_REQUEST }, { method: 'GET', path: DEVICE_UI_HMR },
] as const
export function deviceUiAudience(value: string): string {
  const url = new URL(value)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = DEVICE_UI_REQUEST; url.search = ''; url.hash = ''
  return url.toString()
}
/** UI business APIs only. Control/device/credential ingress never becomes tunnelable. */
export function deviceUiPath(value: string): boolean {
  // Query values include encoded attachment paths (and may contain URLs). They
  // are business API data, not part of the route admission/escape check.
  const rawPath = value.split(/[?#]/, 1)[0]!
  if (!rawPath.startsWith('/') || rawPath.startsWith('//') || rawPath.includes('\\') || /%2f|%5c|%2e/i.test(rawPath)) return false
  const path = new URL(value, 'http://workspace.internal').pathname
  const bare = path.replace(/^\/projects\/[^/]+(?=\/)/, '')
  return (/^\/api(?:\/|$)/.test(bare) && !/^\/api\/(?:web-auth|mobile|agent-types)(?:\/|$)/.test(bare))
    || /^\/(?:host\/)?v1\/query(?:\/|$)/.test(bare)
    || /^\/nodes\/v1(?:\/|$)/.test(bare)
}
/** Read-only renderer resources; never admit backend/control routes by SPA fallback. */
export function deviceUiResourcePath(value: string): boolean {
  const path = value.split(/[?#]/, 1)[0]!
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\') || /%2f|%5c|%2e/i.test(path)) return false
  if (path !== new URL(value, 'http://workspace.internal').pathname || isBackendPath(path)) return false
  return !path.split('/').some(segment => segment.startsWith('.') && segment !== '.vite' && segment !== '.vite-shadow-app' && segment !== '.pnpm')
}
export function deviceUiRequestPath(path: string, method: string): boolean {
  return deviceUiPath(path) || (['GET', 'HEAD'].includes(method) && deviceUiResourcePath(path))
}
export function deviceUiHeaders(headers: Headers): Headers {
  const result = new Headers()
  for (const key of ['content-type', 'accept', 'range', 'if-none-match', 'if-modified-since']) {
    const value = headers.get(key); if (value) result.set(key, value)
  }
  return result
}

/** Authenticated identity is attached to a Request object, never exposed as an admin bearer. */
export class MainDeviceUi {
  private readonly identities = new Map<string, DeviceAuthenticationV1>()
  private readonly active = new Map<AbortController, DeviceAuthenticationV1>()
  private closed = false
  private timer: ReturnType<typeof setInterval>
  constructor(private readonly cluster: MainCluster, private readonly clientAddresses: GatewayClientAddressRegistry, private readonly forward: (request: Request) => Promise<Response>, private readonly developmentUrl?: string) {
    this.timer = setInterval(() => {
      for (const [controller, authentication] of this.active) {
        try { cluster.registry.authenticate(authentication) }
        catch { controller.abort(); this.active.delete(controller) }
      }
    }, 500)
    this.timer.unref()
  }
  authorize(request: Request): boolean {
    const authentication = this.identities.get(this.clientAddresses.resolve(request))
    if (this.closed || !authentication || !deviceUiRequestPath(new URL(request.url).pathname, request.method)) return false
    try { this.cluster.registry.authenticate(authentication); return true } catch { return false }
  }
  close(): void { this.closed = true; this.identities.clear(); clearInterval(this.timer); for (const controller of this.active.keys()) controller.abort(); this.active.clear() }
  plugin(): GatewayPlugin {
    return app => {
      app.use('/cluster/v1/ui/*', async (c, next) => {
        c.header('Cache-Control', 'no-store')
        if (this.closed || this.active.size >= 128) return c.json({ error: 'device_ui_unavailable' }, 503)
        await next()
      })
      deviceChallengeApiPlugin({ authority: this.cluster.authority, path: DEVICE_UI_CHALLENGE,
        audience: deviceUiAudience, requestsPerMinute: 600, clientKey: request => new URL(request.url).host })(app)
      app.get(DEVICE_UI_HMR, async c => {
        if (!this.developmentUrl || c.req.header('upgrade')?.toLowerCase() !== 'websocket') return c.notFound()
        const proof = decodeDeviceChallengeProtocol(c.req.header('X-Shadow-Device-Proof') ?? '')
        const authentication = proof && await this.cluster.authority.verify(proof, deviceUiAudience(c.req.url))
        if (!authentication) return c.json({ error: 'device_ui_unauthorized' }, 401)
        const path = c.req.header('X-Shadow-Ui-Path') ?? ''
        if (!deviceUiResourcePath(path)) return c.json({ error: 'device_ui_path_forbidden' }, 403)
        const target = new URL(path, this.developmentUrl)
        target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:'
        const controller = new AbortController()
        this.active.set(controller, authentication)
        try {
          return await upgradeGatewayWebSocket(app, c, socket => {
            const upstream = new WebSocket(target, 'vite-hmr', { handshakeTimeout: 8000 })
            const stop = () => { socket.terminate(); upstream.terminate() }
            controller.signal.addEventListener('abort', stop, { once: true })
            socket.once('close', () => { this.active.delete(controller); controller.signal.removeEventListener('abort', stop) })
            bridgeSockets(socket, upstream)
          }, 'vite-hmr')
        } catch { this.active.delete(controller); return c.json({ error: 'device_ui_hmr_unavailable' }, 502) }
      })
      app.post(DEVICE_UI_REQUEST, async c => {
        const proof = decodeDeviceChallengeProtocol(c.req.header('X-Shadow-Device-Proof') ?? '')
        const authentication = proof && await this.cluster.authority.verify(proof, deviceUiAudience(c.req.url))
        if (!authentication) return c.json({ error: 'device_ui_unauthorized' }, 401)
        const path = c.req.header('X-Shadow-Ui-Path') ?? ''
        const method = c.req.header('X-Shadow-Ui-Method') ?? ''
        if (!deviceUiRequestPath(path, method) || !['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return c.json({ error: 'device_ui_path_forbidden' }, 403)
        const controller = new AbortController()
        this.active.set(controller, authentication)
        const signal = AbortSignal.any([c.req.raw.signal, controller.signal])
        const request = new Request(new URL(path, 'http://workspace.internal'), {
          method, headers: deviceUiHeaders(c.req.raw.headers), signal,
          ...(!['GET', 'HEAD'].includes(method) ? { body: c.req.raw.body, duplex: 'half' } : {}),
        } as RequestInit)
        const identity = `device-ui:${authentication.credentialId}`
        this.identities.set(identity, authentication)
        this.clientAddresses.capture(request, { transport: 'device-ui', hostname: authentication.credentialId })
        try {
          const response = await this.forward(request)
          const headers = new Headers(response.headers)
          for (const name of ['set-cookie', 'access-control-allow-origin', 'access-control-allow-credentials']) headers.delete(name)
          headers.set('Cache-Control', 'no-store')
          if (!response.body) { this.active.delete(controller); return new Response(null, { status: response.status, headers }) }
          const reader = response.body.getReader()
          const abort = () => { void reader.cancel(signal.reason).catch(() => {}) }
          signal.addEventListener('abort', abort, { once: true })
          const release = () => { this.active.delete(controller); signal.removeEventListener('abort', abort) }
          const body = new ReadableStream<Uint8Array>({
            async pull(output) {
              try { signal.throwIfAborted(); const part = await reader.read(); signal.throwIfAborted(); if (part.done) { release(); output.close() } else output.enqueue(part.value) }
              catch (error) { release(); output.error(error); void reader.cancel().catch(() => {}) }
            },
            cancel() { controller.abort(); release(); return reader.cancel() },
          })
          return new Response(body, { status: response.status, headers })
        } catch { this.active.delete(controller); return c.json({ error: 'main_workspace_unavailable' }, 502) }
      })
    }
  }
}
