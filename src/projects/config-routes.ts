import type { GatewayPlugin } from '../gateway/types.ts'
import { redactConfig } from '../config/store.ts'
import type { ProjectConfigStore } from './config-store.ts'
import { ModelDefaultsPatchSchema } from '../config/model-defaults.ts'

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

export function projectConfigPlugin(store: ProjectConfigStore): GatewayPlugin {
  const defaults = () => store.modelDefaults()
  return app => {
    app.get('/api/config', async c => {
      c.header('Cache-Control', 'no-store')
      return c.json(redactConfig(await store.read()) as Record<string, unknown>)
    })
    app.get('/api/config/model-defaults', c => c.json(defaults()))
    app.on('PATCH', ['/api/config', '/api/config/model-defaults'], async c => {
      c.header('Cache-Control', 'no-store')
      let body: unknown
      try { body = await c.req.json() } catch { return c.json({ error: 'invalid_json' }, 400) }
      if (!object(body)) return c.json({ error: 'invalid_configuration' }, 400)
      const modelDefaults = c.req.path.endsWith('/model-defaults')
      try {
        const patch = body
        if (modelDefaults) await store.updateModelDefaults(ModelDefaultsPatchSchema.parse(patch), c.req.raw.signal)
        else await store.update(() => patch, c.req.raw.signal)
        return c.json(modelDefaults ? defaults() : redactConfig(await store.read()) as Record<string, unknown>)
      } catch (error) {
        if (error instanceof TypeError) return c.json({ error: 'invalid_configuration', message: error.message }, 400)
        if (error instanceof Error && error.name === 'ZodError') return c.json({ error: 'invalid_configuration' }, 400)
        console.error('[projects] Configuration could not be saved or activated')
        return c.json({ error: 'configuration_update_failed' }, 500)
      }
    })
  }
}
