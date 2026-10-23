import type { GatewayPlugin } from '../gateway/types.ts'
import type { AppProviderConfigStore } from '../projects/config-store.ts'
import { ModelDefaultsPatchSchema } from './model-defaults.ts'

export function appModelDefaultsPlugin(store: AppProviderConfigStore): GatewayPlugin {
  return app => {
    app.get('/api/app/model-defaults', async c => {
      c.header('Cache-Control', 'no-store')
      return c.json(await store.modelDefaults())
    })
    app.patch('/api/app/model-defaults', async c => {
      c.header('Cache-Control', 'no-store')
      let body: unknown
      try { body = await c.req.json() }
      catch { return c.json({ error: 'invalid_json' }, 400) }
      const patch = ModelDefaultsPatchSchema.safeParse(body)
      if (!patch.success) return c.json({ error: 'invalid_model_defaults' }, 400)
      try {
        await store.updateModelDefaults(patch.data, c.req.raw.signal)
        return c.json(await store.modelDefaults())
      } catch {
        console.error('[config] App model defaults could not be saved or activated')
        return c.json({ error: 'configuration_update_failed' }, 500)
      }
    })
  }
}
