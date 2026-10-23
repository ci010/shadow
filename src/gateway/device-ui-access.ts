import { randomBytes, createHash } from 'node:crypto'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { MainCluster } from '../cluster/main-cluster.ts'
import { decodeDeviceChallengeProtocol } from '../cluster/device-challenge.ts'
import type { DeviceAuthenticationV1 } from '../cluster/registry.ts'
import { isBackendPath } from './route-kind.ts'

export const DEVICE_UI_PREFIX = '/cluster/v1/ui'
export function deviceUiAudience(value: string): string {
  const url = new URL(value)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = DEVICE_UI_PREFIX
  url.search = ''; url.hash = ''
  return url.href
}
export function deviceUiPath(path: string): boolean {
  if (!path.startsWith('/') || path.startsWith('//') || /[\\#]|%(?:2f|5c|2e)/i.test(path)) return false
  const pathname = new URL(path, 'http://main').pathname
  const local = pathname.replace(/^\/projects\/[^/]+(?=\/)/, '')
  return isBackendPath(pathname) && !/^\/(?:local|cluster)(?:\/|$)/.test(local)
    && !/^\/api\/(?:web-auth|mobile)(?:\/|$)/.test(local)
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
interface UiSession { authentication: DeviceAuthenticationV1; expiresAt: number; controller: AbortController; bridge: string }

/** Approved Child identities grant Main control. No UI credential reaches the renderer. */
export class DeviceUiAccess {
  private sessions = new Map<string, UiSession>()
  private bridges = new Map<string, UiSession>()
  private timer: ReturnType<typeof setInterval>
  constructor(private cluster: MainCluster) {
    this.timer = setInterval(() => { for (const session of this.sessions.values()) this.valid(session) }, 250)
    this.timer.unref()
  }
  private valid(session: UiSession | undefined): session is UiSession {
    if (!session) return false
    try {
      if (session.expiresAt <= Date.now()) throw new Error('expired')
      this.cluster.registry.authenticate(session.authentication)
      return true
    } catch { this.remove(session); return false }
  }
  private remove(session: UiSession) {
    session.controller.abort()
    this.bridges.delete(session.bridge)
    for (const [key, value] of this.sessions) if (value === session) this.sessions.delete(key)
  }
  revokeNode(nodeId: string) {
    for (const session of this.sessions.values()) if (session.authentication.nodeId === nodeId) this.remove(session)
  }
  authorizeMain(request: Request): boolean {
    const token = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? ''
    return this.valid(this.bridges.get(token))
  }
  close() { clearInterval(this.timer); for (const session of this.sessions.values()) this.remove(session) }
  createGateway(main: Hono): Hono {
    const app = new Hono()
    app.use('*', async (c, next) => {
      if (c.req.header('Origin') || c.req.header('Cookie')) return c.json({ error: 'browser_access_not_allowed' }, 403)
      await next()
    })
    app.use(`${DEVICE_UI_PREFIX}/challenges`, bodyLimit({ maxSize: 1024 }))
    app.post(`${DEVICE_UI_PREFIX}/challenges`, async c => {
      try {
        const auth = await c.req.json() as DeviceAuthenticationV1
        const challenge = this.cluster.authority.issue(auth, deviceUiAudience(c.req.url))
        return c.json(challenge, 201, { 'Cache-Control': 'no-store' })
      } catch { return c.json({ error: 'credential_not_available' }, 401) }
    })
    app.post(`${DEVICE_UI_PREFIX}/session`, async c => {
      const proof = decodeDeviceChallengeProtocol(c.req.header('Authorization')?.replace(/^Device /, '') ?? '')
      const auth = await this.cluster.authority.verify(proof, deviceUiAudience(c.req.url))
      if (!auth) return c.json({ error: 'unauthorized' }, 401)
      for (const session of this.sessions.values()) this.valid(session)
      if (this.sessions.size >= 128) return c.json({ error: 'session_capacity' }, 429)
      const token = randomBytes(32).toString('base64url')
      const session: UiSession = { authentication: auth, expiresAt: Date.now() + 300_000, controller: new AbortController(), bridge: randomBytes(32).toString('base64url') }
      this.sessions.set(digest(token), session); this.bridges.set(session.bridge, session)
      return c.json({ version: 1, token, expiresAt: session.expiresAt }, 201, { 'Cache-Control': 'no-store' })
    })
    app.all(`${DEVICE_UI_PREFIX}/proxy`, async c => {
      const token = c.req.header('Authorization')?.replace(/^Bearer /, '') ?? ''
      const session = this.sessions.get(digest(token))
      if (!this.valid(session)) return c.json({ error: 'unauthorized' }, 401)
      const path = c.req.query('path') ?? ''
      if (!deviceUiPath(path)) return c.json({ error: 'route_not_allowed' }, 403)
      const headers = new Headers(c.req.raw.headers)
      for (const name of ['host', 'cookie', 'origin', 'authorization', 'forwarded', 'x-forwarded-host', 'x-forwarded-for', 'x-forwarded-proto', 'connection', 'upgrade']) headers.delete(name)
      headers.set('Authorization', `Bearer ${session.bridge}`)
      const request = new Request(new URL(path, 'http://main.internal'), new Request(c.req.raw, {
        headers, signal: AbortSignal.any([c.req.raw.signal, session.controller.signal]),
      }))
      const response = await main.fetch(request)
      if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); return c.json({ error: 'redirect_not_allowed' }, 502) }
      const result = new Headers(response.headers)
      result.delete('set-cookie'); result.set('Cache-Control', 'no-store')
      return new Response(response.body, { status: response.status, headers: result })
    })
    return app
  }
}
