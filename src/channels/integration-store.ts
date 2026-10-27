import type { SourceResources } from './source-resources.ts'
import { compileDiscordPackage } from './bot-package.ts'
import { projectStoragePath } from '../utils/data-paths.ts'
import { isDeepStrictEqual } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { PrivateDocument, assertPrivateFileBoundary } from '../utils/private-document.ts'
import { writePrivateFile } from '../config/store.ts'
import { parseAgentFile } from '../agent/types/parse.ts'
import type { AgentTypesManager, AgentTypeDefinition } from '../agent/types/manager.ts'
import type { BotInstanceStore } from './bot-store.ts'
import type { MemoryDomains } from '../memory/domains.ts'
import {
  DiscordPackageSchema, DiscordBindingSchema, IntegrationAgentSchema, IntegrationChangeSchema, IntegrationDraftSchema,
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
  packages: z.record(z.object({ active: DiscordPackageSchema, revision: z.string(), history: z.array(DiscordPackageSchema).max(20) }).strict()).default({}),
  drafts: z.array(IntegrationDraftSchema).max(100), audit: z.array(auditSchema).max(1000),
}).strict()
type State = z.infer<typeof stateSchema>
const targetKey = (binding: DiscordBinding) => JSON.stringify([binding.botInstanceId, binding.target])
const narrowBinding = (binding: DiscordBinding, agent: IntegrationAgent): DiscordBinding => {
  const narrowed: DiscordBinding = {
  ...binding, tools: binding.tools.filter(tool => agent.tools.includes(tool)),
  readDomains: binding.readDomains.filter(domain => agent.readDomains.includes(domain)),
  ...(binding.sourceFolders ? {sourceFolders:binding.sourceFolders.filter(id => agent.sourceFolders?.includes(id))} : {}),
  ...(binding.discordHistory ? {discordHistory: agent.discordHistory && binding.discordHistory.guildId === agent.discordHistory.guildId ? {
    guildId:binding.discordHistory.guildId,
    channelIds:binding.discordHistory.channelIds.filter(id => agent.discordHistory!.channelIds.includes(id)),
    threads: ['none','public-active','public-archived'].indexOf(binding.discordHistory.threads) <= ['none','public-active','public-archived'].indexOf(agent.discordHistory.threads) ? binding.discordHistory.threads : agent.discordHistory.threads,
    preEpoch:binding.discordHistory.preEpoch && agent.discordHistory.preEpoch,
  } : undefined} : {}),
  manage: binding.manage && agent.tools.includes('channel_config'),
  }
  if (!narrowed.discordHistory?.channelIds.length) delete narrowed.discordHistory
  return narrowed
}

export class IntegrationStore {
  private readonly document: PrivateDocument<State>
  private transport?: DiscordIntegrationTransport
  private committing = false
  private readonly listeners = new Set<(bindings: string[]) => void>()

  constructor(readonly options: {
    projectId: string; directory: string; workspace: string
    sources?: SourceResources
    bots: BotInstanceStore; agents: AgentTypesManager; memory: MemoryDomains
  }) {
    this.document = new PrivateDocument({
      projectId: options.projectId, directory: options.directory, filename: 'channel-integrations.json',
      initial: { version: 1, revision: 0, agents: [], bindings: [], packages: {}, drafts: [], audit: [] },
      parse: value => stateSchema.parse(value), maxBytes: 64 * 1024 * 1024,
    })
    const state = this.document.read()
    if (new Set(state.bindings.map(targetKey)).size !== state.bindings.length ||
      new Set(state.agents.map(agent => agent.name)).size !== state.agents.length ||
      new Set(state.agents.map(agent => agent.id)).size !== state.agents.length) {
      throw new Error('Invalid channel integration identities.')
    }
    const packageAgents = new Set<string>(), packageBindings = new Set<string>()
    for (const [id, item] of Object.entries(state.packages)) {
      if (id !== item.active.id || item.revision !== hash(item.active)) throw new Error('Invalid BOT release identity or hash.')
      const compiled = compileDiscordPackage(item.active)
      const agent = state.agents.find(a=>a.id === compiled.agent.id)
      if (!agent || agent.version !== hash(compiled.agent) || !isDeepStrictEqual({...agent,version:undefined,publishedAt:undefined},{...compiled.agent,version:undefined,publishedAt:undefined}) || packageAgents.has(agent.id)) throw new Error('Published BOT Agent differs from frozen source.')
      packageAgents.add(agent.id)
      for (const binding of compiled.bindings) {
        const active = state.bindings.find(b=>b.id===binding.id)
        if (!active || !isDeepStrictEqual({...active,epochRevision:undefined},{...binding,epochRevision:undefined}) || packageBindings.has(binding.id)) throw new Error('Published BOT binding differs from frozen source.')
        packageBindings.add(binding.id)
      }
      for (const release of item.history) {
        if (release.id !== id) throw new Error('BOT history identity mismatch.')
        compileDiscordPackage(release)
      }
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
    if (this.packagedAgent(agent.id)) return { id, markdown: agent.markdown }
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
    if (agent.sourceFolders?.length) {
      if (!this.options.sources) throw new IntegrationError('source_unavailable', 'Registered source resources unavailable.')
      this.options.sources.validate(agent.sourceFolders)
    }
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

  private agentDirectory(name: string): string { return projectStoragePath(this.options.workspace, 'agents', name) }
  private packagedAgent(id: string): boolean {
    return Object.values(this.snapshot().packages).some(item => compileDiscordPackage(item.active).agent.id === id)
  }
  private assertAgentFile(agent: IntegrationAgent): void {
    if (this.packagedAgent(agent.id)) return

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
    if (change.kind === 'bot.save') {
      const old = state.packages[change.package.id]
      return [...new Set([...(old ? compileDiscordPackage(old.active).bindings.map(b=>b.id) : []), ...compileDiscordPackage(change.package).bindings.map(b=>b.id)])]
    }
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
    if (agent.sourceFolders?.length) {
      if (!this.options.sources) throw new IntegrationError('source_unavailable', 'Registered source resources unavailable.')
      this.options.sources.validate(agent.sourceFolders)
    }
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
    if ((binding.sourceFolders ?? []).some(id => !agent.sourceFolders?.includes(id)) ||
      binding.discordHistory && (!agent.discordHistory || binding.discordHistory.guildId !== agent.discordHistory.guildId ||
        binding.discordHistory.channelIds.some(id => !agent.discordHistory!.channelIds.includes(id)) ||
        binding.discordHistory.preEpoch && !agent.discordHistory.preEpoch ||
        ['none','public-active','public-archived'].indexOf(binding.discordHistory.threads) > ['none','public-active','public-archived'].indexOf(agent.discordHistory.threads))) {
      throw new IntegrationError('permission_ceiling', 'Source/history scopes cannot exceed Agent permissions.')
    }
    if (binding.discordHistory && (binding.target.kind !== 'channel' || binding.target.guildId !== binding.discordHistory.guildId)) throw new IntegrationError('history_scope', 'History requires a same-guild channel audience.')
    if (binding.tools.some(tool => !agent.tools.includes(tool)) ||
      binding.readDomains.some(domain => !agent.readDomains.includes(domain))) {
      throw new IntegrationError('permission_ceiling', 'Channel permissions cannot exceed the Agent permissions.')
    }
    if (binding.sourceFolders?.length) {
      if (!this.options.sources) throw new IntegrationError('source_unavailable','Source resources unavailable.')
      this.options.sources.validate(binding.sourceFolders)
    }
    if (binding.enabled) for (const id of binding.readDomains) this.options.memory.domain(id)
    if (!binding.observation && !binding.participants.everyone && !binding.participants.userIds.length && !binding.participants.roleIds.length) {
      throw new IntegrationError('empty_participants', 'Select at least one allowed user or role.')
    }
    if (binding.processor?.classifier) throw new IntegrationError('classifier_scope','Classifier capability is restricted to independently reviewed observation scopes.')
    if (binding.observation) {
      const scope = binding.observation
      if (bot.purpose !== 'service' || binding.target.kind !== 'channel' || binding.target.guildId !== scope.guildId || binding.target.channelId !== scope.audienceChannelId ||
        binding.sourceFolders?.length || binding.discordHistory || agent.sourceFolders?.length || agent.discordHistory || binding.manage || binding.inheritThreads || binding.processor || agent.execution !== 'restricted' || agent.tools.length || agent.readDomains.length ||
        binding.tools.length || binding.readDomains.length || binding.participants.everyone || binding.participants.userIds.length || binding.participants.roleIds.length) {
        throw new IntegrationError('observation_scope', 'Observation requires a dedicated same-guild output channel binding, restricted tool/domain-free Agent, no participants, management, threads or ordinary processor.')
      }
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
    if (change.kind === 'bot.save') {
      if (change.adoptLegacy) this.assertLegacyAdoption(change.package)
      const compiled = compileDiscordPackage(change.package)
      const previous = state.packages[change.package.id]
      const old = previous ? compileDiscordPackage(previous.active) : undefined
      if (old && old.agent.id !== compiled.agent.id) throw new IntegrationError('immutable_agent_id','A BOT update must preserve its Agent UUID.')
      if (!change.adoptLegacy && !old && (state.agents.some(a=>a.name === compiled.agent.name || a.id === compiled.agent.id) || this.options.agents.resolve(compiled.agent.name) || existsSync(this.agentDirectory(compiled.agent.name)))) throw new IntegrationError('agent_name_exists','BOT identity collides with an existing Agent.')
      const oldIds = new Set(old?.bindings.map(b=>b.id) ?? (change.adoptLegacy ? compiled.bindings.map(b=>b.id) : []))
      for (const binding of compiled.bindings) {
        if (state.bindings.some(b=>b.id === binding.id && !oldIds.has(b.id))) throw new IntegrationError('binding_owned','Binding belongs to another BOT or legacy configuration.')
      }
      agents = [...state.agents.filter(a=>a.id !== compiled.agent.id), {...compiled.agent,version:hash(compiled.agent),publishedAt:new Date().toISOString()}]
      bindings = [...state.bindings.filter(b=>!oldIds.has(b.id)), ...compiled.bindings]
      this.validateAgent(compiled.agent)
      if (new Set(bindings.map(targetKey)).size !== bindings.length) throw new IntegrationError('duplicate_binding','BOT target already belongs to another assignment.')
      for (const binding of compiled.bindings) this.validateBinding(binding,agents)
    } else {
      const owned = Object.values(state.packages).map(p=>compileDiscordPackage(p.active))
      if (change.kind === 'agent.save' && owned.some(p=>p.agent.id === change.agent.id) ||
          change.kind === 'bindings.save' && owned.some(p=>p.bindings.some(b=>change.bindings.some(next=>next.id === b.id)))) throw new IntegrationError('package_owned','Edit the complete BOT directory and review a new Release instead.')
    }
    const inspected: unknown[] = []
    if (change.kind === 'bindings.save' || change.kind === 'bot.save') {
      if (!this.transport) throw new IntegrationError('unavailable', 'Discord discovery is unavailable.', 503)
      for (const binding of (change.kind === 'bot.save' ? compileDiscordPackage(change.package).bindings : change.bindings).filter(binding => binding.enabled)) {
        signal.throwIfAborted()
        const live = await this.transport.inspectTarget(binding.botInstanceId, binding.target, signal)
        if (live.botUserId !== binding.botUserId) throw new IntegrationError('bot_identity_changed', 'The connected Bot identity changed. Refresh before assigning channels.', 409)
        if (binding.participants.roleIds.some(role => !live.roleIds.includes(role))) throw new IntegrationError('role_missing', 'An allowed role is no longer present in this server.', 409)
        inspected.push({ id: binding.id, bot: live.botUserId, roles: binding.participants.roleIds })
        if (binding.discordHistory) {
          const scope = binding.discordHistory
          const directory = await this.transport.directory(binding.botInstanceId, scope.guildId, undefined, signal)
          for (const channelId of scope.channelIds) {
            const channel = directory.channels.find(item => item.id === channelId)
            if (directory.botUserId !== binding.botUserId || directory.guildId !== scope.guildId || !channel || ![0,5,15,16].includes(channel.type) || !channel.canView || !channel.canReadHistory) throw new IntegrationError('history_scope', 'Selected history channel is unavailable in the live directory.')
          }
          inspected.push({ history: scope })
        }
        if (binding.observation?.enabled) {
          for (const channelId of binding.observation.channelIds) {
            const location = await this.transport.inspect(binding.botInstanceId,channelId,binding.botUserId,signal)
            if (location.botUserId !== binding.botUserId || location.location.guildId !== binding.observation.guildId ||
              location.location.id !== channelId || !location.canView) throw new IntegrationError('observation_permission','Bot cannot observe an exact selected channel.')
            inspected.push({scope:binding.id,channelId,guildId:location.location.guildId})
          }
        }
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
    if (change.kind === 'bot.save') compileDiscordPackage(change.package).agent.readDomains.forEach(id => domains.add(id))
    if (change.kind === 'agent.save') change.agent.readDomains.forEach(id => domains.add(id))
    if (change.kind === 'bindings.save') change.bindings.filter(binding => binding.enabled).forEach(binding => binding.readDomains.forEach(id => domains.add(id)))
    if (change.kind === 'knowledge.publish' || change.kind === 'domain.revoke') domains.add(change.domainId)
    const refs = [...domains].sort().map(id => { const domain = this.options.memory.domain(id); return { id, revision: domain.revision } })
    return { hash: hash({ inspected, refs, fileRevision }), fileRevision }
  }

  async propose(actor: IntegrationActor, raw: unknown, baseRevision: number, signal: AbortSignal, origin?: IntegrationDraft['origin']): Promise<IntegrationDraft> {
    const change = IntegrationChangeSchema.parse(raw)
    if (origin && (actor.kind !== 'owner' || change.kind !== 'bot.save')) throw new IntegrationError('owner_required','Timeline BOT reviews require an owner proposal.',403)
    if (change.kind === 'bot.save' && actor.kind !== 'owner') throw new IntegrationError('owner_required','BOT releases require owner review.',403)
    const before = this.snapshot()
    if (actor.kind !== 'owner' && (change.kind === 'bindings.save' && change.bindings.some(binding => binding.observation || before.bindings.find(old => old.id === binding.id)?.observation) ||
      change.kind === 'agent.save' && before.bindings.some(binding => binding.observation && binding.agentId === change.agent.id))) {
      throw new IntegrationError('observation_owner_review','Observation scopes and their Agents require owner review.')
    }
    if (actor.kind !== 'owner' && (change.kind === 'agent.save' && (change.agent.sourceFolders?.length || change.agent.discordHistory) || change.kind === 'bindings.save' && change.bindings.some(binding => binding.sourceFolders?.length || binding.discordHistory))) throw new IntegrationError('owner_required','Source and history grants require owner review.',403)
    if (before.drafts.some(draft => draft.status === 'applying')) throw new IntegrationError('recovery_required', 'An approved change needs recovery. Retry or resolve it in Reviews before proposing another change.', 409)
    if (this.committing || before.revision !== baseRevision) throw new IntegrationError('revision_conflict', 'Configuration changed. Refresh and review your changes again.', 409)
    const validation = await this.validate(change, signal)
    const validationHash = validation.hash
    signal.throwIfAborted()
    const state = this.snapshot()
    if (this.committing || state.revision !== baseRevision) throw new IntegrationError('revision_conflict', 'Configuration changed during validation.', 409)
    const pending = state.drafts.filter(draft => draft.status === 'applying' || draft.status === 'pending' && Date.parse(draft.expiresAt) > Date.now())
    if (pending.length >= 40) throw new IntegrationError('too_many_drafts', 'Resolve outstanding configuration reviews before creating more.', 409)
    const compiledReview = change.kind === 'bot.save' ? compileDiscordPackage(change.package) : undefined
    const id = randomUUID()
    const draft = IntegrationDraftSchema.parse({
      ...(compiledReview ? { resourceReview: {
        agent: {sourceFolders:compiledReview.agent.sourceFolders ?? [],discordHistory:compiledReview.agent.discordHistory ?? null},
        bindings:compiledReview.bindings.map(binding => ({id:binding.id,target:binding.target,sourceFolders:binding.sourceFolders ?? [],discordHistory:binding.discordHistory ?? null})),
      }} : {}),
      id, actor, baseRevision, change, validationHash, ...(origin ? {origin} : {}), hash: hash({ id, actor, baseRevision, change, validationHash, ...(origin ? {origin} : {}) }),
      ...(change.kind === 'agent.save' ? { agentFileHash: validation.fileRevision } : {}),
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      status: 'pending', affectedBindings: this.affected(change, state),
      warning: change.kind === 'bot.save' ? 'Frozen BOT source includes sourceFolders and discordHistory for Agent and each binding. Review exact registered Folder IDs, guild/channel allowlist, threads (none/public-active/public-archived, private threads excluded), and preEpoch (permission to read pre-authorization platform history, never old internal memory). Cross-channel output requires equivalent live audiences. No write, terminal or execution authority is granted. Drafts do not change the active release.'
        : change.kind === 'bindings.save' && change.bindings.some(binding => binding.observation)
        ? 'Owner-only observation review: selected source channels permit observation of nonparticipants but grant them no commands/tools. Evidence enters only a dedicated restricted service context and can be reported to the exact binding output audience, whose readers may differ from participants. Review source guild/channels, output privacy, frozen program, enable flag and model before approving. Metadata signatures are not visual hashes.'
        : change.kind === 'knowledge.publish'
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
        draft = { ...draft, status: 'applying', decidedAt: new Date().toISOString() }
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
    this.document.write({ ...state, drafts: state.drafts.map(item => item.id === id ? { ...item, status: 'cancelled', decidedAt: new Date().toISOString() } : item),
      audit: [...state.audit, { id: randomUUID(), at: new Date().toISOString(), actor: actor.id,
        kind: draft.status === 'applying' ? 'review.abandoned' : 'review.cancelled', revision: state.revision, affectedBindings: draft.affectedBindings }].slice(-1000),
    })
    for (const listener of this.listeners) listener([])
  }

  private assertLegacyAdoption(input: z.infer<typeof DiscordPackageSchema>): void {
    const state = this.snapshot()
    const compiled = compileDiscordPackage(input)
    if (state.packages[input.id] || Object.values(state.packages).some(p => compileDiscordPackage(p.active).agent.id === compiled.agent.id)) throw new IntegrationError('package_owned','Legacy Agent is already owned.')
    const existing = state.agents.find(a => a.id === compiled.agent.id)
    if (!existing) throw new IntegrationError('agent_missing','Legacy adoption requires an existing Agent.')
    const {version, publishedAt, ...policy} = existing
    const bindings = state.bindings.filter(b => b.agentId === existing.id).map(({epochRevision,...b}) => b)
    if (!isDeepStrictEqual(policy,compiled.agent) || !bindings.length || !isDeepStrictEqual(bindings.sort((a,b)=>a.id.localeCompare(b.id)),[...compiled.bindings].sort((a,b)=>a.id.localeCompare(b.id)))) throw new IntegrationError('adoption_policy_changed','Legacy adoption requires the complete identical approved Agent and assignments.')
  }

  private apply(draft: IntegrationDraft): void {
    const state = this.snapshot()
    if (state.revision !== draft.baseRevision) throw new IntegrationError('revision_conflict', 'Approved configuration cannot be applied over a newer version.', 409)
    const change = draft.change
    if (change.kind === 'bot.save') {
      if (change.adoptLegacy) this.assertLegacyAdoption(change.package)
      const compiled = compileDiscordPackage(change.package)
      const previous = state.packages[change.package.id]
      const old = previous ? compileDiscordPackage(previous.active) : undefined
      if (old && old.agent.id !== compiled.agent.id) throw new IntegrationError('immutable_agent_id','A BOT update must preserve its Agent UUID.')
      const oldIds = new Set(old?.bindings.map(b=>b.id) ?? (change.adoptLegacy ? compiled.bindings.map(b=>b.id) : []))
      const agent: IntegrationAgent = change.adoptLegacy ? state.agents.find(a=>a.id===compiled.agent.id)! : {...compiled.agent,version:hash(compiled.agent),publishedAt:draft.createdAt}
      state.agents = [...state.agents.filter(a=>a.id !== agent.id),agent]
      state.bindings = [...state.bindings.filter(b=>!oldIds.has(b.id)),...compiled.bindings.map(b=>({...b,epochRevision:(state.bindings.find(old=>old.id===b.id)?.epochRevision ?? 0)+(change.adoptLegacy ? 0 : 1)}))]
      const history = [...(previous?.history ?? []).filter(p=>hash(p)!==hash(change.package)),change.package].slice(-20)
      state.packages[change.package.id] = {active:change.package,revision:hash(change.package),history}
      // A single private-document write below switches source, Agent, processor and access together.
    } else if (change.kind === 'agent.save') {
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
      drafts: state.drafts.map(item => item.id === draft.id ? { ...item, status: 'applied', appliedRevision: revision, decidedAt: draft.decidedAt ?? new Date().toISOString() } : item),
      audit: [...state.audit, { id: draft.id, at: new Date().toISOString(), actor: draft.actor.id,
        kind: change.kind, revision, affectedBindings: draft.affectedBindings }].slice(-1000),
    })
    for (const listener of this.listeners) listener(draft.affectedBindings)
  }
}
