import type { AgentTypesManager } from './manager.ts'
import type { SessionManager } from '../../sessions/session-manager.ts'
import type { GatewayPlugin } from '../../gateway/types.ts'

export function agentTypesPlugin(
  sessions: SessionManager | undefined,
  agentTypes?: AgentTypesManager,
): GatewayPlugin {
  return (app) => {
    // ── /debug/agent-types — list all agent type definitions ─────
    app.get('/debug/agent-types', (c) => {
      if (!agentTypes) {
        return c.json({ error: 'agent_types_unavailable' }, 501)
      }
      const types = agentTypes.all().map((t) => ({
        name: t.name,
        description: t.description,
        source: t.source,
        allowedTools: t.allowedTools,
        blockedTools: t.blockedTools,
        defaultMode: t.defaultMode,
        model: t.model,
        temperature: t.temperature,
        maxTokens: t.maxTokens,
      }))
      return c.json(types)
    })

    // ── /debug/agent-types/:name/context — fully assembled prompt + tools ──
    app.get('/debug/agent-types/:name/context', async (c) => {
      if (!sessions) {
        return c.json({ error: 'sessions_unavailable' }, 501)
      }
      const name = decodeURIComponent(c.req.param('name'))
      const channel = c.req.query('channel') ?? 'debug'
      const result = await sessions.getContext({ agentType: name, channel })
      if (!result) {
        return c.json({ error: 'agent_type_not_found', name }, 404)
      }
      return c.json(result)
    })

  }
}
