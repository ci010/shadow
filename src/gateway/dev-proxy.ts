/**
 * Dev-mode reverse proxy: forwards unmatched (non-backend) requests to a
 * running Vite dev server so users only need to know about the gateway port.
 *
 * Handles both HTTP and the HMR WebSocket upgrade. Backend route prefixes
 * (/api/, /v1/, /debug/, /eval/, /wechat/, /feishu/) are NOT proxied so the
 * real backend handlers still own them.
 *
 * Register this plugin LAST (like `uiPlugin`) so its catch-all `*` route
 * does not shadow API routes.
 */

import type { Hono } from 'hono'
import type { WebSocket as ServerWebSocket } from 'ws'
import type { GatewayPlugin } from './types.ts'
import { upgradeGatewayWebSocket } from './websocket.ts'
import { isBackendPath } from './route-kind.ts'

/** Pipe a websocket pair in both directions until either side closes. */
function bridgeWebSockets(client: ServerWebSocket, upstream: WebSocket): void {
  upstream.binaryType = 'arraybuffer'
  const pending: Array<string | ArrayBuffer> = []
  client.on('message', (data, binary) => {
    const bytes = Array.isArray(data)
      ? Buffer.concat(data)
      : data instanceof ArrayBuffer ? Buffer.from(data) : data
    const message = binary ? Uint8Array.from(bytes).buffer : bytes.toString('utf8')
    if (upstream.readyState === WebSocket.CONNECTING) pending.push(message)
    else if (upstream.readyState === WebSocket.OPEN) upstream.send(message)
  })
  upstream.addEventListener('open', () => {
    for (const message of pending.splice(0)) upstream.send(message)
  })
  upstream.addEventListener('message', ({ data }) => {
    if (client.readyState === WebSocket.OPEN) client.send(data)
  })
  client.once('close', () => upstream.close())
  client.once('error', (error) => {
    console.warn('[gateway] Client WebSocket error:', error.message)
    upstream.close()
  })
  upstream.addEventListener('close', () => client.close())
  upstream.addEventListener('error', () => {
    console.warn('[gateway] Upstream WebSocket connection failed')
    client.terminate()
  })
}

export function devProxyPlugin(target: string): GatewayPlugin {
  const targetUrl = new URL(target)
  console.info(`[gateway] Dev proxy: unmatched routes -> ${target}`)

  return (app: Hono) => {
    app.all('*', async (c) => {
      const url = new URL(c.req.url)
      if (isBackendPath(url.pathname)) return c.notFound()

      const upstreamHttp = new URL(url.pathname + url.search, targetUrl)

      // Read upgrade-related headers up front, while the request is still
      // readable, before the client can abort the HMR socket.
      let upgrade: string | undefined
      let wsProtocolHeader: string | undefined
      try {
        upgrade = c.req.header('upgrade')?.toLowerCase()
        wsProtocolHeader = c.req.header('sec-websocket-protocol')
      } catch {
        // Client already went away — nothing left to proxy.
        return c.body(null, 408)
      }

      // ── WebSocket upgrade (Vite HMR) ──
      if (upgrade === 'websocket') {
        const wsUrl = new URL(upstreamHttp)
        wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:'
        const protocols = wsProtocolHeader
          ?.split(',')
          .map((s) => s.trim())
          .filter(Boolean)

        try {
          return await upgradeGatewayWebSocket(
            app,
            c,
            (clientSocket) => {
              const upstreamSocket = new WebSocket(wsUrl, protocols)
              bridgeWebSockets(clientSocket, upstreamSocket)
            },
            protocols?.[0],
          )
        } catch (err) {
          return c.text(`WS upgrade failed: ${String(err)}`, 502)
        }
      }

      // ── HTTP proxy ──
      const headers = new Headers(c.req.raw.headers)
      headers.delete('host')
      headers.delete('connection')
      headers.delete('authorization')
      headers.delete('cookie')

      const hasBody = c.req.method !== 'GET' && c.req.method !== 'HEAD'
      const init: RequestInit & { duplex?: 'half' } = {
        method: c.req.method,
        headers,
        body: hasBody ? c.req.raw.body : undefined,
        redirect: 'manual',
      }
      if (hasBody) init.duplex = 'half'

      try {
        const res = await fetch(upstreamHttp.toString(), init)
        // Strip hop-by-hop headers that browsers must not see.
        const resHeaders = new Headers(res.headers)
        resHeaders.delete('connection')
        resHeaders.delete('transfer-encoding')
        return new Response(res.body, {
          status: res.status,
          statusText: res.statusText,
          headers: resHeaders,
        })
      } catch (err) {
        return c.text(
          `Dev proxy unreachable (${targetUrl.host}): ${String(err)}\n` +
            'Is `pnpm dev` running?',
          502,
        )
      }
    })
  }
}
