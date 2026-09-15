import type { GatewayPlugin } from '../gateway/types.ts'
import { redactConfig } from '../config/store.ts'
import type { OrganizationConfigStore } from './config-store.ts'

const fields = ['model', 'quickModel', 'temperature', 'thinking', 'reasoningEffort'] as const
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

export function organizationConfigPlugin(store: OrganizationConfigStore): GatewayPlugin {
  const defaults = () => Object.fromEntries(fields.map(field => [field, store.current().agent[field]]))
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
      if (modelDefaults && Object.keys(body).some(key => !fields.some(field => field === key))) {
        return c.json({ error: 'invalid_model_defaults' }, 400)
      }
      try {
        const patch = body
        await store.update(raw => modelDefaults
          ? { ...raw, agent: { ...(object(raw.agent) ? raw.agent : {}), ...patch } } : patch, c.req.raw.signal)
        return c.json(modelDefaults ? defaults() : redactConfig(await store.read()) as Record<string, unknown>)
      } catch (error) {
        if (error instanceof TypeError) return c.json({ error: 'invalid_configuration', message: error.message }, 400)
        if (error instanceof Error && error.name === 'ZodError') return c.json({ error: 'invalid_configuration' }, 400)
        console.error('[organizations] Configuration could not be saved or activated')
        return c.json({ error: 'configuration_update_failed' }, 500)
      }
    })
  }
}
