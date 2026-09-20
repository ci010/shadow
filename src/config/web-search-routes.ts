import type { GatewayPlugin } from '../gateway/types.ts'
import type { AppProviderConfigStore } from '../projects/config-store.ts'
import type { Config } from './schema.ts'
import { WebSearchPatchSchema, webSearchStatus } from './web-search.ts'

export function appWebSearchPlugin(store: AppProviderConfigStore, getConfig: () => Config): GatewayPlugin {
  return app => {
    app.get('/api/app/web-search', c => {
      c.header('Cache-Control', 'no-store')
      return c.json(webSearchStatus(getConfig().tools))
    })
    app.patch('/api/app/web-search', async c => {
      c.header('Cache-Control', 'no-store')
      let body: unknown
      try { body = await c.req.json() }
      catch { return c.json({ error: 'invalid_json' }, 400) }
      const patch = WebSearchPatchSchema.safeParse(body)
      if (!patch.success) return c.json({ error: 'invalid_web_search_settings' }, 400)
      try {
        const config = await store.updateWebSearch(patch.data, c.req.raw.signal)
        return c.json(webSearchStatus(config.tools))
      } catch {
        console.error('[config] App web search settings could not be saved or activated')
        return c.json({ error: 'configuration_update_failed' }, 500)
      }
    })
  }
}
