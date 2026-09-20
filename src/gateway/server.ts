import type { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { env } from 'node:process'
import type { AddressInfo } from 'node:net'
import { IncomingMessage } from 'node:http'
import { gatewayWebSockets, normalizeGatewayUpgradeRequest } from './websocket.ts'
import type { GatewayPlugin } from './types.ts'
import type { BrowserAuth } from './web-auth.ts'

export type { GatewayPlugin } from './types.ts'

export interface GatewayOptions {
  port?: number
  host?: string
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
  browserAuth?: BrowserAuth
  clientAddresses?: GatewayClientAddressRegistry
  launchCredentialExemptions?: readonly {
    readonly method: string
    readonly path: string
  }[]
}

const CORS_METHODS = ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'] as const
const CORS_HEADERS = ['Content-Type', 'Authorization'] as const

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
) {
  const launchCredential = resolveLaunchCredential(
    opts.launchCredential,
    env.GATEWAY_LAUNCH_CREDENTIAL,
    env.WINDOWS_USE_LAUNCH_TOKEN,
  )
  const allowedOrigins = new Set(
    opts.allowedOrigins
      ? resolveAllowedOrigins(opts.allowedOrigins.join(','))
      : resolveAllowedOrigins(
        env.GATEWAY_ALLOWED_ORIGINS,
        env.VITE_DEV_URL,
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
    if (opts.browserAuth?.isAuthenticationRequest(c.req.raw)) c.header('Cache-Control', 'no-store')
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
    const requestOrigin = c.req.header('Origin')
    let normalizedRequestOrigin: string | undefined
    if (requestOrigin) {
      if (requestOrigin === 'null' && launchCredential) {
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
          'Vary': 'Origin',
        })
      }
    }

    const launchCredentialExempt = launchCredentialExemptions.has(
      `${c.req.method.toUpperCase()}\u0000${new URL(c.req.url).pathname}`,
    )
    const browserSession = opts.browserAuth?.session(c.req.raw)
    if (
      c.req.method !== 'OPTIONS' && (launchCredential || opts.browserAuth?.required) &&
      !launchCredentialExempt &&
      !opts.browserAuth?.isPublicRequest(c.req.raw) &&
      !browserSession &&
      !(launchCredential && await validateLaunchCredential(
        c.req.header('Authorization'),
        launchCredential,
      ))
    ) {
      return c.json({ error: 'unauthorized' }, 401, {
        'WWW-Authenticate': 'Bearer',
      })
    }

    if (browserSession) {
      const original = c.req.raw
      c.req.raw = new Request(original, {
        signal: AbortSignal.any([original.signal, browserSession.controller.signal]),
      })
      opts.clientAddresses?.inherit(original, c.req.raw)
    }
    await next()
    if (normalizedRequestOrigin) {
      c.header('Access-Control-Allow-Origin', normalizedRequestOrigin)
      c.header('Vary', 'Origin')
    }
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
      return app.fetch(request, bindings)
    },
  }, (address) => {
    console.info(`[gateway] Gateway server started on ${host}:${address.port}`)
    ready.resolve()
  })
  const sockets = gatewayWebSockets(app)
  sockets.injectWebSocket(server)
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
        for (const socket of sockets.wss.clients) socket.terminate()
        sockets.wss.close()
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
