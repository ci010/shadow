import { DEVICE_UI_CHALLENGE, DEVICE_UI_REQUEST, deviceUiHeaders, deviceUiPath } from '../cluster/device-ui.ts'
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
    if (!deviceUiPath(path)) return c.json({ error: 'not_found' }, 404)
    try {
      const proof = await options.proof(AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(8000)]), DEVICE_UI_CHALLENGE)
      const endpoint = new URL(DEVICE_UI_REQUEST, options.endpoint)
      const headers = deviceUiHeaders(c.req.raw.headers)
      headers.set('X-Shadow-Device-Proof', proof)
      headers.set('X-Shadow-Ui-Path', path)
      headers.set('X-Shadow-Ui-Method', c.req.method)
      return await (options.fetch ?? fetch)(endpoint, {
        method: 'POST', headers, redirect: 'error', signal: c.req.raw.signal,
        ...(!['GET', 'HEAD'].includes(c.req.method) ? { body: c.req.raw.body, duplex: 'half' } : {}),
      } as RequestInit)
    } catch {
      return c.json({ error: 'main_workspace_unavailable', message: 'Main workspace is offline or this Child is not approved. Retry when Main is available.' }, 503, { 'Cache-Control': 'no-store' })
    }
  })
}
