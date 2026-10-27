import { isLanHttpHost } from '../shared/lan-http.ts'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { GatewayPlugin } from './types.ts'
import { GatewayClientAddressRegistry, isLoopbackGatewayRequest, validateLaunchCredential } from './server.ts'

const CODE_TTL = 5 * 60_000
const SESSION_TTL = 12 * 60 * 60_000
const TICKET_TTL = 60_000
const NATIVE_ORIGINS = new Set(['capacitor://localhost', 'https://localhost'])
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']
const HEADERS = ['authorization', 'content-type', 'range']
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const secret = () => randomBytes(32).toString('base64url')

interface MobileSession {
  id: string
  expiresAt: number
  accessHash: string
  bridgeToken: string
  controller: AbortController
  timer: ReturnType<typeof setTimeout>
}

interface ResourceTicket {
  session: MobileSession
  path: string
  expiresAt: number
}

export interface MobileGatewayConfig {
  publicOrigin: string
  port: number
  allowLanHttp?: boolean
}

export function mobilePublicOrigin(value: string, allowLanHttp = false): string {
  const url = new URL(value)
  if ((url.protocol !== 'https:' && !(allowLanHttp && url.protocol === 'http:' && isLanHttpHost(url.hostname))) || url.username || url.password || url.pathname !== '/'
    || url.search || url.hash || (value !== url.origin && value !== `${url.origin}/`)) {
    throw new TypeError('Mobile access requires a canonical HTTPS origin (or explicitly enabled private/loopback numeric LAN HTTP) without a path or credentials')
  }
  return url.origin
}

export function mobileGatewayConfig(environment: NodeJS.ProcessEnv): MobileGatewayConfig | undefined {
  if (!environment.SHADOW_MOBILE_ORIGIN) {
    if (environment.SHADOW_MOBILE_PORT) throw new TypeError('SHADOW_MOBILE_PORT requires SHADOW_MOBILE_ORIGIN')
    return
  }
  const port = Number(environment.SHADOW_MOBILE_PORT ?? 3125)
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new TypeError('Invalid mobile gateway port')
  const allowLanHttp = environment.SHADOW_MOBILE_ALLOW_LAN_HTTP === '1'
  return { publicOrigin: mobilePublicOrigin(environment.SHADOW_MOBILE_ORIGIN, allowLanHttp), port, ...(allowLanHttp ? { allowLanHttp: true } : {}) }
}

function businessPath(path: string, method: string): boolean {
  const unscoped = path.replace(/^\/projects\/[^/]+(?=\/)/, '')
  if (/^\/api\/(?:web-auth|mobile|agent-types)(?:\/|$)/.test(unscoped)) return false
  if (/^\/api(?:\/|$)/.test(unscoped)) return true
  if (method !== 'GET' && method !== 'HEAD') return false
  return /^\/(?:host\/)?v1\/query(?:\/|$)/.test(unscoped)
    || unscoped === '/nodes/v1'
}

export function mobileResourcePath(path: string): boolean {
  const unscoped = path.replace(/^\/projects\/[^/]+(?=\/)/, '')
  return unscoped === '/api/media'
    || /^\/api\/(?:sessions|folders)\/[^/]+\/raw$/.test(unscoped)
    || /^\/api\/io\/runs\/[^/]+\/artifacts\/[^/]+$/.test(unscoped)
}

function bearer(request: Request): string {
  const authorization = request.headers.get('authorization') ?? ''
  return /^Bearer [A-Za-z0-9_-]{43}$/.test(authorization) ? authorization.slice(7) : ''
}

/** Remote UI access is separate from browser cookies, device trust and the launch credential. */
export class MobileAccess {
  private readonly codes = new Map<string, number>()
  private readonly sessions = new Map<string, MobileSession>()
  private readonly bridges = new Map<string, MobileSession>()
  private readonly tickets = new Map<string, ResourceTicket>()
  private attempts = 0
  private attemptWindow = 0
  readonly publicOrigin: string

  constructor(private readonly options: {
    publicOrigin: string
    allowLanHttp?: boolean
    launchCredential: string
    clientAddresses: GatewayClientAddressRegistry
    now?: () => number
  }) {
    this.publicOrigin = mobilePublicOrigin(options.publicOrigin, options.allowLanHttp)
    if (!options.launchCredential) throw new TypeError('Mobile access requires a Main launch credential')
  }

  private now(): number { return this.options.now?.() ?? Date.now() }

  private prune(): void {
    for (const [key, expiry] of this.codes) if (expiry <= this.now()) this.codes.delete(key)
    for (const session of this.sessions.values()) if (session.expiresAt <= this.now()) this.revoke(session)
    for (const [key, ticket] of this.tickets) if (ticket.expiresAt <= this.now()) this.tickets.delete(key)
  }

  private revoke(session: MobileSession): void {
    this.sessions.delete(session.accessHash)
    this.bridges.delete(digest(session.bridgeToken))
    for (const [key, ticket] of this.tickets) if (ticket.session === session) this.tickets.delete(key)
    clearTimeout(session.timer)
    session.controller.abort(new Error('Mobile session ended'))
  }

  authorizeMain(request: Request): boolean {
    this.prune()
    return businessPath(new URL(request.url).pathname, request.method)
      && this.bridges.has(digest(bearer(request)))
  }

  managementPlugin(): GatewayPlugin {
    return app => {
      app.use('/local/v1/mobile-*', async (c, next) => {
        c.header('Cache-Control', 'no-store')
        if (!isLoopbackGatewayRequest(c.req.raw, this.options.clientAddresses)
          || c.req.header('Origin') || c.req.header('Sec-Fetch-Site')
          || !await validateLaunchCredential(c.req.header('Authorization'), this.options.launchCredential)) {
          return c.json({ error: 'unauthorized' }, 401)
        }
        this.prune()
        await next()
      })
      app.post('/local/v1/mobile-pairing', c => {
        if (this.codes.size >= 32) return c.json({ error: 'pairing_capacity_reached' }, 429)
        const code = randomBytes(12).toString('hex').toUpperCase()
        const expiresAt = this.now() + CODE_TTL
        this.codes.set(digest(code), expiresAt)
        return c.json({ version: 1, url: this.publicOrigin, code: code.match(/.{4}/g)!.join('-'), expiresAt: new Date(expiresAt).toISOString() })
      })
      app.get('/local/v1/mobile-sessions', c => c.json({
        version: 1, sessions: [...this.sessions.values()].map(session => ({ id: session.id, expiresAt: new Date(session.expiresAt).toISOString() })),
      }))
      app.delete('/local/v1/mobile-sessions/:id', c => {
        const session = [...this.sessions.values()].find(session => session.id === c.req.param('id'))
        if (!session) return c.json({ error: 'session_not_found' }, 404)
        this.revoke(session)
        return c.body(null, 204)
      })
    }
  }

  createGateway(main: Hono): Hono {
    const app = new Hono()
    app.use('*', async (c, next) => {
      c.header('Cache-Control', 'no-store')
      c.header('Referrer-Policy', 'no-referrer')
      c.header('X-Content-Type-Options', 'nosniff')
      // HTTPS uses a loopback TLS proxy; explicit LAN HTTP also accepts private numeric TCP peers.
      const peer = this.options.clientAddresses.resolve(c.req.raw)
      const host = peer.slice(4).replace(/^::ffff:/, '')
      const lanPeer = this.options.allowLanHttp && this.publicOrigin.startsWith('http:') && peer.startsWith('tcp:') && isLanHttpHost(host.includes(':') ? `[${host}]` : host)
      if (!lanPeer && !['tcp:127.0.0.1', 'tcp:::1', 'tcp:::ffff:127.0.0.1'].includes(peer)) {
        return c.json({ error: 'loopback_proxy_required' }, 403)
      }
      if (c.req.header('Upgrade')) return c.json({ error: 'mobile_websocket_not_supported' }, 400)
      const origin = c.req.header('Origin')
      if (origin && !NATIVE_ORIGINS.has(origin)) return c.json({ error: 'origin_not_allowed' }, 403)
      if (origin) {
        c.header('Access-Control-Allow-Origin', origin)
        c.header('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges')
        c.header('Vary', 'Origin')
      }
      if (c.req.method === 'OPTIONS') {
        const method = c.req.header('Access-Control-Request-Method') ?? ''
        const headers = (c.req.header('Access-Control-Request-Headers') ?? '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean)
        if (!origin || !METHODS.includes(method) || headers.some(header => !HEADERS.includes(header))) {
          return c.json({ error: 'preflight_not_allowed' }, 403)
        }
        c.header('Access-Control-Allow-Methods', METHODS.join(', '))
        c.header('Access-Control-Allow-Headers', HEADERS.join(', '))
        return c.body(null, 204)
      }
      if (!METHODS.includes(c.req.method)) return c.json({ error: 'method_not_allowed' }, 405)
      this.prune()
      await next()
      c.header('Cache-Control', 'no-store')
      c.header('Referrer-Policy', 'no-referrer')
      c.header('X-Content-Type-Options', 'nosniff')
      if (origin) {
        c.header('Access-Control-Allow-Origin', origin)
        c.header('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges')
        c.header('Vary', 'Origin')
      }
    })
    app.use('/mobile/v1/*', bodyLimit({ maxSize: 8192, onError: c => c.json({ error: 'body_too_large' }, 413) }))
    app.post('/mobile/v1/pair', async c => {
      if (this.now() - this.attemptWindow >= 60_000) { this.attemptWindow = this.now(); this.attempts = 0 }
      if (++this.attempts > 20) return c.json({ error: 'pairing_rate_limited' }, 429, { 'Retry-After': '60' })
      const body = await readObject(c.req.raw)
      if (!body || Object.keys(body).length !== 1 || typeof body.code !== 'string'
        || !/^[A-Fa-f0-9-]{24,29}$/.test(body.code)) return c.json({ error: 'invalid_pairing_request' }, 400)
      const key = digest(body.code.replaceAll('-', '').toUpperCase())
      if (!this.codes.has(key)) return c.json({ error: 'invalid_pairing_code' }, 401)
      if (this.sessions.size >= 32) return c.json({ error: 'session_capacity_reached' }, 429)
      this.codes.delete(key)
      const accessToken = secret()
      const expiresAt = this.now() + SESSION_TTL
      const session: MobileSession = {
        id: randomUUID(), accessHash: digest(accessToken), bridgeToken: secret(), expiresAt,
        controller: new AbortController(), timer: setTimeout(() => this.revoke(session), SESSION_TTL),
      }
      session.timer.unref()
      this.sessions.set(session.accessHash, session)
      this.bridges.set(digest(session.bridgeToken), session)
      return c.json({ version: 1, accessToken, expiresAt: new Date(expiresAt).toISOString() })
    })
    app.get('/mobile/v1/session', c => {
      const session = this.sessions.get(digest(bearer(c.req.raw)))
      return session
        ? c.json({ version: 1, authenticated: true, expiresAt: new Date(session.expiresAt).toISOString() })
        : c.json({ error: 'unauthorized' }, 401)
    })
    app.delete('/mobile/v1/session', c => {
      const session = this.sessions.get(digest(bearer(c.req.raw)))
      if (!session) return c.json({ error: 'unauthorized' }, 401)
      this.revoke(session)
      return c.body(null, 204)
    })
    app.post('/mobile/v1/resource-ticket', async c => {
      const session = this.sessions.get(digest(bearer(c.req.raw)))
      if (!session) return c.json({ error: 'unauthorized' }, 401)
      const body = await readObject(c.req.raw)
      if (!body || Object.keys(body).length !== 1 || typeof body.path !== 'string' || body.path.length > 4096
        || !body.path.startsWith('/') || body.path.startsWith('//') || body.path.includes('\\')) {
        return c.json({ error: 'invalid_resource_path' }, 400)
      }
      const url = new URL(body.path, this.publicOrigin)
      if (url.origin !== this.publicOrigin || url.hash || url.searchParams.has('ticket')
        || !mobileResourcePath(url.pathname)) return c.json({ error: 'resource_not_allowed' }, 403)
      if ([...this.tickets.values()].filter(ticket => ticket.session === session).length >= 512) {
        return c.json({ error: 'ticket_capacity_reached' }, 429)
      }
      const token = secret()
      const expiresAt = Math.min(this.now() + TICKET_TTL, session.expiresAt)
      url.search = url.searchParams.toString()
      this.tickets.set(digest(token), { session, path: `${url.pathname}${url.search}`, expiresAt })
      url.searchParams.set('ticket', token)
      return c.json({ version: 1, url: url.href, expiresAt: new Date(expiresAt).toISOString() })
    })
    app.all('*', async c => {
      const url = new URL(c.req.url)
      if (!businessPath(url.pathname, c.req.method)) return c.json({ error: 'mobile_route_not_allowed' }, 403)
      const resourceRequest = mobileResourcePath(url.pathname)
      let session = this.sessions.get(digest(bearer(c.req.raw)))
      if (url.searchParams.has('ticket')) {
        if (session || !['GET', 'HEAD'].includes(c.req.method) || url.searchParams.getAll('ticket').length !== 1) {
          return c.json({ error: 'invalid_resource_ticket' }, 401)
        }
        const ticket = this.tickets.get(digest(url.searchParams.get('ticket')!))
        url.searchParams.delete('ticket')
        if (ticket && ticket.path === `${url.pathname}${url.search}`) session = ticket.session
      }
      if (!session) return c.json({ error: 'unauthorized' }, 401)
      const headers = new Headers(c.req.raw.headers)
      for (const name of ['origin', 'cookie', 'host', 'authorization', 'forwarded', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-for']) headers.delete(name)
      headers.set('Authorization', `Bearer ${session.bridgeToken}`)
      const request = new Request(url, new Request(c.req.raw, {
        headers, signal: AbortSignal.any([c.req.raw.signal, session.controller.signal]),
      }))
      const response = await main.fetch(request)
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel()
        return c.json({ error: 'mobile_redirect_not_allowed' }, 502)
      }
      const responseHeaders = new Headers(response.headers)
      responseHeaders.delete('set-cookie')
      responseHeaders.set('Cache-Control', 'no-store')
      responseHeaders.set('Referrer-Policy', 'no-referrer')
      if (resourceRequest) responseHeaders.set('Content-Security-Policy', "sandbox; default-src 'none'")
      return new Response(response.body, { status: response.status, headers: responseHeaders })
    })
    return app
  }

  close(): void {
    this.codes.clear()
    for (const session of this.sessions.values()) this.revoke(session)
    this.tickets.clear()
  }
}

async function readObject(request: Request): Promise<Record<string, unknown> | undefined> {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return
  try {
    const body: unknown = await request.json()
    return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : undefined
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    return
  }
}
