import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { boundedBody } from '../microapps/service.ts'
import { z } from 'zod'
import { MicroAppError } from '../microapps/contracts.ts'

const launch = z.object({ url: z.string(), revision: z.string().regex(/^[a-f0-9]{64}$/), runId: z.string().uuid(), expiresAt: z.string().datetime() })
const reply = z.object({ status: z.number().int().min(200).max(599), headers: z.record(z.string(), z.string()), body: z.string() })
export const CHILD_APP_LIMITS = { listeners: 16, requests: 16, bodyBytes: 16 * 1024 * 1024 } as const

type Relay = (path: string, body: unknown, signal: AbortSignal) => Promise<Response>

/** Each app run gets its own loopback origin. Only app tokens/tickets cross this boundary. */
export class ChildMicroApps {
  private entries = new Map<string, { runId: string; origin: string; server: ReturnType<typeof serve>; timer: ReturnType<typeof setTimeout> }>()
  private closed = false
  private activeRequests = 0
  private pending = new Map<string, Promise<unknown>>()
  private serialize<T>(path: string, operation: () => Promise<T>): Promise<T> {
    const next = (this.pending.get(path) ?? Promise.resolve()).catch(() => {}).then(operation)
    this.pending.set(path, next)
    void next.finally(() => { if (this.pending.get(path) === next) this.pending.delete(path) }).catch(() => {})
    return next
  }
  open(path: string, value: unknown, relay: Relay): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('Child stopped'))
    if (!this.entries.has(path) && !this.pending.has(path) && this.entries.size + this.pending.size >= CHILD_APP_LIMITS.listeners)
      return Promise.reject(new Error('Child app window limit reached; close an app before opening another'))
    return this.serialize(path, () => this.openRun(path, value, relay))
  }
  private async openRun(path: string, value: unknown, relay: Relay): Promise<unknown> {
    const input = launch.parse(value), remote = new URL(input.url)
    if (remote.protocol !== 'http:' || remote.hostname !== '127.0.0.1' || !remote.port || remote.username || remote.password
      || remote.pathname !== '/' || remote.search || !/^#shadow_ticket=[A-Za-z0-9_-]{43}$/.test(remote.hash)) throw new Error('Invalid app launch')
    if (this.closed) throw new Error('Child stopped')
    let entry = this.entries.get(path)
    if (entry?.runId !== input.runId) { await this.stopRun(path); entry = undefined }
    if (!entry) {
      let origin = ''
      const app = new Hono()
      app.all('*', async c => {
        if (c.req.header('host') !== new URL(origin).host || (c.req.header('origin') && c.req.header('origin') !== origin))
          return c.json({ error: 'origin_not_allowed' }, 403)
        if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(c.req.method)) return c.notFound()
        if (this.activeRequests >= CHILD_APP_LIMITS.requests) return c.json({ error: 'app_relay_busy' }, 429)
        this.activeRequests++
        try {
          const bytes = await boundedBody(c.req.raw, CHILD_APP_LIMITS.bodyBytes)
          const token = /^Bearer ([A-Za-z0-9_-]{1,256})$/.exec(c.req.header('authorization') ?? '')?.[1]
          const url = new URL(c.req.url)
          const response = await relay(`${path}/relay`, { revision: input.revision, runId: input.runId,
            path: url.pathname + url.search, method: c.req.method, token,
            contentType: c.req.header('content-type'), ...(bytes.length ? { body: Buffer.from(bytes).toString('base64') } : {}) }, c.req.raw.signal)
          if (!response.ok) { await response.body?.cancel(); return c.json({ error: 'app_relay_unavailable' }, 409) }
          const output = reply.parse(JSON.parse(Buffer.from(await boundedBody(response, 24 * 1024 * 1024)).toString('utf8')))
          const headers = new Headers({ 'Cache-Control': 'no-store' })
          for (const name of ['content-type', 'content-security-policy', 'referrer-policy', 'x-content-type-options']) {
            if (output.headers[name]) headers.set(name, output.headers[name])
          }
          return new Response(['HEAD'].includes(c.req.method) || [204, 205, 304].includes(output.status) ? null : Buffer.from(output.body, 'base64'), { status: output.status, headers })
        } catch (error) { return c.json({ error: error instanceof MicroAppError ? error.code : 'app_relay_unavailable' }, error instanceof MicroAppError ? error.status : 503) }
        finally { this.activeRequests-- }
      })
      const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 })
      if ('requestTimeout' in server) server.requestTimeout = 30_000
      if ('headersTimeout' in server) server.headersTimeout = 15_000
      await new Promise<void>((resolve, reject) => {
        if (server.listening) resolve(); else { server.once('listening', resolve); server.once('error', reject) }
      })
      const address = server.address()
      if (!address || typeof address === 'string') { server.close(); throw new Error('App relay unavailable') }
      origin = `http://127.0.0.1:${address.port}`
      const timer = setTimeout(() => { void this.stop(path) }, Math.max(0, Math.min(8 * 60 * 60 * 1000, Date.parse(input.expiresAt) - Date.now())))
      timer.unref()
      entry = { runId: input.runId, origin, server, timer }
      if (this.closed) { server.close(); clearTimeout(timer); throw new Error('Child stopped') }
      this.entries.set(path, entry)
    }
    return { ...input, url: entry.origin + '/' + remote.hash }
  }
  stop(path: string): Promise<void> { return this.serialize(path, () => this.stopRun(path)) }
  private async stopRun(path: string) {
    const entry = this.entries.get(path)
    if (!entry) return
    this.entries.delete(path); clearTimeout(entry.timer)
    if ('closeAllConnections' in entry.server) entry.server.closeAllConnections()
    await new Promise<void>((resolve, reject) => entry.server.close(error => error ? reject(error) : resolve()))
  }
  async close() {
    this.closed = true
    await Promise.allSettled([...this.pending.values()])
    await Promise.all([...this.entries.keys()].map(path => this.stop(path)))
  }
}
