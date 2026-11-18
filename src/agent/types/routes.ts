import type { AgentTypesManager } from './manager.ts'
import { isSelectableAgentType } from './types.ts'
import type { SessionManager } from '../../sessions/session-manager.ts'
import type { GatewayPlugin } from '../../gateway/types.ts'

export function agentTypesPlugin(
  sessions: SessionManager | undefined,
  agentTypes?: AgentTypesManager,
  authorizeDefinition?: (request: Request) => boolean | Promise<boolean>,
): GatewayPlugin {
  return (app) => {
    // ── /api/agent-types — list all agent type definitions ─────
    app.get('/api/agent-types', async (c) => {
      if (!agentTypes) {
        return c.json({ error: 'agent_types_unavailable' }, 501)
      }
      const definition = c.req.query('definition')
      if (definition !== undefined) {
        c.header('Cache-Control', 'no-store')
        if (!await authorizeDefinition?.(c.req.raw)) return c.json({ error: 'Unauthorized' }, 401)
      }
      const view = c.req.query('view')
      const knowledge = view === 'knowledge'
      const indexOnly = definition === undefined && (view === 'index' || knowledge)
      const types = (knowledge ? agentTypes.knowledgeDefinitions() : agentTypes.all()).filter(t => isSelectableAgentType(t) && (definition === undefined || definition === t.name)).map((t) => ({
        name: t.name,
        description: t.description,
        prompt: indexOnly ? undefined : t.prompt,
        definitionMarkdown: definition !== undefined ? t.definitionMarkdown : undefined,
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

    // ── /api/agent-types/:name/context — fully assembled prompt + tools ──
    app.get('/api/agent-types/:name/context', async (c) => {
      if (!sessions) {
        return c.json({ error: 'sessions_unavailable' }, 501)
      }
      const name = decodeURIComponent(c.req.param('name'))
      const channel = c.req.query('channel') ?? 'debug'
      const requestedPreview = c.req.query('rolePreview')
      // Older Knowledge clients only send channel=web. Select the same preview
      // server-side for authenticated requests, without widening role visibility.
      if (channel === 'web' || requestedPreview !== undefined) c.header('Cache-Control', 'no-store')
      if (requestedPreview !== undefined && (requestedPreview !== 'owner-web' || channel !== 'web')) {
        return c.json({ error: 'invalid_role_preview' }, 400)
      }
      const authorizedWeb = channel === 'web' && await authorizeDefinition?.(c.req.raw)
      if (requestedPreview && !authorizedWeb) return c.json({ error: 'Unauthorized' }, 401)
      const visibleRole = authorizedWeb && agentTypes?.knowledgeDefinitions().some(type => type.name === name && isSelectableAgentType(type))
      if (requestedPreview && !visibleRole) return c.json({ error: 'agent_type_not_found', name }, 404)
      const rolePreview = visibleRole ? 'owner-web' : undefined
      const result = await sessions.getContext({ agentType: name, channel, rolePreview })
      if (!result) {
        return c.json({ error: 'agent_type_not_found', name }, 404)
      }
      return c.json(result)
    })

  }
}
