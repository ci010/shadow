import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { PrivateDocument, assertPrivateFileBoundary } from '../utils/private-document.ts'
import { writePrivateFile } from '../config/store.ts'
import { parseAgentFile } from '../agent/types/parse.ts'
import type { AgentTypesManager, AgentTypeDefinition } from '../agent/types/manager.ts'
import type { BotInstanceStore } from './bot-store.ts'
import type { MemoryDomains } from '../memory/domains.ts'
import {
  DiscordBindingSchema, IntegrationAgentSchema, IntegrationChangeSchema, IntegrationDraftSchema,
  type DiscordBinding, type DiscordIntegrationTransport, type IntegrationActor, type IntegrationAgent,
  type IntegrationChange, type IntegrationDraft,
} from './integration-contract.ts'

export class IntegrationError extends Error {
  constructor(readonly code: string, message: string, readonly status: 400 | 403 | 404 | 409 | 503 = 400) {
    super(message); this.name = 'IntegrationError'
  }
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const auditSchema = z.object({
  id: z.string().uuid(), at: z.string().datetime(), actor: z.string(), kind: z.string(),
  revision: z.number().int().nonnegative(), affectedBindings: z.array(z.string()),
}).strict()
const stateSchema = z.object({
  version: z.literal(1), revision: z.number().int().nonnegative(),
  agents: z.array(IntegrationAgentSchema), bindings: z.array(DiscordBindingSchema),
  drafts: z.array(IntegrationDraftSchema).max(100), audit: z.array(auditSchema).max(1000),
}).strict()
type State = z.infer<typeof stateSchema>
const targetKey = (binding: DiscordBinding) => JSON.stringify([binding.botInstanceId, binding.target])
const narrowBinding = (binding: DiscordBinding, agent: IntegrationAgent): DiscordBinding => ({
  ...binding, tools: binding.tools.filter(tool => agent.tools.includes(tool)),
  readDomains: binding.readDomains.filter(domain => agent.readDomains.includes(domain)),
  manage: binding.manage && agent.tools.includes('channel_config'),
})

export class IntegrationStore {
  private readonly document: PrivateDocument<State>
  private transport?: DiscordIntegrationTransport
  private committing = false
  private readonly listeners = new Set<(bindings: string[]) => void>()

  constructor(readonly options: {
    projectId: string; directory: string; workspace: string
    bots: BotInstanceStore; agents: AgentTypesManager; memory: MemoryDomains
  }) {
    this.document = new PrivateDocument({
      projectId: options.projectId, directory: options.directory, filename: 'channel-integrations.json',
      initial: { version: 1, revision: 0, agents: [], bindings: [], drafts: [], audit: [] },
      parse: value => stateSchema.parse(value), maxBytes: 64 * 1024 * 1024,
    })
    const state = this.document.read()
    if (new Set(state.bindings.map(targetKey)).size !== state.bindings.length ||
      new Set(state.agents.map(agent => agent.name)).size !== state.agents.length ||
      new Set(state.agents.map(agent => agent.id)).size !== state.agents.length) {
      throw new Error('Invalid channel integration identities.')
    }
    for (const draft of state.drafts.filter(draft => draft.status === 'applying')) {
      try { this.apply(draft) }
      catch (error) {
        if (!(error instanceof IntegrationError)) throw error
        console.error('[discord-integration] Approved change needs recovery', { id: draft.id, error: error.code })
      }
    }
  }

  setTransport(transport: DiscordIntegrationTransport): void { this.transport = transport }
  onChange(listener: (bindings: string[]) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  snapshot(): State { this.document.assertCurrent(); return this.document.read() }
  agents(): IntegrationAgent[] { return this.snapshot().agents }
  bindings(): DiscordBinding[] { return this.snapshot().bindings }
  deploymentIssues(): Array<{ agentId: string; message: string }> {
    return this.agents().flatMap(agent => {
      try { this.assertAgentFile(agent); return [] }
      catch (error) {
        if (!(error instanceof IntegrationError)) throw error
        return [{ agentId: agent.id, message: error.message }]
      }
    })
  }

  ownerAgentFile(id: string): { id: string; markdown: string } {
    const agent = this.agents().find(item => item.id === id)
    if (!agent) throw new IntegrationError('agent_missing', 'Agent not found.', 404)
    const path = join(this.agentDirectory(agent.name), 'AGENT.md')
    assertPrivateFileBoundary(path)
    if (lstatSync(path).size > 128_000) throw new IntegrationError('agent_too_large', 'Agent file is too large for publication.')
    return { id, markdown: readFileSync(path, 'utf8') }
  }
  agent(id: string): IntegrationAgent {
    const agent = this.agents().find(agent => agent.id === id)
    if (!agent) throw new IntegrationError('agent_missing', 'The assigned Agent is unavailable.', 409)
    this.assertAgentFile(agent)
    return agent
  }

  definition(agent: IntegrationAgent): AgentTypeDefinition {
    const parsed = parseAgentFile(agent.markdown, agent.name, this.agentDirectory(agent.name))
    return { ...parsed, name: agent.name, allowedTools: [...agent.tools], blockedTools: undefined,
      allowedModules: [], soul: false, skills: false }
  }

  restoreAgents(): void {
    for (const agent of this.agents()) {
      try {
        this.assertAgentFile(agent)
        this.options.agents.setWorkspaceType(agent.name, this.definition(agent))
      } catch (error) {
        if (!(error instanceof IntegrationError)) throw error
        console.error('[discord-integration] Agent deployment paused', { id: agent.id, error: error.code })
      }
    }
  }

  private agentDirectory(name: string): string { return resolve(this.options.workspace, 'agents', name) }
  private assertAgentFile(agent: IntegrationAgent): void {
    const path = join(this.agentDirectory(agent.name), 'AGENT.md')
    let content: string
    try {
      assertPrivateFileBoundary(path)
      const info = lstatSync(path)
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('Unsafe Agent definition file.')
      content = readFileSync(path, 'utf8')
    } catch (cause) {
      throw new IntegrationError('agent_definition_unavailable', 'The published Agent file is unavailable; review and publish it again.', 409)
    }
    if (content !== agent.markdown) throw new IntegrationError('agent_definition_changed', 'The Agent file changed outside its approved version. Review and publish before using it.', 409)
  }

  private affected(change: IntegrationChange, state = this.snapshot()): string[] {
    if (change.kind === 'bindings.save') return change.bindings.map(binding => binding.id)
    if (change.kind === 'agent.save') return state.bindings.filter(binding => binding.agentId === change.agent.id).map(binding => binding.id)
    if (change.kind === 'domain.revoke' || change.kind === 'knowledge.publish') {
      return state.bindings.filter(binding => binding.readDomains.includes(change.domainId)).map(binding => binding.id)
    }
    if (change.kind === 'knowledge.revoke') {
      const resource = this.options.memory.ownerResources().find(resource => resource.id === change.resourceId)
      return resource ? state.bindings.filter(binding => binding.readDomains.includes(resource.domainId)).map(binding => binding.id) : []
    }
    return []
  }

  private validateAgent(agent: z.infer<typeof IntegrationAgentSchema> | Extract<IntegrationChange, { kind: 'agent.save' }>['agent']): void {
    const parsed = parseAgentFile(agent.markdown, agent.name, this.agentDirectory(agent.name))
    if (parsed.name !== agent.name || parsed.root || parsed.defaultMode !== 'session' || !parsed.prompt.trim()) {
      throw new IntegrationError('invalid_agent', 'Channel Agents require a non-system session definition with a matching name and nonempty instructions.')
    }
    if (new Set(agent.tools).size !== agent.tools.length || new Set(agent.readDomains).size !== agent.readDomains.length) {
      throw new IntegrationError('duplicate_permissions', 'Tool and memory permissions must be unique.')
    }
    if (agent.execution === 'restricted' && agent.tools.includes('exec')) {
      throw new IntegrationError('unsafe_tool', 'Host execution is unavailable to restricted Agents.')
    }
    if (parsed.allowedModules?.length) throw new IntegrationError('unsafe_modules', 'Channel definitions cannot grant script modules. Use an explicitly trusted Agent for host execution.')
    for (const domainId of agent.readDomains) {
      const domain = this.options.memory.domain(domainId)
      if (!['shared', 'agent-private'].includes(domain.kind)) {
        throw new IntegrationError('private_memory', 'Channel Agents may select only explicitly shared knowledge or approved Agent-private domains.')
      }
    }
  }

  private validateBinding(binding: DiscordBinding, agents: IntegrationAgent[]): void {
    const agent = agents.find(agent => agent.id === binding.agentId)
    if (!agent) throw new IntegrationError('agent_missing', 'Choose a published Agent before assigning a channel.')
    const bot = this.options.bots.get(binding.botInstanceId)
    if (bot.platform !== 'discord') throw new IntegrationError('wrong_platform', 'The binding requires a Discord Bot.')
    if (binding.tools.some(tool => !agent.tools.includes(tool)) ||
      binding.readDomains.some(domain => !agent.readDomains.includes(domain))) {
      throw new IntegrationError('permission_ceiling', 'Channel permissions cannot exceed the Agent permissions.')
    }
    if (binding.enabled) for (const id of binding.readDomains) this.options.memory.domain(id)
    if (!binding.participants.everyone && !binding.participants.userIds.length && !binding.participants.roleIds.length) {
      throw new IntegrationError('empty_participants', 'Select at least one allowed user or role.')
    }
    if ((agent.execution === 'trusted' || binding.manage) && binding.participants.everyone) {
      throw new IntegrationError('public_privileged_agent', 'Trusted execution and configuration management require explicitly selected users or roles.')
    }
    if (binding.manage !== binding.tools.includes('channel_config')) {
      throw new IntegrationError('management_grant', 'Configuration tools require an explicit management grant, and vice versa.')
    }
    if (binding.target.kind === 'dm' && (binding.participants.everyone || binding.participants.roleIds.length ||
      binding.participants.userIds.length !== 1 || binding.participants.userIds[0] !== binding.target.userId || binding.inheritThreads)) {
      throw new IntegrationError('invalid_dm', 'A DM binding permits only its selected user, without roles or thread inheritance.')
    }
    for (const values of [binding.tools, binding.readDomains, binding.participants.userIds, binding.participants.roleIds]) {
      if (new Set(values).size !== values.length) throw new IntegrationError('duplicate_permissions', 'Binding permissions must be unique.')
    }
  }

  private async validate(change: IntegrationChange, signal: AbortSignal): Promise<{ hash: string; fileRevision: string | null }> {
    const state = this.snapshot()
    let agents = state.agents
    let bindings = state.bindings
    let fileRevision: string | null = null
    if (change.kind === 'agent.save') {
      this.validateAgent(change.agent)
      const previous = state.agents.find(agent => agent.id === change.agent.id)
      const path = join(this.agentDirectory(change.agent.name), 'AGENT.md')
      assertPrivateFileBoundary(path)
      if (existsSync(path)) fileRevision = hash(readFileSync(path, 'utf8'))
      if (previous && previous.name !== change.agent.name) throw new IntegrationError('immutable_agent_name', 'Create a copy to change an Agent identity.')
      if (!previous && (state.agents.some(agent => agent.name === change.agent.name) || this.options.agents.resolve(change.agent.name) ||
        existsSync(this.agentDirectory(change.agent.name)))) throw new IntegrationError('agent_name_exists', 'Choose a new Agent name; existing and built-in definitions are never overwritten.')
      const agent: IntegrationAgent = { ...change.agent, version: hash(change.agent), publishedAt: new Date().toISOString() }
      agents = [...agents.filter(item => item.id !== agent.id), agent]
      bindings = bindings.map(binding => binding.agentId === agent.id ? narrowBinding(binding, agent) : binding)
    }
    if (change.kind === 'bindings.save') {
      if (new Set(change.bindings.map(binding => binding.id)).size !== change.bindings.length) throw new IntegrationError('duplicate_binding', 'Batch contains duplicate binding IDs.')
      for (const binding of change.bindings) {
        const previous = bindings.find(item => item.id === binding.id)
        if (previous && targetKey(previous) !== targetKey(binding)) throw new IntegrationError('immutable_binding_target', 'Create a new assignment to change the target; disable the old assignment explicitly.')
      }
      bindings = [...bindings.filter(item => !change.bindings.some(next => next.id === item.id)), ...change.bindings]
    }
    if (new Set(bindings.map(targetKey)).size !== bindings.length) throw new IntegrationError('duplicate_binding', 'A Bot may have only one assignment at each location.')
    for (const binding of bindings.filter(binding => change.kind === 'agent.save' ? binding.agentId === change.agent.id
      : change.kind === 'bindings.save' && change.bindings.some(next => next.id === binding.id))) {
      this.validateBinding(binding, agents)
    }
    const inspected: unknown[] = []
    if (change.kind === 'bindings.save') {
      if (!this.transport) throw new IntegrationError('unavailable', 'Discord discovery is unavailable.', 503)
      for (const binding of change.bindings.filter(binding => binding.enabled)) {
        signal.throwIfAborted()
        const live = await this.transport.inspectTarget(binding.botInstanceId, binding.target, signal)
        if (live.botUserId !== binding.botUserId) throw new IntegrationError('bot_identity_changed', 'The connected Bot identity changed. Refresh before assigning channels.', 409)
        if (binding.participants.roleIds.some(role => !live.roleIds.includes(role))) throw new IntegrationError('role_missing', 'An allowed role is no longer present in this server.', 409)
        inspected.push({ id: binding.id, bot: live.botUserId, roles: binding.participants.roleIds })
      }
    }
    if (change.kind === 'knowledge.publish') {
      if (!['shared', 'agent-private'].includes(this.options.memory.domain(change.domainId).kind)) throw new IntegrationError('invalid_domain', 'Choose a shared or explicitly approved Agent-private knowledge domain.')
      for (const source of change.sources) {
        const domain = this.options.memory.domain(source.domain.id)
        if (domain.revision !== source.domain.revision || source.sessionId &&
          (domain.owner?.sessionId !== source.sessionId || domain.owner?.epoch !== source.epoch)) {
          throw new IntegrationError('source_changed', 'A source domain or conversation changed. Review the publication again.', 409)
        }
        if (source.resourceId) {
          const resource = this.options.memory.ownerRead(source.resourceId).resource
          if (resource.version !== source.version || resource.domainId !== source.domain.id) throw new IntegrationError('source_changed', 'A source resource changed. Review the publication again.', 409)
        }
      }
    }
    if (change.kind === 'knowledge.revoke' && !this.options.memory.ownerResources().some(item => item.id === change.resourceId && item.publication)) {
      throw new IntegrationError('publication_missing', 'The knowledge publication is unavailable.', 404)
    }
    if (change.kind === 'domain.revoke') {
      const domain = this.options.memory.domain(change.domainId)
      if (domain.kind === 'conversation' || domain.kind === 'project-private') throw new IntegrationError('invalid_domain', 'Only explicitly shared or Agent-private domains can be revoked here.')
    }
    const domains = new Set<string>()
    if (change.kind === 'agent.save') change.agent.readDomains.forEach(id => domains.add(id))
    if (change.kind === 'bindings.save') change.bindings.filter(binding => binding.enabled).forEach(binding => binding.readDomains.forEach(id => domains.add(id)))
    if (change.kind === 'knowledge.publish' || change.kind === 'domain.revoke') domains.add(change.domainId)
    const refs = [...domains].sort().map(id => { const domain = this.options.memory.domain(id); return { id, revision: domain.revision } })
    return { hash: hash({ inspected, refs, fileRevision }), fileRevision }
  }

  async propose(actor: IntegrationActor, raw: unknown, baseRevision: number, signal: AbortSignal): Promise<IntegrationDraft> {
    const change = IntegrationChangeSchema.parse(raw)
    const before = this.snapshot()
    if (before.drafts.some(draft => draft.status === 'applying')) throw new IntegrationError('recovery_required', 'An approved change needs recovery. Retry or resolve it in Reviews before proposing another change.', 409)
    if (this.committing || before.revision !== baseRevision) throw new IntegrationError('revision_conflict', 'Configuration changed. Refresh and review your changes again.', 409)
    const validation = await this.validate(change, signal)
    const validationHash = validation.hash
    signal.throwIfAborted()
    const state = this.snapshot()
    if (this.committing || state.revision !== baseRevision) throw new IntegrationError('revision_conflict', 'Configuration changed during validation.', 409)
    const pending = state.drafts.filter(draft => draft.status === 'applying' || draft.status === 'pending' && Date.parse(draft.expiresAt) > Date.now())
    if (pending.length >= 40) throw new IntegrationError('too_many_drafts', 'Resolve outstanding configuration reviews before creating more.', 409)
    const id = randomUUID()
    const draft = IntegrationDraftSchema.parse({
      id, actor, baseRevision, change, validationHash, hash: hash({ id, actor, baseRevision, change, validationHash }),
      ...(change.kind === 'agent.save' ? { agentFileHash: validation.fileRevision } : {}),
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      status: 'pending', affectedBindings: this.affected(change, state),
      warning: change.kind === 'knowledge.publish'
        ? 'This approves a fixed copy for the selected domain audience. Source permissions will not automatically revoke this approved copy; revoke its publication explicitly.'
        : change.kind === 'agent.save' && change.agent.execution === 'trusted'
        ? 'Trusted host execution is not a sandbox. Removed Agent permissions are also removed from every assignment. Agent or access changes start a fresh context; previous history remains available to the owner.'
        : change.kind === 'agent.save' ? 'Removed Agent permissions are also removed from every assignment. Changed instructions or access start a fresh context; previous history remains available to the owner.'
        : 'Agent and access changes start a fresh context. Unassigned channels and DMs remain disabled. Same-Agent conversations do not share memory.',
    })
    this.document.write({ ...state, drafts: [...state.drafts.filter(item => !pending.includes(item)).slice(-59), ...pending, draft].slice(-100) })
    for (const listener of this.listeners) listener([])
    return draft
  }

  draft(id: string): IntegrationDraft {
    const draft = this.snapshot().drafts.find(draft => draft.id === id)
    if (!draft) throw new IntegrationError('draft_missing', 'Configuration review not found.', 404)
    return draft
  }

  async commit(actor: IntegrationActor, id: string, expectedHash: string, signal: AbortSignal): Promise<IntegrationDraft> {
    if (this.committing) throw new IntegrationError('configuration_busy', 'Another configuration change is being applied.', 409)
    this.committing = true
    try {
      let draft = this.draft(id)
      if (draft.hash !== expectedHash || actor.kind !== 'owner' && JSON.stringify(actor) !== JSON.stringify(draft.actor)) {
        throw new IntegrationError('confirmation_mismatch', 'This review belongs to another actor or version.', 403)
      }
      if (draft.status === 'applied') return draft
      if (draft.status === 'cancelled') throw new IntegrationError('review_cancelled', 'This review was cancelled.', 409)
      if (draft.status === 'pending') {
        if (this.snapshot().drafts.some(item => item.status === 'applying')) throw new IntegrationError('recovery_required', 'Resolve the interrupted approval before applying another review.', 409)
        if (Date.parse(draft.expiresAt) <= Date.now() || this.snapshot().revision !== draft.baseRevision) {
          throw new IntegrationError('stale_review', 'The review expired or configuration changed. Create a fresh review.', 409)
        }
        if ((await this.validate(draft.change, signal)).hash !== draft.validationHash) throw new IntegrationError('stale_review', 'The reviewed resource permissions changed. Create a fresh review.', 409)
        signal.throwIfAborted()
        const state = this.snapshot()
        if (state.revision !== draft.baseRevision) throw new IntegrationError('revision_conflict', 'Configuration changed.', 409)
        draft = { ...draft, status: 'applying' }
        this.document.write({ ...state, drafts: state.drafts.map(item => item.id === id ? draft : item) })
      }
      // The durable approved record is the recovery boundary; applying is intentionally idempotent.
      this.apply(draft)
      return this.draft(id)
    } finally { this.committing = false }
  }

  cancel(actor: IntegrationActor, id: string): void {
    if (this.committing) throw new IntegrationError('configuration_busy', 'A configuration approval is in progress.', 409)
    const draft = this.draft(id)
    if (actor.kind !== 'owner' && JSON.stringify(actor) !== JSON.stringify(draft.actor)) throw new IntegrationError('forbidden', 'Review is not owned by this actor.', 403)
    if (draft.status === 'applying' && actor.kind === 'owner' && draft.change.kind === 'agent.save') {
      const path = join(this.agentDirectory(draft.change.agent.name), 'AGENT.md')
      assertPrivateFileBoundary(path)
      if (existsSync(path) && readFileSync(path, 'utf8') === draft.change.agent.markdown) {
        throw new IntegrationError('recovery_required', 'The approved Agent file was already written. Retry its approval to finish applying it.', 409)
      }
    } else if (draft.status !== 'pending') throw new IntegrationError('review_not_pending', 'This review is no longer pending.', 409)
    const state = this.snapshot()
    this.document.write({ ...state, drafts: state.drafts.map(item => item.id === id ? { ...item, status: 'cancelled' } : item),
      audit: [...state.audit, { id: randomUUID(), at: new Date().toISOString(), actor: actor.id,
        kind: draft.status === 'applying' ? 'review.abandoned' : 'review.cancelled', revision: state.revision, affectedBindings: draft.affectedBindings }].slice(-1000),
    })
    for (const listener of this.listeners) listener([])
  }

  private apply(draft: IntegrationDraft): void {
    const state = this.snapshot()
    if (state.revision !== draft.baseRevision) throw new IntegrationError('revision_conflict', 'Approved configuration cannot be applied over a newer version.', 409)
    const change = draft.change
    if (change.kind === 'agent.save') {
      const managementBindingId = state.agents.find(agent => agent.id === change.agent.id)?.managementBindingId ??
        (draft.actor.kind === 'discord' ? draft.actor.bindingId : undefined)
      const agent: IntegrationAgent = { ...change.agent, version: hash(change.agent), publishedAt: draft.createdAt,
        ...(managementBindingId ? { managementBindingId } : {}) }
      const path = join(this.agentDirectory(agent.name), 'AGENT.md')
      assertPrivateFileBoundary(path)
      const currentFileHash = existsSync(path) ? hash(readFileSync(path, 'utf8')) : null
      if (currentFileHash !== hash(agent.markdown) && (draft.agentFileHash === undefined || currentFileHash !== draft.agentFileHash)) {
        throw new IntegrationError('agent_recovery_conflict', 'The Agent file changed after approval. The manual edit was preserved. Abandon this review and review the current file before publishing again.', 409)
      }
      mkdirSync(this.agentDirectory(agent.name), { recursive: true, mode: 0o700 })
      assertPrivateFileBoundary(path)
      writePrivateFile(path, agent.markdown)
      state.agents = [...state.agents.filter(item => item.id !== agent.id), agent]
      state.bindings = state.bindings.map(binding => binding.agentId === agent.id ? narrowBinding(binding, agent) : binding)
      this.options.agents.setWorkspaceType(agent.name, this.definition(agent))
    } else if (change.kind === 'bindings.save') {
      state.bindings = [...state.bindings.filter(item => !change.bindings.some(binding => binding.id === item.id)),
        ...change.bindings.map(binding => ({ ...binding,
          epochRevision: (state.bindings.find(item => item.id === binding.id)?.epochRevision ?? 0) + 1 }))]
    } else if (change.kind === 'domain.create') {
      this.options.memory.createDomain(change.name, change.domainKind, undefined, draft.id,
        draft.actor.kind === 'discord' ? draft.actor.bindingId : undefined)
    } else if (change.kind === 'knowledge.publish') {
      this.options.memory.publish({ ...change, actor: draft.actor.id, requestId: draft.id })
    } else if (change.kind === 'knowledge.revoke') {
      this.options.memory.revokePublication(change.resourceId)
    } else if (change.kind === 'domain.revoke') {
      this.options.memory.revokeDomain(change.domainId)
    }
    const revision = state.revision + 1
    this.document.write({ ...state, revision,
      drafts: state.drafts.map(item => item.id === draft.id ? { ...item, status: 'applied', appliedRevision: revision } : item),
      audit: [...state.audit, { id: draft.id, at: new Date().toISOString(), actor: draft.actor.id,
        kind: change.kind, revision, affectedBindings: draft.affectedBindings }].slice(-1000),
    })
    for (const listener of this.listeners) listener(draft.affectedBindings)
  }
}
