import WebSocket from 'ws'
import { upgradeGatewayWebSocket } from '../gateway/websocket.ts'
import { bridgeSockets } from '../gateway/socket-bridge.ts'
import { DEVICE_UI_CHALLENGE, DEVICE_UI_REQUEST, DEVICE_UI_HMR, deviceUiHeaders, deviceUiRequestPath, deviceUiResourcePath } from '../cluster/device-ui.ts'
import { DeviceApprovalUnavailableError, DeviceChallengeRequestError } from '../cluster/device-challenge-client.ts'
import type { GatewayPlugin } from '../gateway/types.ts'

/** Loopback renderer admission is enforced by ChildLocalControl before this proxy. */
export function childWorkspacePlugin(options: {
  endpoint: string
  proof: (signal: AbortSignal, path: string) => Promise<string>
  fetch?: typeof fetch
}): GatewayPlugin {
  return app => app.all('*', async c => {
    const url = new URL(c.req.url)
    const path = `${url.pathname}${url.search}`
    if (!deviceUiRequestPath(path, c.req.method)) return c.json({ error: 'not_found' }, 404)
    let stage = 'challenge'
    try {
      const proof = await options.proof(AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(8000)]), DEVICE_UI_CHALLENGE)
      stage = 'request'
      // Match execution/challenge routing when a device endpoint is mounted under a proxy prefix.
      const endpoint = new URL(options.endpoint)
      endpoint.pathname = endpoint.pathname.replace(/\/+$/, '') + DEVICE_UI_REQUEST
      endpoint.search = ''; endpoint.hash = ''
      const headers = deviceUiHeaders(c.req.raw.headers)
      headers.set('X-Shadow-Device-Proof', proof)
      headers.set('X-Shadow-Ui-Path', path)
      headers.set('X-Shadow-Ui-Method', c.req.method)
      if (c.req.header('upgrade')?.toLowerCase() === 'websocket') {
        if (!deviceUiResourcePath(path) || c.req.header('sec-websocket-protocol') !== 'vite-hmr') return c.notFound()
        endpoint.pathname = endpoint.pathname.slice(0, -DEVICE_UI_REQUEST.length) + DEVICE_UI_HMR
        endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:'
        return await upgradeGatewayWebSocket(app, c, socket => {
          bridgeSockets(socket, new WebSocket(endpoint, 'vite-hmr', {
            headers: { 'X-Shadow-Device-Proof': proof, 'X-Shadow-Ui-Path': path }, handshakeTimeout: 8000,
          }))
        }, 'vite-hmr')
      }

      const response = await (options.fetch ?? fetch)(endpoint, {
        method: 'POST', headers, redirect: 'error', signal: c.req.raw.signal,
        ...(!['GET', 'HEAD'].includes(c.req.method) ? { body: c.req.raw.body, duplex: 'half' } : {}),
      } as RequestInit)
      if (!response.ok) console.error('[child-workspace]', { stage, status: response.status })
      // Fetch headers are immutable; the local gateway must still add its CORS headers.
      return new Response(response.body, {
        status: response.status, statusText: response.statusText, headers: new Headers(response.headers),
      })
    } catch (error) {
      // Never log endpoint, proof, credentials, arbitrary exception messages or response bodies.
      const cause = error instanceof Error ? error.cause : undefined
      const transportCode = cause && typeof cause === 'object' && 'code' in cause ? cause.code : undefined
      const knownTransportCodes = ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']
      const code = error instanceof DeviceApprovalUnavailableError ? 'main_workspace_approval_unavailable'
        : error instanceof DeviceChallengeRequestError ? `main_workspace_challenge_http_${error.status}`
        : error instanceof Error && error.name === 'TimeoutError' ? 'main_workspace_timeout'
        : typeof transportCode === 'string' && knownTransportCodes.includes(transportCode) ? `main_workspace_${transportCode.toLowerCase()}`
        : 'main_workspace_unavailable'
      console.error('[child-workspace]', { stage, code })
      return c.json({ error: code, stage }, 503, { 'Cache-Control': 'no-store' })
    }
  })
}
