import { BUILTIN_AGENT_VERSIONS, builtinAgentVersion } from '../agent/types/versions.ts'
import type { GatewayPlugin } from '../gateway/types.ts'
import type { AppProviderConfigStore } from '../projects/config-store.ts'
import { AgentVersionDefaultsSchema, type Config } from './schema.ts'

export function appAgentVersionDefaultsPlugin(store: AppProviderConfigStore, getConfig: () => Config): GatewayPlugin {
  const state = (config: Config) => ({ roles: BUILTIN_AGENT_VERSIONS.map(role => ({
    ...role, selectedVersion: builtinAgentVersion(role.role, config.agentVersionDefaults).version,
  })) })
  return app => {
    app.get('/api/app/agent-version-defaults', c => {
      c.header('Cache-Control', 'no-store')
      return c.json(state(getConfig()))
    })
    app.patch('/api/app/agent-version-defaults', async c => {
      c.header('Cache-Control', 'no-store')
      let body: unknown
      try { body = await c.req.json() }
      catch { return c.json({ error: 'invalid_json' }, 400) }
      const patch = AgentVersionDefaultsSchema.safeParse(body)
      if (!patch.success) return c.json({ error: 'invalid_agent_version_defaults' }, 400)
      try {
        return c.json(state(await store.updateAgentVersionDefaults(patch.data, c.req.raw.signal)))
      } catch {
        return c.json({ error: 'configuration_update_failed' }, 500)
      }
    })
  }
}
