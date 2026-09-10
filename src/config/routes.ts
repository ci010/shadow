import type { Hono } from 'hono'
import { readFile, writeFile } from 'node:fs/promises'
import type { GatewayPlugin } from '../gateway/types.ts'
import { resolveConfigPath } from './loader.ts'
import { type Config, ConfigSchema } from './schema.ts'

export interface ConfigPluginOptions {
  configPath?: string
  /** Called after a successful PATCH with the validated config. */
  onChanged?: (config: Config) => void
}

/**
 * Gateway plugin that exposes bot.config.json for reading and editing.
 *
 * - `GET  /api/config` — returns the raw JSON file content
 * - `PATCH /api/config` — validates, writes, and returns the updated config
 */
export function configPlugin(opts?: ConfigPluginOptions | string): GatewayPlugin {
  // Backwards-compatible: accept a plain string (config path) or options object
  const { configPath, onChanged } = typeof opts === 'string'
    ? { configPath: opts, onChanged: undefined }
    : (opts ?? {})

  return (app: Hono) => {
    app.get('/api/config', async (c) => {
      const path = configPath ?? await resolveConfigPath()
      if (!path) {
        return c.json({ error: 'No config file found' }, 404)
      }
      const content = await readFile(path, 'utf8')
      return c.json(JSON.parse(content))
    })

    app.patch('/api/config', async (c) => {
      const path = configPath ?? await resolveConfigPath()
      if (!path) {
        return c.json({ error: 'No config file found' }, 404)
      }

      const body = await c.req.json()

      // Validate against schema (strip env-only fields that aren't in the file)
      const result = ConfigSchema.safeParse(body)
      if (!result.success) {
        return c.json({
          error: 'Validation failed',
          issues: result.error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        }, 400)
      }

      await writeFile(path, JSON.stringify(body, null, 2) + '\n')

      if (onChanged) {
        try { onChanged(result.data) } catch (err) {
          console.warn('[config] onChanged callback failed:', err)
        }
      }

      return c.json(body)
    })
  }
}
