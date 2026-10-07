import { z } from 'zod'
import { bodyLimit } from 'hono/body-limit'
import type { GatewayPlugin } from '../gateway/types.ts'
import type { DiscordIntegration } from './integration.ts'
import { IntegrationError, type IntegrationStore } from './integration-store.ts'
import { IntegrationChangeSchema, integrationConfigurationGuide, integrationToolNames, type DiscordIntegrationTransport } from './integration-contract.ts'
import type { BotInstanceStore } from './bot-store.ts'
import type { MemoryDomains } from '../memory/domains.ts'
import type { AgentTypesManager } from '../agent/types/manager.ts'
import type { SessionManager } from '../sessions/session-manager.ts'
import type { Tool } from '../tools/tool.ts'
import { MemoryAccessError } from '../memory/contracts.ts'
import { ChannelAdmissionError } from './base.ts'
import type { DiscordLearning } from './integration-learning.ts'

export function discordIntegrationPlugin(options: {
  store: IntegrationStore; runtime: DiscordIntegration; transport: DiscordIntegrationTransport
  bots: BotInstanceStore; memory: MemoryDomains; agents: AgentTypesManager; sessions: SessionManager
  learning?: DiscordLearning
  authorize: (request: Request) => boolean | Promise<boolean>
}): GatewayPlugin {
  const owner = { kind: 'owner', id: 'shadow-owner' } as const
  return app => {
    app.use('/api/integrations/*', async (c, next) => {
      c.header('Cache-Control', 'no-store')
      if (!await options.authorize(c.req.raw)) return c.json({ error: 'unauthorized' }, 401)
      await next()
    })
    app.use('/api/integrations/*', bodyLimit({ maxSize: 2 * 1024 * 1024,
      onError: c => c.json({ error: 'configuration_too_large' }, 413) }))
    app.on(['GET', 'POST'], [
      '/api/integrations/discord', '/api/integrations/discord/directory/:botId',
      '/api/integrations/discord/drafts', '/api/integrations/discord/drafts/:id/commit',
      '/api/integrations/discord/drafts/:id/cancel', '/api/integrations/discord/preview',
      '/api/integrations/discord/resources/:id',
      '/api/integrations/discord/members/:botId',
      '/api/integrations/discord/agents/:id/file',
    ], async c => {
      try {
        const path = c.req.path
        if (c.req.method === 'GET') {
          if (path.endsWith('/discord')) {
            return c.json({
              ...options.store.snapshot(), projectId: options.store.options.projectId,
              deploymentIssues: options.store.deploymentIssues(),
              learning: options.learning?.status() ?? [],
              domains: options.memory.domains(), tools: integrationToolNames,
              resources: options.memory.ownerResources(),
              templates: options.agents.all().filter(agent => !agent.root && agent.defaultMode === 'session')
                .map(agent => ({ name: agent.name, description: agent.description, prompt: agent.prompt, model: agent.model })),
              legacy: options.bots.list().filter(bot => bot.platform === 'discord').map(bot => ({
                botId: bot.id, legacySessionId: !!bot.legacySessionId,
                adminChats: Array.isArray(bot.config.adminChats) ? bot.config.adminChats : [],
                notice: 'Legacy trigger/admin settings do not grant channel access. Review explicit assignments. Existing IDs and history are preserved; legacy memory remains Project-private.',
              })),
              sessions: options.sessions.listSessions().flatMap(row => {
                const scope = options.sessions.getSessionState(row.sessionId)?.channelBoundary
                return scope ? [{ sessionId: row.sessionId, ...scope }] : []
              }),
            })
          }
          if (path.includes('/directory/')) {
            const input = z.object({ guildId: z.string().regex(/^[0-9]{1,20}$/).optional(),
              after: z.string().regex(/^[0-9]{1,20}$/).optional() }).strict().parse(c.req.query())
            return c.json({ ...await options.transport.directory(c.req.param('botId')!, input.guildId, input.after, c.req.raw.signal),
              botInstanceId: c.req.param('botId') })
          }
          if (path.includes('/members/')) {
            if (!options.transport.members) throw new IntegrationError('member_search_unavailable', 'Member search is not supported by this connection.', 503)
            const input = z.object({ guildId: z.string().regex(/^[0-9]{1,20}$/), query: z.string().trim().min(1).max(100) }).strict().parse(c.req.query())
            return c.json({ members: await options.transport.members(c.req.param('botId')!, input.guildId, input.query, c.req.raw.signal),
              notice: 'At most 25 matching members. Refine the name if your person is not shown.' })
          }
          if (path.includes('/resources/')) return c.json(options.memory.ownerRead(z.string().uuid().parse(c.req.param('id'))))
          if (path.includes('/agents/')) return c.json(options.store.ownerAgentFile(z.string().uuid().parse(c.req.param('id'))))
        } else {
          let raw: unknown
          try { raw = await c.req.json() } catch { return c.json({ error: 'invalid_json', message: 'Send valid JSON.' }, 400) }
          if (path.endsWith('/drafts')) {
            const input = z.object({ baseRevision: z.number().int().nonnegative(), change: IntegrationChangeSchema }).strict().parse(raw)
            return c.json(await options.store.propose(owner, input.change, input.baseRevision, c.req.raw.signal), 201)
          }
          if (path.endsWith('/commit')) {
            const input = z.object({ hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(raw)
            return c.json(await options.store.commit(owner, z.string().uuid().parse(c.req.param('id')), input.hash, c.req.raw.signal))
          }
          if (path.endsWith('/cancel')) {
            z.object({}).strict().parse(raw)
            options.store.cancel(owner, z.string().uuid().parse(c.req.param('id')))
            return c.json({ cancelled: true })
          }
          if (path.endsWith('/preview')) {
            const snowflake = z.string().regex(/^[0-9]{1,20}$/)
            const input = z.object({ botId: z.string().min(1), chatId: snowflake, senderId: snowflake }).strict().parse(raw)
            return c.json(await options.runtime.preview(input.botId, input.chatId, input.senderId, c.req.raw.signal))
          }
        }
        return c.json({ error: 'unsupported_operation' }, 405)
      } catch (error) {
        if (error instanceof IntegrationError) return c.json({ error: error.code, message: error.message }, error.status)
        if (error instanceof MemoryAccessError) return c.json({ error: error.code, message: error.message }, 403)
        if (error instanceof ChannelAdmissionError) return c.json({ error: 'discord_unavailable', message: error.message }, error.status)
        if (error instanceof z.ZodError) return c.json({ error: 'invalid_configuration', message: error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ') }, 400)
        console.error('[discord-integration] Configuration request failed', error instanceof Error ? error.name : 'Error')
        return c.json({ error: 'integration_unavailable', message: 'Discord or protected configuration storage is unavailable. Check the connection, permissions and server logs; no successful change is implied.' }, 503)
      }
    })
  }
}

/** Owner chat can draft but cannot submit its own review, even from a tool call. */
export function ownerChannelConfigurationTool(store: IntegrationStore, memory: MemoryDomains, transport: DiscordIntegrationTransport): Tool {
  return {
    name: 'channel_config', optIn: true,
    description: 'Owner-only Bot configuration discovery and Discord draft creation. list includes QQ/Feishu authoring routes; use authoring_change for their Agent Markdown, tools and bindings, not Discord proposals. Read schema for formats. Discord directory/members resolve names; propose with botId returns a reviewUrl to show the user. Never approves changes.',
    parameters: { type: 'object', properties: { action: { type: 'string', enum: ['schema', 'list', 'directory', 'members', 'resource', 'agent_file', 'propose'] },
      botId: { type: 'string' }, guildId: { type: 'string' }, after: { type: 'string' }, query: { type: 'string' },
      resourceId: { type: 'string' }, agentId: { type: 'string' },
      baseRevision: { type: 'integer' }, changeJson: { type: 'string', description: 'Exact change format from schema; proposals are not approval.' } }, required: ['action'], additionalProperties: false },
    execute: async (raw, context) => {
      context.signal.throwIfAborted()
      if (context.channel !== 'web' || context.inputSource !== 'user' || context.admin !== true || context.isGroup ||
        context.channelAddress || context.remoteWorkdir || context.tools.executionMode === 'call' ||
        context.projectId !== store.options.projectId || context.memoryAccess) throw new IntegrationError('owner_required', 'Use an authenticated owner conversation.', 403)
      const input = z.discriminatedUnion('action', [
        z.object({ action: z.literal('schema') }).strict(),
        z.object({ action: z.literal('list') }).strict(),
        z.object({ action: z.literal('directory'), botId: z.string().min(1),
          guildId: z.string().regex(/^[0-9]{1,20}$/).optional(), after: z.string().regex(/^[0-9]{1,20}$/).optional() }).strict(),
        z.object({ action: z.literal('members'), botId: z.string().min(1), guildId: z.string().regex(/^[0-9]{1,20}$/),
          query: z.string().trim().min(1).max(100) }).strict(),
        z.object({ action: z.literal('resource'), resourceId: z.string().uuid() }).strict(),
        z.object({ action: z.literal('agent_file'), agentId: z.string().uuid() }).strict(),
        z.object({ action: z.literal('propose'), botId: z.string().min(1).optional(),
          baseRevision: z.number().int().nonnegative(), changeJson: z.string().max(2 * 1024 * 1024) }).strict(),
      ]).parse(raw)
      if (input.action === 'schema') return JSON.stringify(integrationConfigurationGuide)
      if (input.action === 'list') return JSON.stringify({ ...store.snapshot(), projectId: store.options.projectId,
        bots: store.options.bots.list().filter(bot => bot.platform === 'discord').map(bot => ({
          id: bot.id, displayName: bot.displayName, platform: bot.platform, enabled: bot.enabled,
        })),
        otherPlatformBots: store.options.bots.list().filter(bot => bot.platform !== 'discord').map(bot => ({
          id: bot.id, displayName: bot.displayName, platform: bot.platform, enabled: bot.enabled,
          authoringTool: 'authoring_change',
        })),
        otherPlatformWorkflow: 'QQ/Feishu are supported through authoring_change in Shadow owner chat. Read its schema, create/read a Change to discover inventory.conversations and exact addresses, edit Agent Markdown/skill tools/bindings, check, then propose. The owner approves the exact publication card; Discord revisions and review URLs do not apply. project_config inspect is read-only discovery without creating a Change.',
        domains: memory.domains(), resources: memory.ownerResources(), tools: integrationToolNames })
      if (input.action === 'directory') return JSON.stringify(await transport.directory(input.botId, input.guildId, input.after, context.signal))
      if (input.action === 'members') {
        if (!transport.members) throw new IntegrationError('member_search_unavailable', 'Member search is not supported by this connection.', 503)
        return JSON.stringify({ members: await transport.members(input.botId, input.guildId, input.query, context.signal),
          notice: 'At most 25 matching members. Refine the name if your person is not shown.' })
      }
      if (input.action === 'resource') return JSON.stringify(memory.ownerRead(input.resourceId))
      if (input.action === 'agent_file') return JSON.stringify(store.ownerAgentFile(input.agentId))
      const change = IntegrationChangeSchema.parse(JSON.parse(input.changeJson))
      const botId = input.botId ?? (change.kind === 'bindings.save' ? change.bindings[0]?.botInstanceId : undefined)
      if (botId && !store.options.bots.list().some(bot => bot.id === botId && bot.platform === 'discord')) {
        throw new IntegrationError('bot_unavailable', 'Choose a Discord Bot from this Project. QQ/Feishu Agent Markdown, tools and bindings use authoring_change with owner publication review, not channel_config propose.', 400)
      }
      const draft = await store.propose({ kind: 'owner', id: 'shadow-owner' }, change, input.baseRevision, context.signal)
      const query = new URLSearchParams({ discordReview: draft.id, ...(botId ? { discordBot: botId } : {}) })
      return JSON.stringify({ ...draft,
        reviewUrl: `/projects/${encodeURIComponent(store.options.projectId)}/settings/bots?${query}`,
        nextStep: 'Show reviewUrl as a clickable Markdown link. The owner must inspect the exact change and click Approve and apply in Settings; opening the link does not approve it.',
      })
    },
  }
}
