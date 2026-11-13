import WebSocket from 'ws'
import { createForwardDiagnostics } from './forward-diagnostic.ts'
import { compress } from 'hono/compress'
import { ChildMicroApps } from './child-microapps.ts'
import { upgradeGatewayWebSocket } from '../gateway/websocket.ts'
import { bridgeSockets } from '../gateway/socket-bridge.ts'
import { DEVICE_UI_CHALLENGE, DEVICE_UI_REQUEST, DEVICE_UI_HMR, deviceUiHeaders, deviceUiRequestPath, deviceUiResourcePath } from '../cluster/device-ui.ts'
import { DeviceApprovalUnavailableError, DeviceChallengeRequestError } from '../cluster/device-challenge-client.ts'
import type { GatewayPlugin } from '../gateway/types.ts'
import { previewContext } from '../gateway/html-preview.ts'

/** Loopback renderer admission is enforced by ChildLocalControl before this proxy. */
export function childWorkspacePlugin(options: {
  endpoint: string
  proof: (signal: AbortSignal, path: string) => Promise<string>
  fetch?: typeof fetch
}): GatewayPlugin & { close(): Promise<void> } {
  const diagnostics = createForwardDiagnostics('child')
  const microApps = new ChildMicroApps()
  const compressHistory = compress({ encoding: 'gzip' })
  // Upstream fetch decodes the tunnel response. Negotiate the last loopback hop
  // independently; do not compress realtime or binary/range media responses.
  const plugin: GatewayPlugin = app => app.all('*', async (c, next) => {
    if (c.req.method === 'GET' && /^\/(?:projects\/[^/]+\/)?api\/(?:chat\/session|sessions\/summary)$/.test(c.req.path)) {
      return compressHistory(c, next)
    }
    return next()
  }, async c => {
    const url = new URL(c.req.url)
    const path = `${url.pathname}${url.search}`
    if (!deviceUiRequestPath(path, c.req.method)) return c.json({ error: 'not_found' }, 404)
    const diagnostic = diagnostics(path)
    let stage = 'challenge'
    try {
      const proof = await options.proof(AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(8000)]), DEVICE_UI_CHALLENGE)
      diagnostic?.proofReady()
      stage = 'request'
      // Match execution/challenge routing when a device endpoint is mounted under a proxy prefix.
      const endpoint = new URL(options.endpoint)
      endpoint.pathname = endpoint.pathname.replace(/\/+$/, '') + DEVICE_UI_REQUEST
      endpoint.search = ''; endpoint.hash = ''
      const headers = deviceUiHeaders(c.req.raw.headers)
      headers.set('X-Shadow-Device-Proof', proof)
      headers.set('X-Shadow-Ui-Path', path)
      headers.set('X-Shadow-Ui-Method', c.req.method)
      // Older Child versions forwarded fetch-decoded bodies with wire headers.
      // Main must only send compressed inner responses to clients declaring
      // that they can normalize those headers and negotiate the last hop.
      headers.set('X-Shadow-Ui-Compression', 'decoded-v1')
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
      if (response.ok && c.req.method === 'POST' && /^\/(?:projects\/[^/]+\/)?api\/(?:folders\/[^/]+|sessions\/[^/]+(?:\/workspace)?)\/html-preview$/.test(url.pathname)) {
        const context = previewContext.getStore()
        if (!context) { await response.body?.cancel(); return c.json({ error: 'preview_unavailable' }, 503) }
        const value: unknown = await response.json()
        // importRelay validates this untrusted response before either callback
        // can run. Never forward a path supplied by a preview GET verbatim.
        const upstream = value as { url: string; revokeUrl: string }
        const forwardLease = async (path: string, method: string, signal: AbortSignal) => {
          const proof = await options.proof(AbortSignal.any([signal, AbortSignal.timeout(8000)]), DEVICE_UI_CHALLENGE)
          return (options.fetch ?? fetch)(endpoint, { method: 'POST', redirect: 'error', signal,
            headers: { 'X-Shadow-Device-Proof': proof, 'X-Shadow-Ui-Path': path, 'X-Shadow-Ui-Method': method },
          })
        }
        const lease = context.store.importRelay(value, context.origin,
          (suffix, method, signal) => forwardLease(upstream.url.slice(0, upstream.url.lastIndexOf('/') + 1) + suffix, method, signal),
          async () => { const result = await forwardLease(upstream.revokeUrl, 'DELETE', AbortSignal.timeout(8000)); await result.body?.cancel() }, context.owner)
        return c.json(lease)
      }
      const appAction = /^\/(?:projects\/[a-zA-Z0-9_-]+\/)?api\/microapps\/[0-9a-f-]{36}\/(open|stop|revoke)$/.exec(url.pathname)
      if (response.ok && c.req.method === 'POST' && appAction) {
        const appPath = url.pathname.slice(0, url.pathname.lastIndexOf('/'))
        if (appAction[1] === 'open') {
          const value: unknown = await response.json()
          return c.json(await microApps.open(appPath, value, async (path, body, signal) => {
            const proof = await options.proof(AbortSignal.any([signal, AbortSignal.timeout(8000)]), DEVICE_UI_CHALLENGE)
            return (options.fetch ?? fetch)(endpoint, { method: 'POST', redirect: 'error', signal,
              headers: { 'Content-Type': 'application/json', 'X-Shadow-Device-Proof': proof, 'X-Shadow-Ui-Path': path, 'X-Shadow-Ui-Method': 'POST' }, body: JSON.stringify(body) })
          }))
        }
        await microApps.stop(appPath)
      }
      // Node fetch transparently decodes gzip/deflate/br but retains wire headers.
      // Do not label decoded bytes as compressed (or keep their encoded length).
      // The transport's chunk framing is hop-by-hop, not part of this response.
      const responseHeaders = new Headers(response.headers)
      responseHeaders.delete('transfer-encoding')
      const encoding = responseHeaders.get('content-encoding')
      if (encoding && encoding.split(',').every(value => ['gzip', 'x-gzip', 'deflate', 'br'].includes(value.trim().toLowerCase()))) {
        responseHeaders.delete('content-encoding')
        responseHeaders.delete('content-length')
      }
      // Fetch headers are immutable; the local gateway must still add its CORS headers.
      const forwarded = new Response(response.body, {
        status: response.status, statusText: response.statusText, headers: responseHeaders,
      })
      return diagnostic?.response(forwarded, c.req.raw.signal) ?? forwarded
    } catch (error) {
      diagnostic?.fail(c.req.raw.signal)
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
  return Object.assign(plugin, { close: () => microApps.close() })
}
