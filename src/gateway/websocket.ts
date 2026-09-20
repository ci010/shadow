import { createNodeWebSocket } from '@hono/node-ws'
import type { Context, Hono } from 'hono'
import { IncomingMessage } from 'node:http'
import { TLSSocket } from 'node:tls'
import type { WebSocket } from 'ws'

const adapters = new WeakMap<Hono, ReturnType<typeof createNodeWebSocket>>()
const protocols = new WeakMap<IncomingMessage, string>()

export function normalizeGatewayUpgradeRequest(context: Context): void {
  const incoming: unknown = context.env?.incoming
  if (!(incoming instanceof IncomingMessage)
    || context.env.outgoing !== undefined
    || incoming.headers.upgrade?.toLowerCase() !== 'websocket') return
  const authority = incoming.headers.host
  if (!authority || /[\s/@?#\\]/.test(authority)) throw new TypeError('Invalid WebSocket Host')
  const origin = new URL(`${incoming.socket instanceof TLSSocket ? 'https:' : 'http:'}//${authority}`)
  const url = new URL(context.req.url)
  url.protocol = origin.protocol
  url.host = origin.host
  // node-ws otherwise routes upgrades through http://localhost, losing the signed audience.
  context.req.raw = new Request(url, context.req.raw)
}

export function gatewayWebSockets(app: Hono) {
  let adapter = adapters.get(app)
  if (!adapter) {
    adapter = createNodeWebSocket({ app })
    adapter.wss.options.handleProtocols = (offered, request) =>
      protocols.get(request) ?? offered.values().next().value ?? false
    adapters.set(app, adapter)
  }
  return adapter
}

export async function upgradeGatewayWebSocket(
  app: Hono,
  context: Context,
  onOpen: (socket: WebSocket) => void,
  protocol?: string,
): Promise<Response> {
  if (protocol) {
    const offered = context.req.header('sec-websocket-protocol')
      ?.split(',').map((value) => value.trim()) ?? []
    if (!offered.includes(protocol)) throw new Error('WebSocket protocol was not offered')
    protocols.set(context.env.incoming, protocol)
  }
  const response = await gatewayWebSockets(app).upgradeWebSocket(() => ({
    onOpen: (_event, socket) => {
      const signal = context.req.raw.signal
      const close = () => socket.raw?.close(1008, 'Session ended')
      if (signal.aborted) { close(); return }
      signal.addEventListener('abort', close, { once: true })
      socket.raw?.once('close', () => signal.removeEventListener('abort', close))
      try {
        onOpen(socket.raw!)
      } catch (error) {
        socket.raw?.terminate()
        throw error
      }
    },
  }))(context, async () => {})
  if (!(response instanceof Response)) throw new Error('WebSocket upgrade required')
  return response
}
