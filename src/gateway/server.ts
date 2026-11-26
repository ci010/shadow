import { GLTF_CAPTURE_HEADER } from '../gltf-capture-contract.ts'
import { HTML_PREVIEW_BASE_HEADER, HtmlPreviewLeases, previewContext } from './html-preview.ts'
import type { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { env } from 'node:process'
import type { AddressInfo, Socket } from 'node:net'
import { IncomingMessage } from 'node:http'
import { gatewayWebSockets, normalizeGatewayUpgradeRequest } from './websocket.ts'
import type { GatewayPlugin } from './types.ts'

export type { GatewayPlugin } from './types.ts'

export interface GatewayOptions {
  port?: number
  host?: string
  sharedWebSockets?: boolean
  requestGuard?: (request: Request) => Response | undefined
  clientAddresses?: GatewayClientAddressRegistry
}

export class GatewayClientAddressRegistry {
  readonly #addresses = new WeakMap<Request, string>()

  capture(request: Request, address: { transport: string; hostname: string }): void {
    this.#addresses.set(request, `${address.transport}:${address.hostname}`)
  }

  resolve(request: Request): string {
    return this.#addresses.get(request) ?? ''
  }

  inherit(source: Request, target: Request): void {
    const address = this.#addresses.get(source)
    if (address) this.#addresses.set(target, address)
  }
}

export function isLoopbackGatewayRequest(request: Request, clientAddresses: GatewayClientAddressRegistry): boolean {
  return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(request.url).hostname)
    && ['tcp:127.0.0.1', 'tcp:::1', 'tcp:::ffff:127.0.0.1'].includes(clientAddresses.resolve(request))
}

export interface GatewayRouteOptions {
  allowedOrigins?: string[]
  launchCredential?: string
  authorizeClient?: (request: Request) => boolean
  requireCredential?: boolean
  delegatedViewer?: {
    authorize(request: Request): boolean
    hasCredential(request: Request): boolean
    ownerSignal(request: Request): AbortSignal | undefined
    allowsCaptureBinding?(request: Request): boolean
    allowsCrossOrigin(path: string, method: string): boolean
  }
  clientAddresses?: GatewayClientAddressRegistry
  localLiveSocketPath?: string
  launchCredentialExemptions?: readonly {
    readonly method: string
    readonly path: string
  }[]
}

const CORS_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const
const CORS_HEADERS = ['Content-Type', 'Authorization', 'If-None-Match', 'Range', 'Last-Event-ID', GLTF_CAPTURE_HEADER, HTML_PREVIEW_BASE_HEADER] as const

// A 32 KiB live-topic JSON query can occupy 96 KiB after percent encoding.
// Bound the parser while retaining room for the cursor and ordinary headers.
export const GATEWAY_MAX_HEADER_BYTES = 128 * 1024

export function resolveLaunchCredential(
  explicitCredential?: string,
  environmentCredential?: string,
  electronCredential?: string,
): string | undefined {
  return explicitCredential || environmentCredential || electronCredential ||
    undefined
}

export async function validateLaunchCredential(
  authorization: string | undefined,
  expectedCredential: string,
): Promise<boolean> {
  const presentedCredential = authorization?.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length)
    : ''
  const encoder = new TextEncoder()
  const [presentedDigest, expectedDigest] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(presentedCredential)),
    crypto.subtle.digest('SHA-256', encoder.encode(expectedCredential)),
  ])
  const presentedBytes = new Uint8Array(presentedDigest)
  const expectedBytes = new Uint8Array(expectedDigest)
  let difference = 0
  for (let index = 0; index < expectedBytes.length; index++) {
    difference |= presentedBytes[index] ^ expectedBytes[index]
  }
  return difference === 0
}

function normalizeConfiguredOrigin(value: string): string | undefined {
  const candidate = value.trim()
  if (!candidate || candidate === '*') return undefined
  try {
    const origin = new URL(candidate).origin
    return origin === 'null' ? undefined : origin
  } catch {
    return undefined
  }
}

export function resolveAllowedOrigins(
  configuredOrigins?: string,
  viteDevUrl?: string,
): string[] {
  const origins = [
    ...(configuredOrigins?.split(',') ?? []),
    ...(viteDevUrl ? [viteDevUrl] : []),
  ].map(normalizeConfiguredOrigin).filter((origin): origin is string =>
    Boolean(origin)
  )
  return [...new Set(origins)]
}

export function resolveGatewayHost(
  explicitHost?: string,
  gatewayHost?: string,
  legacyRestApiHost?: string,
): string {
  return explicitHost ?? gatewayHost ?? legacyRestApiHost ?? '127.0.0.1'
}

function registerGatewayRoutes(
  app: Hono,
  plugins: GatewayPlugin[],
  opts: GatewayRouteOptions = {},
  environment: NodeJS.ProcessEnv = env,
) {
  const htmlPreviews = new HtmlPreviewLeases()
  // Diagnose organize requests rejected before the Project plugin (origin/auth/routing).
  // Do not log URLs, headers, credentials or arbitrary error messages.
  app.use('*', async (c, next) => {
    const path = new URL(c.req.url).pathname
    if (c.req.method !== 'POST' || !/^\/(?:projects\/[^/]+\/)?api\/work\/organize$/.test(path)) return next()
    await next()
    if (c.res.ok || c.res.headers.has('X-Correlation-ID')) return
    const correlationId = crypto.randomUUID()
    const payload: unknown = await c.res.clone().json().catch(() => null)
    const candidate = payload && typeof payload === 'object' ? (payload as { error?: unknown }).error : undefined
    const code = typeof candidate === 'string' && /^[a-z_]{1,80}$/.test(candidate) ? candidate : 'organization_gateway_failed'
    const stage = 'gateway'
    console.error('[work-organization]', { correlationId, stage, code, status: c.res.status })
    const headers = new Headers(c.res.headers)
    headers.set('X-Correlation-ID', correlationId)
    headers.set('Content-Type', 'application/json')
    headers.delete('Content-Length')
    c.res = new Response(JSON.stringify({ error: code, stage, correlationId }), { status: c.res.status, headers })
  })
  const launchCredential = resolveLaunchCredential(
    opts.launchCredential,
    environment.GATEWAY_LAUNCH_CREDENTIAL,
    environment.WINDOWS_USE_LAUNCH_TOKEN,
  )
  const allowedOrigins = new Set(
    opts.allowedOrigins
      ? resolveAllowedOrigins(opts.allowedOrigins.join(','))
      : resolveAllowedOrigins(
        environment.GATEWAY_ALLOWED_ORIGINS,
        environment.VITE_DEV_URL,
      ),
  )
  const launchCredentialExemptions = new Set(
    (opts.launchCredentialExemptions ?? []).map(({ method, path }) => {
      if (!path.startsWith('/') || path.includes('?') || path.includes('#')) {
        throw new TypeError('Gateway authentication exemption path is invalid')
      }
      return `${method.toUpperCase()}\u0000${path}`
    }),
  )

  app.use('*', async (c, next) => {
    try {
      const original = c.req.raw
      normalizeGatewayUpgradeRequest(c)
      opts.clientAddresses?.inherit(original, c.req.raw)
      const incoming: unknown = typeof c.env === 'object' && c.env !== null && 'incoming' in c.env ? c.env.incoming : undefined
      if (incoming instanceof IncomingMessage && incoming.socket.remoteAddress) {
        opts.clientAddresses?.capture(c.req.raw, { transport: 'tcp', hostname: incoming.socket.remoteAddress })
      }
    } catch {
      return c.json({ error: 'invalid_websocket_host' }, 400)
    }
    const incoming: unknown = typeof c.env === 'object' && c.env !== null && 'incoming' in c.env ? c.env.incoming : undefined
    const previewResponse = await htmlPreviews.serve(c.req.raw)
    if (previewResponse) return previewResponse
    const requestOrigin = c.req.header('Origin')
    let normalizedRequestOrigin: string | undefined
    if (requestOrigin) {
      const url = new URL(c.req.url)
      // Chromium sends file:// on a packaged Electron WebSocket even though its
      // authenticated HTTP ticket request carries no Origin. Limit that spelling
      // to the exact ticket-validated loopback live route, never ordinary APIs.
      const localLiveUpgrade = requestOrigin === 'file://' && launchCredential &&
        c.req.method === 'GET' && url.pathname === opts.localLiveSocketPath &&
        c.req.header('Upgrade')?.toLowerCase() === 'websocket' &&
        c.req.header('Sec-WebSocket-Protocol')?.split(',').some(value => /^ticket\.[a-f0-9-]{36}$/.test(value.trim())) &&
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && incoming instanceof IncomingMessage &&
        ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(incoming.socket.remoteAddress ?? '')
      const viewer = opts.delegatedViewer
      const requestedMethod = c.req.header('Access-Control-Request-Method')?.toUpperCase() ?? c.req.method
      const loopbackOrigin = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::[0-9]+)?$/.test(requestOrigin)
      const viewerPreflight = c.req.method === 'OPTIONS' && (requestOrigin === 'null' || loopbackOrigin) &&
        viewer?.allowsCrossOrigin(url.pathname, requestedMethod)
      const viewerRequest = (requestOrigin === 'null' || loopbackOrigin) && viewer?.hasCredential(c.req.raw) &&
        viewer.allowsCrossOrigin(url.pathname, c.req.method)
      const viewerFileUpgrade = requestOrigin === 'file://' && c.req.method === 'GET' && url.pathname === opts.localLiveSocketPath &&
        c.req.header('Upgrade')?.toLowerCase() === 'websocket' &&
        c.req.header('Sec-WebSocket-Protocol')?.split(',').some(value => /^ticket\.[a-f0-9-]{36}$/.test(value.trim())) && !!viewer
      // The exact one-use live ticket also binds the renderer Origin at upgrade.
      const viewerDevUpgrade = loopbackOrigin && url.pathname === opts.localLiveSocketPath &&
        c.req.header('Upgrade')?.toLowerCase() === 'websocket' && !!viewer
      if (viewerPreflight || viewerRequest || viewerDevUpgrade) {
        normalizedRequestOrigin = requestOrigin
      } else if ((requestOrigin === 'null' && launchCredential) || localLiveUpgrade || viewerFileUpgrade) {
        normalizedRequestOrigin = 'null'
      } else {
        try {
          normalizedRequestOrigin = new URL(requestOrigin).origin
        } catch {
          return c.json({ error: 'origin_not_allowed' }, 403)
        }
        if (
          normalizedRequestOrigin !== requestOrigin ||
          (
            normalizedRequestOrigin !== new URL(c.req.url).origin &&
            !allowedOrigins.has(normalizedRequestOrigin)
          )
        ) {
          return c.json({ error: 'origin_not_allowed' }, 403)
        }
      }

      if (c.req.method === 'OPTIONS') {
        const requestedMethod = c.req.header('Access-Control-Request-Method')
          ?.toUpperCase()
        if (
          requestedMethod &&
          !CORS_METHODS.includes(requestedMethod as typeof CORS_METHODS[number])
        ) {
          return c.json({ error: 'cors_method_not_allowed' }, 403)
        }

        const requestedHeaders =
          c.req.header('Access-Control-Request-Headers')?.split(',').map((
            header,
          ) => header.trim().toLowerCase()).filter(Boolean) ?? []
        if (
          requestedHeaders.some((header) =>
            !CORS_HEADERS.some((allowed) => allowed.toLowerCase() === header)
          )
        ) {
          return c.json({ error: 'cors_headers_not_allowed' }, 403)
        }

        return c.body(null, 204, {
          'Access-Control-Allow-Origin': normalizedRequestOrigin,
          'Access-Control-Allow-Methods': CORS_METHODS.join(', '),
          'Access-Control-Allow-Headers': CORS_HEADERS.join(', '),
          'Access-Control-Max-Age': '600',
          'Vary': 'Origin',
        })
      }
    }

    const launchCredentialExempt = launchCredentialExemptions.has(
      `${c.req.method.toUpperCase()}\u0000${new URL(c.req.url).pathname}`,
    )
    const viewerSignal = opts.delegatedViewer?.ownerSignal(c.req.raw)
    if (opts.delegatedViewer?.hasCredential(c.req.raw) && !viewerSignal) {
      const invalid = opts.delegatedViewer.allowsCrossOrigin(new URL(c.req.url).pathname, c.req.method)
      return c.json({ error: 'unauthorized' }, 401, {
        'Cache-Control': 'no-store',
        ...(invalid ? { 'X-Shadow-Device-Session': 'invalid' } : {}),
        ...(normalizedRequestOrigin ? { 'Access-Control-Allow-Origin': normalizedRequestOrigin, Vary: 'Origin' } : {}),
      })
    }
    if (
      c.req.method !== 'OPTIONS' && (launchCredential || opts.requireCredential) &&
      !launchCredentialExempt &&
      !opts.authorizeClient?.(c.req.raw) &&
      !(launchCredential && await validateLaunchCredential(
        c.req.header('Authorization'),
        launchCredential,
      ))
    ) {
      return c.json({ error: 'unauthorized' }, 401, {
        'WWW-Authenticate': 'Bearer',
      })
    }

    const ownerSignal = viewerSignal
    if (ownerSignal) {
      const original = c.req.raw
      const headers = viewerSignal && original.headers.has(GLTF_CAPTURE_HEADER) && !opts.delegatedViewer?.allowsCaptureBinding?.(original)
        ? new Headers(original.headers) : undefined
      headers?.delete(GLTF_CAPTURE_HEADER)
      c.req.raw = new Request(original, {
        ...(headers ? { headers } : {}),
        signal: AbortSignal.any([original.signal, ownerSignal]),
      })
      opts.clientAddresses?.inherit(original, c.req.raw)
    }
    await previewContext.run({ store: htmlPreviews, origin: new URL(c.req.url).origin, owner: ownerSignal }, next)
    if (normalizedRequestOrigin) {
      c.header('Access-Control-Allow-Origin', normalizedRequestOrigin)
      const exposedHeaders = (c.res.headers.get('Access-Control-Expose-Headers') ?? '')
        .split(',').map(header => header.trim()).filter(Boolean)
          if (!exposedHeaders.some(header => header.toLowerCase() === 'etag')) exposedHeaders.push('ETag')
      for (const header of ['Content-Disposition', 'Content-Range', 'Accept-Ranges', 'X-Shadow-Source-Path']) {
        if (c.res.headers.has(header) && !exposedHeaders.some(exposed => exposed.toLowerCase() === header.toLowerCase())) exposedHeaders.push(header)
      }
      if (c.res.headers.has('X-Shadow-Request-Id') && !exposedHeaders.some(header => header.toLowerCase() === 'x-shadow-request-id')) exposedHeaders.push('X-Shadow-Request-Id')
      c.header('Access-Control-Expose-Headers', exposedHeaders.join(', '))
      const vary = (c.res.headers.get('Vary') ?? '').split(',').map(value => value.trim()).filter(Boolean)
      if (!vary.includes('*') && !vary.some(value => value.toLowerCase() === 'origin')) vary.push('Origin')
      c.header('Vary', vary.join(', '))
    }
  })
  app.delete('/api/html-preview-leases/:token', c => {
    htmlPreviews.revoke(c.req.param('token'))
    return c.body(null, 204)
  })

  for (const plugin of plugins) plugin(app)

  app.notFound((c) => c.json({ error: 'not_found' }, 404))
}

export { registerGatewayRoutes }

/**
 * Start serving a Hono app. The app should already have all routes registered
 * (including any channel-specific routes added during `channel.start(app)`).
 */
export function serveGateway(
  app: Hono,
  opts: GatewayOptions = {},
) {
  const port = opts.port ??
    Number(
      env.GATEWAY_PORT ?? env.REST_API_PORT ?? 3123,
    )
  const host = resolveGatewayHost(
    opts.host,
    env.GATEWAY_HOST,
    env.REST_API_HOST,
  )
  const ready = Promise.withResolvers<void>()
  const finished = Promise.withResolvers<void>()
  const server = serve({
    port,
    hostname: host,
    serverOptions: { maxHeaderSize: GATEWAY_MAX_HEADER_BYTES },
    fetch: (request, bindings) => {
      const hostname = bindings.incoming.socket.remoteAddress
      if (hostname) {
        opts.clientAddresses?.capture(request, { transport: 'tcp', hostname })
      }
      const denied = opts.requestGuard?.(request)
      return denied ?? app.fetch(request, bindings)
    },
  }, (address) => {
    console.info(`[gateway] Gateway server started on ${host}:${address.port}`)
    ready.resolve()
  })
  const sockets = gatewayWebSockets(app)
  sockets.injectWebSocket(server)
  const upgrades = new Set<Socket>()
  if (opts.sharedWebSockets) server.on('upgrade', (_request, socket: Socket) => {
    upgrades.add(socket)
    socket.once('close', () => upgrades.delete(socket))
  })
  server.once('error', (error) => {
    ready.reject(error)
    finished.reject(error)
  })
  server.once('close', () => finished.resolve())
  // Callers can await readiness/termination independently without unhandled rejections.
  void ready.promise.catch(() => {})
  void finished.promise.catch(() => {})
  let shutdownPromise: Promise<void> | undefined
  return {
    ready: ready.promise,
    finished: finished.promise,
    get addr(): GatewayAddress {
      const address = server.address() as AddressInfo | null
      return {
        transport: 'tcp',
        hostname: address?.address ?? host,
        port: address?.port ?? port,
      }
    },
    shutdown(): Promise<void> {
      shutdownPromise ??= (async () => {
        await ready.promise.catch(() => {})
        if (!opts.sharedWebSockets) {
          for (const socket of sockets.wss.clients) socket.terminate()
          sockets.wss.close()
        } else {
          for (const socket of upgrades) socket.destroy()
        }
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error)
            else resolve()
          })
        })
      })()
      return shutdownPromise
    },
  }
}

export interface GatewayAddress {
  readonly transport: 'tcp'
  readonly hostname: string
  readonly port: number
}

export type GatewayServer = ReturnType<typeof serveGateway>
