import { z } from 'zod'
import { builtinPromptDefault } from '../agent/context/prompt-version.ts'
import type { GatewayPlugin } from '../gateway/types.ts'
import type { AppProviderConfigStore } from '../projects/config-store.ts'
import { type Config } from './schema.ts'

export function appAgentVersionDefaultsPlugin(store: AppProviderConfigStore, getConfig: () => Config): GatewayPlugin {
  return app => {
    app.get('/api/app/agent-version-defaults', c => {
      c.header('Cache-Control', 'no-store')
      return c.json(builtinPromptDefault(getConfig().builtinPromptVersion))
    })
    app.patch('/api/app/agent-version-defaults', async c => {
      c.header('Cache-Control', 'no-store')
      let body: unknown
      try { body = await c.req.json() }
      catch { return c.json({ error: 'invalid_json' }, 400) }
      const patch = z.object({ version: z.enum(['v1', 'v2']) }).strict().safeParse(body)
      if (!patch.success) return c.json({ error: 'invalid_builtin_prompt_version' }, 400)
      if (builtinPromptDefault().source === 'environment') return c.json({ error: 'builtin_prompt_version_managed_by_environment' }, 409)
      try {
        const config = await store.updateBuiltinPromptVersion(patch.data.version, c.req.raw.signal)
        return c.json(builtinPromptDefault(config.builtinPromptVersion))
      } catch {
        return c.json({ error: 'configuration_update_failed' }, 500)
      }
    })
  }
}
