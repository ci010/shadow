import { channelSessionId } from '../bus/events.ts'
import type { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import type { BotInstanceStore } from './bot-store.ts'
import type { ServiceDiscoveryStore } from './service-discovery.ts'
import type { AgentResourceStore } from '../agent-authoring/store.ts'
import { PublicationRequestError, PublicationValidationError, type PublicationRequests } from '../agent-authoring/publication-requests.ts'
import type { AuthoringChanges } from '../agent-authoring/changes.ts'
import { parseFrontmatter } from '../utils/frontmatter.ts'
import { ConversationBindingSchema, type ConversationBinding } from '../agent-authoring/contracts.ts'

import { agentCapabilityProfiles, capabilitySummary } from '../agent-authoring/capability-profiles.ts'

/** Web-only adapter over the existing exact-revision publication workflow. Observations never grant access. */
export function serviceGroupsPlugin(options: {
  bots: BotInstanceStore; discovery: ServiceDiscoveryStore; resources: AgentResourceStore; reviews: PublicationRequests; changes: AuthoringChanges
  readiness: (binding: ConversationBinding) => string | undefined
  authorize: (request: Request) => boolean | Promise<boolean>
}) {
  let proposing = false
  return (app: Hono) => {
    app.use('/api/service-groups*', async (c, next) => {
      c.header('Cache-Control', 'no-store')
      if (!await options.authorize(c.req.raw)) return c.json({ error: 'unauthorized' }, 401)
      await next()
    })
    app.use('/api/service-groups/*', bodyLimit({ maxSize: 32 * 1024, onError: c => c.json({ error: 'request_too_large' }, 413) }))
    app.get('/api/service-groups', c => {
      const snapshot = options.resources.snapshot()
      const bots = options.bots.list()
      const reviews = options.reviews.list()
      return c.json({ revision: snapshot.revision,
        agentRequirements: Object.fromEntries(Object.entries(snapshot.bundle.files).filter(([path]) => /^agents\/[^/]+\/AGENT.md$/.test(path)).map(([path, content]) => [path.split('/')[1], parseFrontmatter(content).frontmatter.allowedTools ?? []])),
        skills: Object.entries(snapshot.bundle.files).flatMap(([path, content]) => {
          const name = /^skills\/([^/]+)\/SKILL.md$/.exec(path)?.[1]
          if (!name) return []
          const tools = parseFrontmatter(content).frontmatter.tools ?? {}
          return [{ name, tools: Object.entries(tools as Record<string, { imports?: string[] }>).map(([name, tool]) => ({ name, modules: tool.imports ?? [] })) }]
        }),
        agentSetups: bots.filter(bot => bot.purpose === 'service').flatMap(bot => Object.keys(snapshot.bundle.files).flatMap(path => {
          const agent = /^agents\/([a-z][a-z0-9_-]*)\/AGENT.md$/.exec(path)?.[1]
          if (!agent) return []
          const profile = agentCapabilityProfiles(snapshot, agent).find(profile => profile.botInstanceId === bot.id && profile.platform === bot.platform)
          const problem = profile ? options.readiness({ ...profile, agent, conversationId: `profile:${agent}`, enabled: true }) : 'profile_missing'
          return [{ botInstanceId: bot.id, agent, status: problem ? 'incomplete' : 'ready', problem, source: profile ? { kind: 'published_agent_profile', revision: snapshot.revision } : undefined, summary: profile ? capabilitySummary(snapshot, agent, profile) : undefined }]
        })),
        agents: Object.keys(snapshot.bundle.files).flatMap(path => /^agents\/([a-z][a-z0-9_-]*)\/AGENT.md$/.exec(path)?.[1] ?? []),
        groups: options.discovery.list().filter(group => bots.some(bot => bot.id === group.botInstanceId && bot.purpose === 'service' && bot.platform === group.platform)).map(group => {
          const binding = snapshot.bundle.bindings.find(binding => binding.botInstanceId === group.botInstanceId && binding.platform === group.platform && binding.conversationId === group.conversationId)
          const sessionId = channelSessionId({ projectId: options.bots.get(group.botInstanceId).projectId, botInstanceId: group.botInstanceId, platform: group.platform, conversationId: group.conversationId, legacySessionId: options.bots.get(group.botInstanceId).legacySessionId })
          return { ...group, sessionId, messages: (c.req.query('group') === JSON.stringify([group.botInstanceId, group.conversationId]) || c.req.query('session') === sessionId) ? group.messages : [], botName: bots.find(bot => bot.id === group.botInstanceId)!.displayName,
            enabled: binding?.enabled ?? false, agent: binding?.agent,
            pending: reviews.some(review => review.impact ? review.impact.affectedBindings.includes(JSON.stringify([group.botInstanceId, group.platform, group.conversationId])) : [...review.bindings, ...review.previousBindings].some(binding => binding.botInstanceId === group.botInstanceId && binding.platform === group.platform && binding.conversationId === group.conversationId)) }
        }) })
    })
    app.post('/api/service-groups/propose', async c => {
      if (Number(c.req.header('content-length') ?? 0) > 32 * 1024) return c.json({ error: 'request_too_large' }, 413)
      if (proposing) return c.json({ error: 'publication_in_progress' }, 409)
      proposing = true
      try {
        const text = await c.req.text()
        if (text.length > 32 * 1024) return c.json({ error: 'request_too_large' }, 413)
        const input = z.object({ botInstanceId: z.string().min(1).max(512), conversationId: z.string().min(1).max(512), agent: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), revision: z.string().max(128), }).strict().parse(JSON.parse(text))
        const bot = options.bots.list().find(bot => bot.id === input.botInstanceId)
        if (!bot) return c.json({ error: 'service_bot_not_found' }, 404)
        if (bot.purpose !== 'service' || !['qq', 'feishu'].includes(bot.platform)) return c.json({ error: 'invalid_service_bot' }, 400)
        const group = options.discovery.list().find(group => group.botInstanceId === bot.id && group.platform === bot.platform && group.conversationId === input.conversationId)
        if (!group) return c.json({ error: 'group_not_observed' }, 400)
        const snapshot = options.resources.snapshot()
        // Candidates are rooted only in the exact published base, never the shared draft.
        if (snapshot.revision !== input.revision) return c.json({ error: 'draft_or_publication_changed' }, 409)
        if (!snapshot.bundle.files[`agents/${input.agent}/AGENT.md`]) return c.json({ error: 'agent_not_published' }, 400)
        const profile = agentCapabilityProfiles(snapshot, input.agent).find(profile => profile.botInstanceId === bot.id && profile.platform === bot.platform)
        if (!profile) return c.json({ error: 'group_setup_profile_missing', diagnostic: { stage: 'agent', action: 'configure_agent_capability_profile' } }, 422)
        const binding = ConversationBindingSchema.parse({ ...profile, botInstanceId: bot.id, platform: bot.platform, conversationId: group.conversationId, agent: input.agent, enabled: true })
        const problem = options.readiness(binding)
        if (problem) return c.json({ error: `group_setup_${problem}`, diagnostic: { stage: 'agent', action: problem === 'credential_missing' ? 'open_private_credential_entry' : 'configure_agent_capability_profile' } }, 422)
        const bundle = structuredClone(snapshot.bundle)
        bundle.bindings = bundle.bindings.filter(old => old.botInstanceId !== bot.id || old.platform !== bot.platform || old.conversationId !== group.conversationId)
        bundle.bindings.push(binding)
        const candidate = options.resources.candidate(bundle)
        const validation = options.resources.validate(candidate)
        if (!validation.valid) {
          const message = validation.errors[0] ?? ''
          const missingTool = /^Tool is not bound to conversation: ([a-z][a-z0-9_-]{0,63})$/.exec(message)
          const missingGrant = /^Tool ([a-z][a-z0-9_-]{0,63}) requires missing grant: ([A-Za-z][A-Za-z0-9_-]{0,255})$/.exec(message)
          return c.json({ error: missingTool ? 'group_setup_skill_missing' : missingGrant ? 'group_setup_grant_missing' : 'group_setup_validation_failed', diagnostic: { stage: 'resources', ...(missingTool ? { tool: missingTool[1] } : {}), ...(missingGrant ? { tool: missingGrant[1], grant: missingGrant[2] } : {}), action: missingTool ? 'select_published_skill' : missingGrant ? 'configure_explicit_grant' : 'review_project_resources' } }, 422)
        }
        const existing = options.reviews.list().find(review => review.revision === candidate.revision)
        if (existing) return c.json({ request: existing })
        const key = JSON.stringify([bot.id, bot.platform, group.conversationId])
        if (options.reviews.list().some(review => review.impact?.affectedBindings.includes(key))) return c.json({ error: 'existing_publication_review' }, 409)
        const change = options.changes.list().find(change => !change.closed && change.ownerSessionId === 'owner:service-groups' &&
          change.base.revision === snapshot.revision && change.snapshot.revision === candidate.revision)
          ?? options.changes.create({ title: `Group binding: ${input.agent}`, ownerSessionId: 'owner:service-groups' })
        if (change.base.revision !== snapshot.revision) return c.json({ error: 'draft_or_publication_changed' }, 409)
        const edited = options.changes.edit(change.id, { expectedRevision: change.snapshot.revision,
          bindings: bundle.bindings })
        let request
        try { request = await options.reviews.propose({ snapshot: edited.snapshot,
          change: { id: edited.id, title: edited.title, sourceSessionId: edited.ownerSessionId, accessRevision: edited.accessRevision }, checks: [] }, undefined, edited.ownerSessionId) } catch (error) {
          if (error instanceof PublicationRequestError) throw error
          const message = error instanceof Error ? error.message : ''
          const code = message.startsWith('Credential reference ') ? 'group_setup_credential_missing'
            : message.startsWith('Read folder ') ? 'group_setup_folder_missing'
            : message.startsWith('Inbox target ') ? 'group_setup_inbox_invalid'
            : message.startsWith('Discord assignments ') ? 'group_setup_legacy_discord'
            : 'group_setup_validation_failed'
          return c.json({ error: code, diagnostic: { stage: error instanceof PublicationValidationError ? error.stage : 'request', action: code === 'group_setup_credential_missing' ? 'provision_credential_in_project_settings' : 'review_project_resources' } }, 422)
        }
        return c.json({ request })
      } catch (error) {
        if (error instanceof PublicationRequestError) return c.json({ error: error.code }, error.status)
        if (error instanceof z.ZodError || error instanceof SyntaxError) return c.json({ error: 'invalid_group_proposal' }, 400)
        if (error instanceof Error && /^Stale (draft|published) revision$/.test(error.message)) return c.json({ error: 'draft_or_publication_changed' }, 409)
        return c.json({ error: 'group_proposal_failed' }, 500)
      } finally { proposing = false }
    })
  }
}
