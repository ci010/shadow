import { z } from 'zod'
import type { GatewayPlugin } from '../gateway/types.ts'
import type { AppProviderConfigStore } from '../projects/config-store.ts'
import type { Config } from './schema.ts'

const CompactionSettings = z.object({ compactV2: z.boolean() }).strict()

export function appCompactionPlugin(store: AppProviderConfigStore, getConfig: () => Config): GatewayPlugin {
  return app => {
    app.get('/api/app/compaction', c => {
      c.header('Cache-Control', 'no-store')
      return c.json({ compactV2: getConfig().agent.compactV2 })
    })
    app.patch('/api/app/compaction', async c => {
      c.header('Cache-Control', 'no-store')
      let body: unknown
      try { body = await c.req.json() }
      catch { return c.json({ error: 'invalid_json' }, 400) }
      const patch = CompactionSettings.safeParse(body)
      if (!patch.success) return c.json({ error: 'invalid_compaction_settings' }, 400)
      try {
        const config = await store.updateCompactV2(patch.data.compactV2, c.req.raw.signal)
        return c.json({ compactV2: config.agent.compactV2 })
      } catch {
        return c.json({ error: 'configuration_update_failed' }, 500)
      }
    })
  }
}
