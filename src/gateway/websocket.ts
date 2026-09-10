import { createNodeWebSocket } from '@hono/node-ws'
import type { Context, Hono } from 'hono'
import type { IncomingMessage } from 'node:http'
import type { WebSocket } from 'ws'

const adapters = new WeakMap<Hono, ReturnType<typeof createNodeWebSocket>>()
const protocols = new WeakMap<IncomingMessage, string>()

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
