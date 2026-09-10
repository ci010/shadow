import type { Hono } from 'hono'
import type { GatewayPlugin } from '../gateway/types.ts'
import { ConfigStore, redactConfig, type ConfigStoreOptions } from './store.ts'

export interface ConfigPluginOptions extends ConfigStoreOptions {
  store?: ConfigStore
}

/**
 * Gateway plugin that exposes bot.config.json for reading and editing.
 *
 * - `GET  /api/config` — returns configuration with credential placeholders
 * - `PATCH /api/config` — preserves placeholders, validates, writes and activates
 */
export function configPlugin(opts?: ConfigPluginOptions | string): GatewayPlugin {
  const options = typeof opts === 'string' ? { configPath: opts } : (opts ?? {})
  const store = options.store ?? new ConfigStore(options)

  return (app: Hono) => {
    app.get('/api/config', async (c) => {
      c.header('Cache-Control', 'no-store')
      try {
        return c.json(redactConfig(await store.read()) as Record<string, unknown>)
      } catch {
        return c.json({ error: 'Configuration could not be read.' }, 500)
      }
    })

    app.patch('/api/config', async (c) => {
      c.header('Cache-Control', 'no-store')
      let body: unknown
      try {
        body = await c.req.json()
      } catch {
        return c.json({ error: 'Invalid configuration JSON.' }, 400)
      }
      try {
        await store.update(() => body, c.req.raw.signal)
        return c.json(redactConfig(await store.read()) as Record<string, unknown>)
      } catch (error) {
        const validation = error instanceof Error && error.name === 'ZodError'
        return c.json({ error: validation ? 'Invalid configuration.' : 'Configuration could not be saved or activated.' }, validation ? 400 : 500)
      }
    })
  }
}
