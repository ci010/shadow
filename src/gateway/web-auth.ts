import { createHash, randomBytes } from 'node:crypto'
import { bodyLimit } from 'hono/body-limit'
import type { GatewayPlugin } from './types.ts'
import { type GatewayClientAddressRegistry, isLoopbackGatewayRequest, validateLaunchCredential } from './server.ts'
import { isBackendPath, isProjectPagePath } from './route-kind.ts'

const CODE_TTL = 5 * 60_000
const SESSION_TTL = 12 * 60 * 60_000
const MAX_CODES = 32
const MAX_SESSIONS = 128
const MAX_ATTEMPTS = 20

interface BrowserSession {
  origin: string
  expiresAt: number
  controller: AbortController
  timer: ReturnType<typeof setTimeout>
}

export interface BrowserSessionStatus {
  version: 1
  required: boolean
  authenticated: boolean
  expiresAt?: string
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function cookieName(request: Request): string {
  return `shadow_web_${new URL(request.url).port || 'default'}`
}

function cookieToken(request: Request): string {
  const name = cookieName(request)
  const values = (request.headers.get('cookie') ?? '').split(';').map(value => value.trim())
    .filter(value => value.startsWith(`${name}=`))
  if (values.length !== 1) return ''
  const value = values[0]!.slice(name.length + 1)
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : ''
}

function browserBusinessPath(path: string): boolean {
  const unscoped = path.replace(/^\/projects\/[^/]+(?=\/)/, '')
  return isBackendPath(path) && !/^\/(?:local|cluster|pair)(?:\/|$)/.test(unscoped)
}

/** Only frontend assets/pages are public; API and control prefixes never become SPA exemptions. */
export function isPublicWebShell(request: Request, development = false): boolean {
  if (!['GET', 'HEAD'].includes(request.method)) return false
  const path = new URL(request.url).pathname
  if (isBackendPath(path)) return false
  if (path === '/' || path === '/index.html' || path === '/favicon.png' || path === '/favicon.ico') return true
  if (path.startsWith('/assets/') || isProjectPagePath(path)) return true
  if (/^\/(?:chat(?:\/[^/]+)?|projects|workspaces|nodes|providers|approvals|settings(?:\/(?:channels|providers|models))?|agents(?:\/[^/]+)?|logs|spans)\/?$/.test(path)) return true
  return development && /^\/(?:@vite\/|@id\/|@fs\/|src\/|node_modules\/|hmr(?:\/|$))/.test(path)
}

export class BrowserAuth {
  private readonly codes = new Map<string, number>()
  private readonly sessions = new Map<string, BrowserSession>()
  private attempts = 0
  private attemptWindow = 0
  private readonly developmentOrigin?: string

  constructor(private readonly options: {
    launchCredential?: string
    clientAddresses: GatewayClientAddressRegistry
    developmentUrl?: string
    now?: () => number
  }) {
    this.developmentOrigin = options.developmentUrl ? new URL(options.developmentUrl).origin : undefined
  }

  private now(): number { return this.options.now?.() ?? Date.now() }

  private local(request: Request): boolean {
    return isLoopbackGatewayRequest(request, this.options.clientAddresses)
  }

  private browserOrigin(request: Request, requireOrigin = false): boolean {
    if (!this.local(request) || request.headers.get('sec-fetch-site') === 'cross-site') return false
    const origin = request.headers.get('origin')
    if (!origin) return !requireOrigin
    return origin === new URL(request.url).origin || origin === this.developmentOrigin
  }

  isAuthenticationRequest(request: Request): boolean {
    const path = new URL(request.url).pathname
    return path.startsWith('/api/web-auth/') || path === '/local/v1/web-pairing'
  }

  isPublicRequest(request: Request): boolean {
    const path = new URL(request.url).pathname
    return (request.method === 'GET' && path === '/api/web-auth/session')
      || (request.method === 'POST' && path === '/api/web-auth/pair')
      || (request.method === 'DELETE' && path === '/api/web-auth/session')
      || isPublicWebShell(request, !!this.developmentOrigin)
  }

  session(request: Request): BrowserSession | undefined {
    if (!browserBusinessPath(new URL(request.url).pathname)
      || !this.browserOrigin(request, !['GET', 'HEAD', 'OPTIONS'].includes(request.method))) return
    const session = this.sessions.get(hash(cookieToken(request)))
    if (!session || session.origin !== new URL(request.url).origin) return
    if (session.expiresAt <= this.now()) {
      this.revoke(request)
      return
    }
    return session
  }

  authorize(request: Request): boolean { return !!this.session(request) }

  status(request: Request): BrowserSessionStatus {
    const session = this.session(request)
    return {
      version: 1, required: !!this.options.launchCredential,
      authenticated: !this.options.launchCredential || !!session,
      ...(session ? { expiresAt: new Date(session.expiresAt).toISOString() } : {}),
    }
  }

  private revoke(request: Request): void {
    const key = hash(cookieToken(request))
    const session = this.sessions.get(key)
    if (!session) return
    this.sessions.delete(key)
    clearTimeout(session.timer)
    session.controller.abort(new Error('Browser session ended'))
  }

  private prune(): void {
    const now = this.now()
    for (const [key, expiresAt] of this.codes) if (expiresAt <= now) this.codes.delete(key)
    for (const [key, session] of this.sessions) {
      if (session.expiresAt > now) continue
      clearTimeout(session.timer)
      session.controller.abort(new Error('Browser session expired'))
      this.sessions.delete(key)
    }
  }

  private cookie(request: Request, token: string, maxAge: number): string {
    const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : ''
    return `${cookieName(request)}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`
  }

  plugin(): GatewayPlugin {
    return app => {
      app.use('/api/web-auth/*', async (c, next) => {
        c.header('Cache-Control', 'no-store')
        c.header('Referrer-Policy', 'no-referrer')
        if (!this.local(c.req.raw)) return c.json({ error: 'local_browser_required' }, 403)
        await next()
      })
      app.get('/api/web-auth/session', c => c.json(this.status(c.req.raw)))
      app.delete('/api/web-auth/session', c => {
        if (!this.browserOrigin(c.req.raw, true)) return c.json({ error: 'origin_not_allowed' }, 403)
        this.revoke(c.req.raw)
        c.header('Set-Cookie', this.cookie(c.req.raw, '', 0))
        return c.json(this.status(c.req.raw))
      })
      app.post('/local/v1/web-pairing', async c => {
        c.header('Cache-Control', 'no-store')
        if (!this.options.launchCredential) return c.json({ error: 'pairing_not_required' }, 409)
        if (!this.local(c.req.raw) || c.req.header('Origin') || c.req.header('Sec-Fetch-Site')
          || !await validateLaunchCredential(c.req.header('Authorization'), this.options.launchCredential)) {
          return c.json({ error: 'unauthorized' }, 401)
        }
        this.prune()
        if (this.codes.size >= MAX_CODES) return c.json({ error: 'pairing_capacity_reached' }, 429)
        const code = randomBytes(12).toString('hex').toUpperCase()
        const expiresAt = this.now() + CODE_TTL
        this.codes.set(hash(code), expiresAt)
        return c.json({
          version: 1, code: code.match(/.{4}/g)!.join('-'),
          expiresAt: new Date(expiresAt).toISOString(), url: `${new URL(c.req.url).origin}/`,
        })
      })
      const pairingBodyLimit = bodyLimit({
        maxSize: 1024, onError: c => c.json({ error: 'invalid_request' }, 413),
      })
      app.post('/api/web-auth/pair', async (c, next) => {
        const original = c.req.raw
        return pairingBodyLimit(c, async () => {
          this.options.clientAddresses.inherit(original, c.req.raw)
          await next()
        })
      }, async c => {
        if (!this.browserOrigin(c.req.raw, true)) return c.json({ error: 'origin_not_allowed' }, 403)
        if (!this.options.launchCredential) return c.json({ error: 'pairing_not_required' }, 409)
        const now = this.now()
        if (now - this.attemptWindow >= 60_000) { this.attemptWindow = now; this.attempts = 0 }
        if (++this.attempts > MAX_ATTEMPTS) {
          c.header('Retry-After', '60')
          return c.json({ error: 'pairing_rate_limited' }, 429)
        }
        if (c.req.header('content-type')?.split(';')[0]?.trim() !== 'application/json') {
          return c.json({ error: 'invalid_request' }, 400)
        }
        let body: unknown
        try { body = await c.req.json() }
        catch (error) {
          if (!(error instanceof SyntaxError)) throw error
          return c.json({ error: 'invalid_request' }, 400)
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)
          || Object.keys(body).length !== 1 || !('code' in body) || typeof body.code !== 'string') {
          return c.json({ error: 'invalid_request' }, 400)
        }
        const code = body.code.replace(/[\s-]/g, '').toUpperCase()
        this.prune()
        const key = hash(code)
        if (!/^[A-F0-9]{24}$/.test(code) || !this.codes.has(key)) {
          return c.json({ error: 'invalid_pairing_code' }, 401)
        }
        if (this.sessions.size >= MAX_SESSIONS) return c.json({ error: 'pairing_capacity_reached' }, 503)
        this.codes.delete(key)
        this.revoke(c.req.raw)
        const token = randomBytes(32).toString('base64url')
        const expiresAt = now + SESSION_TTL
        const controller = new AbortController()
        const sessionKey = hash(token)
        const timer = setTimeout(() => {
          this.sessions.delete(sessionKey)
          controller.abort(new Error('Browser session expired'))
        }, SESSION_TTL)
        timer.unref()
        this.sessions.set(sessionKey, { origin: new URL(c.req.url).origin, expiresAt, controller, timer })
        c.header('Set-Cookie', this.cookie(c.req.raw, token, SESSION_TTL / 1000))
        return c.json({ version: 1, required: true, authenticated: true, expiresAt: new Date(expiresAt).toISOString() })
      })
    }
  }

  close(): void {
    this.codes.clear()
    for (const session of this.sessions.values()) {
      clearTimeout(session.timer)
      session.controller.abort(new Error('Runtime stopped'))
    }
    this.sessions.clear()
  }
}
