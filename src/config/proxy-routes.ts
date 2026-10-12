import { refreshBackendNetwork } from '../execution/network/backend.ts'
import { z } from 'zod'
import type { GatewayPlugin } from '../gateway/types.ts'
import type { AppProviderConfigStore } from '../projects/config-store.ts'
import type { Config } from './schema.ts'
import { localProxyConfiguration } from '../execution/network/proxy.ts'

export async function proxyStatus(enabled: boolean, detect = localProxyConfiguration) {
  try {
    const configuration = await detect(undefined, { detectOnly: true })
    // Configuration validation rejects credentials. Never return raw settings or detection errors.
    return { enabled, detected: configuration.source !== 'direct', source: configuration.source,
      http: configuration.http ?? '', https: configuration.https ?? '', detectionFailed: false }
  } catch {
    const environment = ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY'].some(key => process.env[key] !== undefined)
    return { enabled, detected: false, source: environment ? 'environment' as const : 'unknown' as const, http: '', https: '', detectionFailed: true }
  }
}

export function appProxyPlugin(store: AppProviderConfigStore, getConfig: () => Config): GatewayPlugin {
  return app => {
    app.get('/api/app/proxy', async c => {
      c.header('Cache-Control', 'no-store')
      return c.json(await proxyStatus(getConfig().network?.proxyEnabled ?? true))
    })
    app.post('/api/app/proxy/detect', async c => {
      c.header('Cache-Control', 'no-store')
      try { await refreshBackendNetwork() } catch { /* The previous working route is retained. */ }
      return c.json(await proxyStatus(getConfig().network?.proxyEnabled ?? true))
    })
    app.patch('/api/app/proxy', async c => {
      c.header('Cache-Control', 'no-store')
      let body: unknown
      try { body = await c.req.json() } catch { return c.json({ error: 'invalid_json' }, 400) }
      const parsed = z.object({ enabled: z.boolean() }).strict().safeParse(body)
      if (!parsed.success) return c.json({ error: 'invalid_proxy_settings' }, 400)
      try {
        const config = await store.updateProxy(parsed.data.enabled, c.req.raw.signal)
        return c.json(await proxyStatus(config.network?.proxyEnabled ?? true))
      } catch {
        return c.json({ error: 'proxy_update_failed' }, 500)
      }
    })
  }
}
