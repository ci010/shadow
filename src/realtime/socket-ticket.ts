import { randomUUID } from 'node:crypto'
import type { Context, Hono } from 'hono'

export const REALTIME_SOCKET_PATH = '/api/live/ws'
export const REALTIME_SOCKET_PROTOCOL = 'shadow.live.v1'

/** Issue an exact-audience, one-use upgrade ticket only after authenticated HTTP admission. */
export function registerRealtimeSocketTicket(app: Hono, access: {
  authorize(request: Request): boolean | Promise<boolean>
  probe?(request: Request): boolean | Promise<boolean>
  allowDirect?: boolean
  ownerSignal?(request: Request): AbortSignal | undefined
  upgrade(context: Context, owner: Request, signal?: AbortSignal, protocol?: string): Response | Promise<Response>
}) {
  const tickets = new Map<string, { origin: string | null; audience: string; expires: number; request: Request; signal?: AbortSignal }>()
  const now = () => performance.now()
  app.post(REALTIME_SOCKET_PATH, async c => {
    const request = c.req.raw
    if (!await access.authorize(request)) return c.json({ error: 'unauthorized' }, 401)
    if (access.probe && !await access.probe(request)) return c.json({ error: 'live_unavailable' }, 503)
    for (const [key, ticket] of tickets) if (ticket.expires <= now() || ticket.signal?.aborted) tickets.delete(key)
    if (tickets.size >= 256) return c.json({ error: 'live_ticket_capacity' }, 429)
    const proof = `ticket.${randomUUID()}`
    tickets.set(proof, { origin: request.headers.get('Origin'), audience: new URL(request.url).origin,
      expires: now() + 15_000, request, signal: access.ownerSignal?.(request) })
    return c.json({ protocol: REALTIME_SOCKET_PROTOCOL, proof }, 200, { 'Cache-Control': 'no-store' })
  })
  app.get(REALTIME_SOCKET_PATH, async c => {
    const request = c.req.raw
    const upgrade = c.req.header('Upgrade')?.toLowerCase() === 'websocket'
    const offered = (c.req.header('Sec-WebSocket-Protocol') ?? '').split(',').map(value => value.trim())
    const proof = offered.find(value => value.startsWith('ticket.'))
    if (upgrade && proof) {
      const ticket = tickets.get(proof)
      const origin = request.headers.get('Origin')
      const sameOrigin = ticket && (ticket.origin === origin || ((ticket.origin === null || ticket.origin === 'null') && origin === 'file://'))
      if (!ticket || ticket.expires <= now() || ticket.signal?.aborted || !offered.includes(REALTIME_SOCKET_PROTOCOL) ||
        !sameOrigin || ticket.audience !== new URL(request.url).origin) return c.json({ error: 'unauthorized' }, 401)
      tickets.delete(proof)
      return access.upgrade(c, ticket.request, ticket.signal, REALTIME_SOCKET_PROTOCOL)
    }
    if (!access.allowDirect || !await access.authorize(request)) return c.json({ error: 'unauthorized' }, 401)
    if (!upgrade) return c.json({ error: 'websocket_required' }, 426)
    return access.upgrade(c, request, request.signal)
  })
}
