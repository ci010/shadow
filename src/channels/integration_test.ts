import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Hono } from 'hono'
import { z } from 'zod'
import { AgentTypesManager } from '../agent/types/manager.ts'
import { ContextBuilder } from '../agent/context/builder.ts'
import { IdentityManager } from '../agent/identity.ts'
import { BackgroundTaskManager } from '../agent/background-task.ts'
import { LearningRuntime } from '../agent/learning/pipelines.ts'
import { Bus } from '../bus/bus.ts'
import { channelSessionId, type ChannelAddress, type OutboundMessage } from '../bus/events.ts'
import { EventService } from '../events/service.ts'
import type { ChatMessage, LLMProvider, LLMResponse } from '../providers/provider.ts'
import { SessionManager } from '../sessions/session-manager.ts'
import { JsonlSessionStore } from '../sessions/session-store-jsonl.ts'
import { SqliteSessionStore } from '../sessions/session-store-sqlite.ts'
import type { SessionStore } from '../sessions/session-store.ts'
import { physicalSessionId } from '../sessions/session-identity.ts'
import { channelMessageInput, type SessionInput } from '../sessions/input.ts'
import { HandoffManager } from '../sessions/handoff/manager.ts'
import { SessionTools, Tools } from '../tools/registry.ts'
import { MemoryDomains } from '../memory/domains.ts'
import { BotInstanceStore } from './bot-store.ts'
import { IntegrationError, IntegrationStore } from './integration-store.ts'
import { DiscordIntegration } from './integration.ts'
import { DiscordLearning } from './integration-learning.ts'
import { discordIntegrationPlugin, ownerChannelConfigurationTool } from './integration-routes.ts'
import type { DiscordBinding, DiscordInspection, DiscordIntegrationTransport, IntegrationAgentInput, IntegrationChange } from './integration-contract.ts'
import { createDiscordIntegrationClient } from '../../app/src/discord-integration.ts'
import { PrivateDocument } from '../utils/private-document.ts'

const owner = { kind: 'owner', id: 'shadow-owner' } as const
const llm = { model: 'fixture', contextWindow: 128_000, temperature: 0 }
const signal = () => new AbortController().signal
const learningManifest = z.object({
  pipeline: z.enum(['reflector', 'encapsulator', 'soulReflector']),
  requiredInputs: z.array(z.object({ id: z.string(), version: z.string(), path: z.string() })),
  existingNames: z.array(z.object({ name: z.string(), version: z.string(), path: z.string() })),
})

function learningResponse(messages: ChatMessage[], save = true): LLMResponse {
  const input = messages.find(message => message.role === 'user')
  assert.equal(typeof input?.content, 'string')
  const manifest = learningManifest.parse(JSON.parse(String(input!.content)))
  const finished = new Set(messages.filter(message => message.role === 'tool').map(message => message.tool_call_id))
  const read = new Set(messages.flatMap(message => message.tool_calls ?? []).filter(call => call.function.name === 'read' && finished.has(call.id))
    .map(call => z.object({ path: z.string() }).parse(JSON.parse(call.function.arguments)).path))
  const remaining = [...manifest.requiredInputs, ...manifest.existingNames].filter(input => !read.has(input.path))
  if (remaining.length) return { content: '', toolCalls: remaining.slice(0, 16).map(input => ({
    id: randomUUID(), name: 'read', arguments: { path: input.path },
  })) }
  const returned = (name: string) => messages.some(message => message.role === 'tool' && message.name === name)
  if (save && !returned('learning_record')) {
    const source = JSON.stringify(messages).includes('CUSTOMER_A_LEARNING_CANARY') ? 'CUSTOMER_A_LEARNING_CANARY'
      : JSON.stringify(messages).includes('CUSTOMER_B_LEARNING_CANARY') ? 'CUSTOMER_B_LEARNING_CANARY' : 'Scoped lesson'
    return { content: '', toolCalls: [{ id: randomUUID(), name: 'learning_record', arguments: {
      name: 'context-lesson', title: `Scoped ${manifest.pipeline}`,
      content: `# When\nOnly this conversation.\n# Goal\nHelp the same customer.\n# Why\n${source}\n# Exceptions\nRevalidate new evidence.\n# Confidence\nStated synthetic fixture.`,
      revision: manifest.existingNames.find(item => item.name === 'context-lesson')?.version ?? '',
    } }] }
  }
  if (!returned('learning_result')) return { content: '', toolCalls: [{ id: randomUUID(), name: 'learning_result', arguments: {
    status: !save ? 'no_change' : manifest.pipeline === 'soulReflector' ? 'draft_only' : 'applied', summary: 'Reviewed the exact bounded input.',
  } }] }
  return { content: 'Scoped batch finished; no global publication.', toolCalls: [] }
}

async function until(check: () => boolean) {
  const deadline = Date.now() + 5000
  while (!check()) {
    assert(Date.now() < deadline, 'Timed out waiting for integration fixture')
    await delay(2)
  }
}

async function fixture(t: TestContext, Store = JsonlSessionStore as typeof JsonlSessionStore | typeof SqliteSessionStore) {
  const root = await mkdtemp(join(process.cwd(), '.discord-integration-test-'))
  const home = join(root, 'home')
  await mkdir(home)
  const projectId = 'integration-project'
  const agents = new AgentTypesManager(home)
  await agents.load()
  const bots = new BotInstanceStore({ projectId, path: join(root, 'bots.json') })
  const bot = bots.create('discord', 'Help desk', { token: 'synthetic-token', enabled: true })
  const botIdentities = new Map([[bot.id, '900']])
  const botUser = (id: string) => { const user = botIdentities.get(id); assert(user, 'Unknown fixture Bot'); return user }
  const memory = new MemoryDomains(projectId, join(root, 'domains'))
  const config = new IntegrationStore({ projectId, workspace: home, directory: join(root, 'config'), bots, agents, memory })
  const tools = new Tools(home)
  let escaped = false
  for (const name of ['exec', 'write', 'invoke_tool']) tools.register({
    name, description: name, parameters: { type: 'object', properties: {} },
    execute: async () => { escaped = true; return 'PRIVATE_TOOL_CANARY' },
  })
  const integration = new DiscordIntegration({ projectId, workspace: home, store: config, bots, memory, baseTools: tools })
  const requests: Array<{ messages: ChatMessage[]; tools: string[] }> = []
  const responses: LLMResponse[] = []
  let respond: ((messages: ChatMessage[], tools: string[]) => LLMResponse) | undefined
  let held: Promise<LLMResponse> | undefined
  const provider: LLMProvider = {
    name: 'fixture', listModels: () => ['fixture'],
    chat: async (messages, definitions, options) => {
      requests.push({ messages: structuredClone(messages), tools: definitions.map(tool => tool.function.name) })
      if (held) {
        const pending = held; held = undefined
        return Promise.race([pending, new Promise<never>((_, reject) => {
          options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true })
        })])
      }
      return respond?.(messages, definitions.map(tool => tool.function.name)) ?? responses.shift() ?? { content: 'Safe answer', toolCalls: [] }
    },
  }
  const bus = new Bus()
  const outbound: OutboundMessage[] = []
  bus.on('message.outbound', message => { outbound.push(message) })
  const storage: SessionStore = new Store(join(root, 'sessions'))
  await storage.init()
  const events = new EventService(home, bus, (id, input) => sessions.deliver(id, input))
  const tasks = new BackgroundTaskManager(bus, events)
  const handoff = new HandoffManager(provider, llm.contextWindow, { autoHandoff: false }, home, storage)
  const context = new ContextBuilder(home)
  context.register({ name: 'private', getPromptSection: () => 'PRIVATE_PROJECT_CANARY PRIVATE_SOUL_CANARY' })
  const sessions: SessionManager = new SessionManager({
    projectId, workspace: home, store: storage, bus, provider, tools, conversationPolicies: integration,
    context, handoffManager: handoff, agentTypes: agents, identity: new IdentityManager(home),
    events, backgroundTasks: tasks, getLlmRuntimeConfig: () => llm,
  })
  const inspections = new Map<string, Partial<DiscordInspection>>()
  const transport: DiscordIntegrationTransport = {
    directory: async (botId, guildId) => ({ botUserId: botUser(botId), guilds: [{ id: '100', name: 'Our server', icon: null }],
      guildId: guildId ?? null, guildCursor: null, channels: [], roles: [{ id: '700', name: 'Support' }],
      synchronizedAt: new Date().toISOString(), completeness: 'guild-page', notice: 'Synthetic directory' }),
    members: async botId => { botUser(botId); return [{ id: '500', name: 'Member', username: 'support-member' }] },
    inspectTarget: async botId => ({ botUserId: botUser(botId), roleIds: ['700'] }),
    inspect: async (botId, chatId, senderId) => ({
      botUserId: botUser(botId),
      location: { id: chatId, name: `Channel ${chatId}`, type: chatId === '203' ? 11 : chatId === '204' ? 1 : 0,
        guildId: chatId === '204' ? null : '100', guildName: 'Our server',
        parentId: chatId === '203' ? '201' : null, parentName: null, recipientId: chatId === '204' ? senderId : null },
      actor: { id: senderId, name: 'Member', roleIds: ['700'] }, canView: true, canSend: true, canReadHistory: true,
      ...inspections.get(chatId),
    }),
  }
  tools.register(ownerChannelConfigurationTool(config, memory, transport))
  integration.attach(sessions, transport, async (request, context) => {
    const messages = [
      { conversationId: context.chatId, timestamp: '2000-01-01T00:00:00.000Z', content: 'OLD_HISTORY_CANARY' },
      { conversationId: context.chatId, timestamp: new Date().toISOString(), content: 'CURRENT_DISCORD_MESSAGE' },
    ]
    return request.name === 'discord_message_get' ? { message: messages[request.args.messageId === '1' ? 0 : 1] }
      : { messages, nextBefore: '1' }
  })
  await sessions.start()
  const approve = async (change: IntegrationChange) => {
    const draft = await config.propose(owner, change, config.snapshot().revision, signal())
    await config.commit(owner, draft.id, draft.hash, signal())
    return draft
  }
  const profile: IntegrationAgentInput = {
    id: randomUUID(), name: 'discord-helper', displayName: 'Support Agent',
    markdown: '---\nname: discord-helper\ndescription: Customer support\ndefaultMode: session\nmodel: fixture\n---\nAnswer support questions using approved memory.',
    execution: 'restricted', tools: ['read', 'search', 'memory_save', 'learned_skill', 'discord_history', 'discord_message_get', 'subagent'], readDomains: [], skills: [],
  }
  await approve({ kind: 'agent.save', agent: profile })
  const makeBinding = (channelId: string, extra: Partial<DiscordBinding> = {}): DiscordBinding => ({
    id: randomUUID(), botInstanceId: bot.id, botUserId: '900', target: { kind: 'channel', guildId: '100', channelId },
    enabled: true, agentId: profile.id, trigger: 'mention', participants: { everyone: false, userIds: [], roleIds: ['700'] },
    tools: [...profile.tools], readDomains: [], inheritThreads: true, manage: false, ...extra,
  })
  const a = makeBinding('201'), b = makeBinding('202')
  await approve({ kind: 'bindings.save', bindings: [a, b] })
  const address = (chatId = '201', instance = bot): ChannelAddress => ({ projectId, botInstanceId: instance.id, platform: 'discord', conversationId: chatId })
  const id = (chatId = '201', instance = bot) => channelSessionId(address(chatId, instance))
  async function input(chatId = '201', text = 'Hello', instance = bot) {
    const messageId = randomUUID()
    const admitted = await integration.prepareIngress(instance.id, { chatId, senderId: '500', messageId }, signal())
    return channelMessageInput({ channelAddress: address(chatId, instance), channel: 'discord', chatId, senderId: '500',
      senderName: 'Member', content: text, messageId, timestamp: new Date().toISOString(), isGroup: chatId !== '204',
      admin: true, channelAdmissionId: admitted.admissionId, channelLocation: admitted.location })
  }
  async function deliver(sessionId: string, message: SessionInput) {
    const finished = Promise.withResolvers<void>()
    const subscription = bus.on('session.turn.finished', fact => {
      if (fact.sessionId === sessionId && fact.inputId === message.id) finished.resolve()
    })
    const timer = setTimeout(() => finished.reject(new Error('Timed out waiting for this exact input to finish')), 5000)
    try { await sessions.deliver(sessionId, message); await finished.promise }
    finally { clearTimeout(timer); bus.off(subscription) }
  }
  async function send(chatId = '201', text = 'Hello', instance = bot) {
    await deliver(id(chatId, instance), await input(chatId, text, instance))
  }
  const learning = new DiscordLearning({ projectId, directory: join(root, 'learning'), runtime: integration, sessions, memory })
  const app = new Hono()
  discordIntegrationPlugin({ store: config, runtime: integration, transport, bots, memory, agents, sessions,
    learning, authorize: request => request.headers.get('x-owner') === 'yes' })(app)
  t.after(async () => {
    await sessions.stop(); integration.stop(); await handoff.stop(); await tasks.stop(); await events.stop()
    bus.stopAll(); await agents.stopWatching(); storage.close?.(); await rm(root, { recursive: true, force: true })
  })
  return { root, home, projectId, agents, bots, bot, memory, config, integration, sessions, storage, requests,
    responses, outbound, inspections, profile, a, b, approve, id, input, send, deliver, app, address, learning, handoff,
    respondWith: (handler: typeof respond) => { respond = handler },
    addBot: (userId: string) => {
      const added = bots.create('discord', `Bot ${userId}`, { token: `fixture-${userId}`, enabled: true })
      botIdentities.set(added.id, userId); return added
    },
    hold: (promise: Promise<LLMResponse>) => { held = promise }, escaped: () => escaped }
}

for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  test(`${Store.name}: owner coordinator discovers unassigned named Bots and drafts through its real tool loop, never approving`, async t => {
    const f = await fixture(t, Store)
    const unassigned = f.addBot('901')
    const qq = f.bots.create('qq', 'QQ support', { enabled: false })
    const feishu = f.bots.create('feishu', 'Feishu support', { enabled: false })
    await f.sessions.buildSession('web:orchestrator', undefined, {
      mode: 'session', agentType: 'orchestrator', sessionKind: 'orchestrator',
    })
    const base = f.config.snapshot().revision
    f.responses.push({ content: '', toolCalls: [
      { id: 'schema', name: 'channel_config', arguments: { action: 'schema' } },
      { id: 'list', name: 'channel_config', arguments: { action: 'list' } },
      { id: 'directory', name: 'channel_config', arguments: { action: 'directory', botId: unassigned.id } },
      { id: 'members', name: 'channel_config', arguments: { action: 'members', botId: unassigned.id, guildId: '100', query: 'Member' } },
      { id: 'file', name: 'channel_config', arguments: { action: 'agent_file', agentId: f.profile.id } },
      { id: 'propose', name: 'channel_config', arguments: { action: 'propose', botId: unassigned.id, baseRevision: base,
        changeJson: JSON.stringify({ kind: 'agent.save', agent: { ...f.profile, markdown: f.profile.markdown + '\nOWNER_CHAT_DRAFT' } }) } },
    ] })
    const ownerMessage = () => channelMessageInput({ channel: 'web', chatId: 'orchestrator', senderId: 'owner',
      content: 'Configure the named Discord support Bot', messageId: randomUUID(), timestamp: new Date().toISOString(), admin: true })
    await f.deliver('web:orchestrator', ownerMessage())
    assert(f.requests.every(request => request.tools.includes('channel_config')))
    const outputs = f.requests.flatMap(request => request.messages).filter(message => message.role === 'tool')
    const output = (id: string) => JSON.parse(String(outputs.find(message => message.tool_call_id === id)?.content))
    const listed = z.object({ projectId: z.string(), bots: z.array(z.object({
      id: z.string(), displayName: z.string(), platform: z.literal('discord'), enabled: z.boolean(),
    }).strict()) }).parse(output('list'))
    assert.equal(listed.projectId, f.projectId)
    assert.deepEqual(listed.bots.map(bot => bot.displayName), ['Help desk', 'Bot 901'])
    assert.equal(listed.bots[1]!.id, unassigned.id)
    assert.deepEqual(output('list').otherPlatformBots, [
      { id: qq.id, displayName: 'QQ support', platform: 'qq', enabled: false, authoringTool: 'authoring_change' },
      { id: feishu.id, displayName: 'Feishu support', platform: 'feishu', enabled: false, authoringTool: 'authoring_change' },
    ])
    assert.match(output('list').otherPlatformWorkflow, /inventory.conversations/)
    assert.match(output('list').otherPlatformWorkflow, /owner approves/)
    assert(!JSON.stringify(f.requests).includes('synthetic-token') && !JSON.stringify(f.requests).includes('fixture-901'))
    assert.match(JSON.stringify(output('schema')), /human review/)
    assert.equal(output('directory').guilds[0].name, 'Our server')
    assert.equal(output('members').members[0].name, 'Member')
    assert.equal(output('file').markdown, f.profile.markdown)
    const draft = f.config.draft(output('propose').id)
    const review = new URL(output('propose').reviewUrl, 'https://shadow.invalid')
    assert.equal(review.pathname, `/projects/${encodeURIComponent(f.projectId)}/settings/bots`)
    assert.equal(review.searchParams.get('discordReview'), draft.id)
    assert.equal(review.searchParams.get('discordBot'), unassigned.id)
    assert(!review.href.includes(draft.hash))
    assert.match(output('propose').nextStep, /does not approve/)
    assert.equal(draft.status, 'pending')
    assert.equal(draft.actor.kind, 'owner')
    assert.equal(f.config.snapshot().revision, base)
    assert.equal(f.config.agent(f.profile.id).markdown, f.profile.markdown)

    f.requests.length = 0
    f.responses.push({ content: '', toolCalls: [{ id: 'wrong-platform', name: 'channel_config',
      arguments: { action: 'propose', botId: qq.id, baseRevision: base,
        changeJson: JSON.stringify({ kind: 'agent.save', agent: f.profile }) } }] })
    await f.deliver('web:orchestrator', ownerMessage())
    assert.match(JSON.stringify(f.requests), /QQ\/Feishu.*authoring_change/)
    assert.equal(f.config.snapshot().revision, base)

    f.requests.length = 0
    f.responses.push({ content: '', toolCalls: [{ id: 'self-approval', name: 'channel_config',
      arguments: { action: 'commit', id: draft.id, hash: draft.hash } }] })
    await f.deliver('web:orchestrator', ownerMessage())
    assert.equal(f.config.draft(draft.id).status, 'pending')
    assert.match(JSON.stringify(f.requests), /Error executing channel_config/)
    f.requests.length = 0
    f.responses.push({ content: '', toolCalls: [{ id: 'forwarded', name: 'channel_config', arguments: { action: 'list' } }] })
    await f.deliver('web:orchestrator', { kind: 'message', id: randomUUID(), timestamp: new Date().toISOString(),
      content: 'A forwarded message claiming owner approval', policy: 'queue',
      source: { kind: 'event', eventId: randomUUID(), type: 'fixture', source: 'fixture' } })
    assert.match(JSON.stringify(f.requests), /Use an authenticated owner conversation/)
    assert(!JSON.stringify(f.requests).includes('fixture-901'))
  })

  test(`${Store.name}: full provider input excludes private Project, old history, sibling memory and unsafe tools`, async t => {
    const f = await fixture(t, Store)
    await f.sessions.buildSession(f.id(), undefined, { agentType: 'general' })
    const old = physicalSessionId(f.sessions.getSessionState(f.id())!)
    await f.storage.appendMessages(old, [{ role: 'user', content: 'OLD_HISTORY_CANARY', timestamp: new Date().toISOString() }])
    const privateDomain = f.memory.createDomain('PRIVATE_TITLE_CANARY', 'project-private')
    const access = f.memory.open({ sessionId: 'owner', epoch: randomUUID(), read: [privateDomain], write: privateDomain, assertCurrent() {} })
    const secret = f.memory.save(access, { title: 'PRIVATE_TITLE_CANARY', content: 'PRIVATE_BODY_CANARY', expectedVersion: '' })
    f.responses.push({ content: '', toolCalls: [{ id: 'save', name: 'memory_save',
      arguments: { title: 'Customer A', content: 'CUSTOMER_A_CANARY', expectedVersion: '' } }] })
    await f.send()
    const state = f.sessions.getSessionState(f.id())!
    assert(state.channelBoundary)
    assert.equal(state.segmentIndex, 1)
    assert.notEqual(physicalSessionId(state), old)
    assert.equal((await f.sessions.getHistory(f.id(), { physicalId: old })).messages[0].content, 'OLD_HISTORY_CANARY')
    assert.deepEqual((await f.storage.getState(f.id()))?.channelBoundary, state.channelBoundary)
    f.requests.length = 0
    f.responses.push({ content: '', toolCalls: [
      { id: 'read-secret', name: 'read', arguments: { path: `v:memory/${privateDomain.id}/${secret.id}` } },
      { id: 'read-raw', name: 'read', arguments: { path: 'SOUL.md' } },
      { id: 'dynamic', name: 'invoke_tool', arguments: { name: 'exec', args: {} } },
      { id: 'history', name: 'discord_history', arguments: {} },
    ] })
    await f.send('202')
    const serialized = JSON.stringify(f.requests.map(request => request.messages))
    assert(serialized.includes('CURRENT_DISCORD_MESSAGE'), 'The real history envelope passed validation and epoch filtering')
    for (const canary of ['PRIVATE_PROJECT_CANARY', 'PRIVATE_SOUL_CANARY', 'PRIVATE_BODY_CANARY', 'CUSTOMER_A_CANARY', 'OLD_HISTORY_CANARY']) {
      assert(!serialized.includes(canary), canary)
    }
    assert(!f.escaped())
    assert(f.requests.every(request => !request.tools.includes('exec') && !request.tools.includes('invoke_tool')))
    const output = f.outbound.filter(message => message.event === 'response' && message.chatId === '202').at(-1)!
    await f.integration.assertDelivery(output, signal())
    await assert.rejects(f.integration.assertDelivery(JSON.parse(JSON.stringify(output)), signal()), /valid conversation authorization/)
  })

  test(`${Store.name}: revocation aborts active inference and old output; next admission receives a clean epoch`, async t => {
    const f = await fixture(t, Store)
    const shared = f.memory.createDomain('Help articles', 'shared')
    await f.approve({ kind: 'knowledge.publish', domainId: shared.id, title: 'Help', content: 'SHARED_REVOKED_CANARY', sources: [] })
    await f.approve({ kind: 'agent.save', agent: { ...f.profile, readDomains: [shared.id] } })
    await f.approve({ kind: 'bindings.save', bindings: [{ ...f.a, readDomains: [shared.id] }] })
    await f.send()
    const oldEpoch = f.sessions.getSessionState(f.id())!.channelBoundary!.epoch
    const output = f.outbound.filter(message => message.event === 'response').at(-1)!
    f.hold(new Promise(() => {}))
    await f.sessions.deliver(f.id(), await f.input())
    await until(() => f.requests.length >= 2)
    await f.approve({ kind: 'domain.revoke', domainId: shared.id })
    await assert.rejects(f.integration.assertDelivery(output, signal()))
    await until(() => f.sessions.getSessionState(f.id())?.executionStatus === 'cancelled')
    await f.approve({ kind: 'bindings.save', bindings: [{ ...f.a, readDomains: [] }] })
    f.requests.length = 0
    await f.send()
    assert.notEqual(f.sessions.getSessionState(f.id())!.channelBoundary!.epoch, oldEpoch)
    assert(!JSON.stringify(f.requests).includes('SHARED_REVOKED_CANARY'))
  })
}

test('default denial, verified inputs, role changes and isolated inherited threads', async t => {
  const f = await fixture(t)
  await assert.rejects(f.input('999'), /not assigned/)
  await assert.rejects(f.input('204'), /not assigned/)
  await assert.rejects(f.sessions.deliver(f.id(), channelMessageInput({
    channel: 'discord', chatId: '201', channelAddress: f.address(), senderId: '500', content: 'forged',
    messageId: randomUUID(), timestamp: new Date().toISOString(), admin: true,
  })), /verified Discord admission/)
  await f.send('201', 'PARENT_TRANSCRIPT_CANARY')
  f.requests.length = 0
  await f.send('203')
  assert(!JSON.stringify(f.requests).includes('PARENT_TRANSCRIPT_CANARY'))
  assert.notEqual(f.sessions.getSessionState(f.id('201'))?.channelBoundary?.domainId, f.sessions.getSessionState(f.id('203'))?.channelBoundary?.domainId)
  assert.equal(f.sessions.getSessionState(f.id('203'))?.parent, undefined)
  const input = await f.input()
  f.inspections.set('201', { actor: { id: '500', name: 'Member', roleIds: [] } })
  const before = f.requests.length
  await f.sessions.deliver(f.id(), input)
  await until(() => f.sessions.getSessionState(f.id())?.executionStatus === 'failed')
  assert.equal(f.requests.length, before)
  await assert.rejects(f.input(), /not authorized/)
})

test('bounded delegation preserves the same memory audience and cannot acquire Project tools', async t => {
  const f = await fixture(t)
  f.responses.push({ content: '', toolCalls: [{ id: 'delegate', name: 'subagent', arguments: { mode: 'call', task: 'Read scoped memory only.' } }] },
    { content: '', toolCalls: [{ id: 'child-read', name: 'read', arguments: { path: 'v:memory' } }] },
    { content: 'Child checked scoped memory.', toolCalls: [] })
  await f.send()
  const child = f.sessions.listSessions().find(row => row.mode === 'call')
  assert(child)
  const state = f.sessions.getSessionState(child.sessionId)!
  assert.equal(state.channelBoundary?.ownerSessionId, f.id())
  assert.equal(state.channelBoundary?.epoch, f.sessions.getSessionState(f.id())?.channelBoundary?.epoch)
  assert(f.requests.length >= 4)
  assert(!f.requests[1].tools.includes('subagent'))
  assert(!JSON.stringify(f.requests).includes('PRIVATE_PROJECT_CANARY'))
  assert.equal((await new LearningRuntime(f.sessions, f.projectId).sources(signal())).length, 0)
})

test('owner API requires authorization and exact reviewed revision; reconnect persistence and manual edits fail closed', async t => {
  const f = await fixture(t)
  assert.equal((await f.app.request('/api/integrations/discord')).status, 401)
  assert.equal((await f.app.request('/api/integrations/discord', { headers: { 'x-owner': 'yes' } })).status, 200)
  const draft = await f.config.propose(owner, { kind: 'bindings.save', bindings: [{ ...f.a, trigger: 'all' }] }, f.config.snapshot().revision, signal())
  await assert.rejects(f.config.commit(owner, draft.id, '0'.repeat(64), signal()), /another actor or version/)
  const result = await f.config.commit(owner, draft.id, draft.hash, signal())
  assert.equal(result.status, 'applied')
  assert.equal((await f.config.commit(owner, draft.id, draft.hash, signal())).appliedRevision, result.appliedRevision)
  const stale = await f.config.propose(owner, { kind: 'bindings.save', bindings: [f.a] }, f.config.snapshot().revision, signal())
  await f.approve({ kind: 'domain.create', name: 'Another shared area', domainKind: 'shared' })
  await assert.rejects(f.config.commit(owner, stale.id, stale.hash, signal()), /expired or configuration changed/)
  const reopened = new IntegrationStore({ ...f.config.options })
  assert.equal(reopened.snapshot().revision, f.config.snapshot().revision)
  await writeFile(join(f.home, 'agents', f.profile.name, 'AGENT.md'), 'PRIVATE_EDIT_CANARY')
  await assert.rejects(f.input(), /changed outside/)
})

test('the frontend client consumes real route schemas, binds exact reviews and rejects aborted stale responses', async t => {
  const f = await fixture(t)
  const request: typeof fetch = (input, init) => Promise.resolve(f.app.request(new Request(input, {
    ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), 'x-owner': 'yes' },
  })))
  const client = createDiscordIntegrationClient('http://fixture.invalid', f.projectId, request)
  const overview = await client.overview(signal())
  assert.equal(overview.agents[0].id, f.profile.id)
  assert.equal((await client.directory(f.bot.id, signal(), '100')).guilds[0].name, 'Our server')
  const preview = await client.preview(f.bot.id, '201', '500', signal())
  assert.equal(preview.projectId, f.projectId)
  assert(!preview.systemPrompt.includes('PRIVATE_PROJECT_CANARY'))
  const draft = await client.propose({ kind: 'domain.create', name: 'Reviewed help', domainKind: 'shared' }, overview.revision, signal())
  assert.equal((await client.commit(draft.id, draft.hash, signal())).status, 'applied')
  await assert.rejects(createDiscordIntegrationClient('http://fixture.invalid', 'another-project', request).overview(signal()), /another Project/)
  const wrong = createDiscordIntegrationClient('http://fixture.invalid', f.projectId, async () =>
    Response.json({ ...draft, status: 'applied', hash: '0'.repeat(64) }))
  await assert.rejects(wrong.commit(draft.id, draft.hash, signal()), /exact review/)
  const pending = Promise.withResolvers<Response>()
  const controller = new AbortController()
  const reading = createDiscordIntegrationClient('http://fixture.invalid', f.projectId, async () => pending.promise).overview(controller.signal)
  controller.abort()
  pending.resolve(Response.json(overview))
  await assert.rejects(reading, /abort/i)
})

test('same Bot routes two Agents independently; reconnect invalidates queued outputs and permissions cannot silently grow', async t => {
  const f = await fixture(t)
  const agent = { ...f.profile, id: randomUUID(), name: 'discord-operations', displayName: 'Operations',
    markdown: '---\nname: discord-operations\ndefaultMode: session\n---\nOPERATIONS_AGENT_CANARY', tools: ['read'] as const }
  await f.approve({ kind: 'agent.save', agent: { ...agent, tools: [...agent.tools] } })
  await f.approve({ kind: 'bindings.save', bindings: [{ ...f.b, agentId: agent.id, tools: ['read'] }] })
  await f.send()
  assert(!JSON.stringify(f.requests).includes('OPERATIONS_AGENT_CANARY'))
  const output = f.outbound.filter(message => message.event === 'response').at(-1)!
  await f.integration.assertDelivery(output, signal())
  f.integration.invalidateBot(f.bot.id)
  await assert.rejects(f.integration.assertDelivery(output, signal()), /authorization/)
  f.requests.length = 0
  await f.send('202')
  assert(JSON.stringify(f.requests).includes('OPERATIONS_AGENT_CANARY'))
  assert.deepEqual(f.requests[0].tools, ['read'])
  await f.approve({ kind: 'agent.save', agent: { ...f.profile, tools: ['read'] } })
  assert.deepEqual(f.config.bindings().find(binding => binding.id === f.a.id)?.tools, ['read'])
  await assert.rejects(f.approve({ kind: 'bindings.save', bindings: [{ ...f.a, tools: ['exec'] }] }), /cannot exceed/)
})

test('queued output cannot outlive deletion and recreation of its conversation epoch', async t => {
  const f = await fixture(t)
  await f.send()
  const output = f.outbound.filter(message => message.event === 'response').at(-1)!
  const epoch = f.sessions.getSessionState(f.id())!.channelBoundary!.epoch
  await f.integration.assertDelivery(output, signal())
  await f.sessions.deleteSession(f.id())
  await assert.rejects(f.integration.assertDelivery(output, signal()), /context changed/)
  await f.send()
  assert.notEqual(f.sessions.getSessionState(f.id())!.channelBoundary!.epoch, epoch)
  await assert.rejects(f.integration.assertDelivery(output, signal()), /context changed/)
})

test('compaction and learned instructions retain provenance and never enter sibling or legacy Project learning', async t => {
  const f = await fixture(t)
  f.responses.push({ content: '', toolCalls: [{ id: 'learn', name: 'learned_skill', arguments: {
    action: 'save', name: 'Customer A workflow', content: 'LEARNED_A_CANARY', expectedVersion: '',
  } }] })
  await f.send('201', 'CUSTOMER_A_CONTEXT_CANARY')
  const scope = structuredClone(f.sessions.getSessionState(f.id())!.channelBoundary!)
  const before = f.sessions.getSessionState(f.id())!.segmentIndex
  f.requests.length = 0
  f.responses.push({ content: '', toolCalls: [{ id: 'summary', name: 'handoff_summary',
    arguments: { summary: 'HANDOFF_A_CANARY', currentObjective: 'Continue support', recentTranscript: [] } }] })
  assert.equal(f.sessions.requestCompact(f.id(), llm), true)
  await until(() => f.sessions.getSessionState(f.id())!.segmentIndex > before)
  assert.equal(f.sessions.getSessionState(f.id())!.channelBoundary!.epoch, scope.epoch)
  const summary = (await f.sessions.getHistory(f.id(), { shallow: true })).messages.find(message => message.name === '__compaction_summary__')
  assert.match(String(summary?.content), /read\("v:memory"\)/)
  assert(!String(summary?.content).includes('read("v:sessions/'))
  assert(f.requests.every(request => request.tools.length === 1 && request.tools[0] === 'handoff_summary'))
  assert(!JSON.stringify(f.requests).includes('PRIVATE_PROJECT_CANARY'))
  const resources = f.memory.ownerResources().filter(resource => resource.domainId === scope.domainId)
  assert(resources.some(resource => resource.kind === 'skill'))
  assert(resources.some(resource => resource.kind === 'summary'))
  assert(resources.every(resource => resource.sources.some(source => source.sessionId === f.id() && source.epoch === scope.epoch)))
  assert(!existsSync(join(f.home, 'memory', 'sessions')), 'Scoped handoff never writes into legacy Project session memory')
  f.requests.length = 0
  f.responses.push({ content: '', toolCalls: [{ id: 'skills', name: 'learned_skill', arguments: { action: 'list' } }] })
  await f.send('202')
  assert(!/LEARNED_A_CANARY|HANDOFF_A_CANARY|CUSTOMER_A_CONTEXT_CANARY/.test(JSON.stringify(f.requests)))
  assert.equal((await new LearningRuntime(f.sessions, f.projectId).sources(signal())).length, 0)
})

test('revocation cancels scoped compaction without publishing a stale summary or continuation', async t => {
  const f = await fixture(t)
  await f.send('201', 'OLD_COMPACTION_CANARY')
  const old = structuredClone(f.sessions.getSessionState(f.id())!)
  const original = f.handoff.create.bind(f.handoff)
  const finished = Promise.withResolvers<void>()
  t.mock.method(f.handoff, 'create', async (...args: Parameters<HandoffManager['create']>) => {
    try { return await original(...args) } finally { finished.resolve() }
  })
  f.requests.length = 0
  f.hold(new Promise(() => {}))
  assert.equal(f.sessions.requestCompact(f.id(), llm), true)
  await until(() => f.requests.length > 0)
  await f.approve({ kind: 'bindings.save', bindings: [{ ...f.a, tools: ['read'] }] })
  await finished.promise
  assert.equal(f.sessions.getSessionState(f.id())!.segmentIndex, old.segmentIndex)
  assert(!f.memory.ownerResources().some(resource => resource.kind === 'summary'))
  assert(!existsSync(join(f.home, 'memory', 'sessions')))
  f.requests.length = 0
  await f.send('201', 'New authorization context')
  assert(!JSON.stringify(f.requests).includes('OLD_COMPACTION_CANARY'))
})

test('authorized chat discovery drafts a bounded Agent; only the same current human manager can confirm', async t => {
  const f = await fixture(t)
  const tools: IntegrationAgentInput['tools'] = [...f.profile.tools, 'channel_config']
  await f.approve({ kind: 'agent.save', agent: { ...f.profile, tools } })
  await f.approve({ kind: 'bindings.save', bindings: [{ ...f.a, tools, manage: true }] })
  const agent: IntegrationAgentInput = { ...f.profile, id: randomUUID(), name: 'chat-created', displayName: 'Chat support',
    markdown: '---\nname: chat-created\ndefaultMode: session\n---\nHelp this channel.' }
  f.responses.push({ content: '', toolCalls: [
    { id: 'schema', name: 'channel_config', arguments: { action: 'schema' } },
    { id: 'directory', name: 'channel_config', arguments: { action: 'directory', guildId: '100' } },
    { id: 'members', name: 'channel_config', arguments: { action: 'members', guildId: '100', query: 'Member' } },
    { id: 'proposal', name: 'channel_config', arguments: { action: 'propose', baseRevision: f.config.snapshot().revision,
      changeJson: JSON.stringify({ kind: 'agent.save', agent }) } },
  ] })
  await f.send()
  assert(JSON.stringify(f.requests).includes('Our server'))
  const draft = f.config.snapshot().drafts.find(draft => draft.change.kind === 'agent.save' && draft.change.agent.id === agent.id)!
  assert.equal(draft.status, 'pending')
  await assert.rejects(f.integration.confirmChat(f.bot.id, '201', '501', draft.id, draft.hash, signal()), /another actor/)
  await assert.rejects(f.integration.confirmChat(f.bot.id, '202', '500', draft.id, draft.hash, signal()), /management channel/)
  assert.equal((await f.integration.confirmChat(f.bot.id, '201', '500', draft.id, draft.hash, signal())).status, 'applied')
  assert.equal(f.config.agent(agent.id).managementBindingId, f.a.id)
  f.responses.push({ content: '', toolCalls: [{ id: 'escape', name: 'channel_config', arguments: {
    action: 'propose', baseRevision: f.config.snapshot().revision,
    changeJson: JSON.stringify({ kind: 'agent.save', agent: { ...agent, execution: 'trusted', tools: ['exec'] } }),
  } }] })
  await f.send()
  assert(JSON.stringify(f.requests).includes('exceeds this manager scope'))
  assert.equal(f.config.agent(agent.id).execution, 'restricted')
})

test('revoked domains can be disabled and interrupted approvals preserve manual Agent edits', async t => {
  const f = await fixture(t)
  const domain = f.memory.createDomain('Temporary help', 'shared')
  await f.approve({ kind: 'agent.save', agent: { ...f.profile, readDomains: [domain.id] } })
  await f.approve({ kind: 'bindings.save', bindings: [{ ...f.a, readDomains: [domain.id] }] })
  await f.approve({ kind: 'domain.revoke', domainId: domain.id })
  await f.approve({ kind: 'bindings.save', bindings: [{ ...f.a, readDomains: [domain.id], enabled: false }] })
  const next = { ...f.profile, markdown: f.profile.markdown + '\nReviewed edit.' }
  const draft = await f.config.propose(owner, { kind: 'agent.save', agent: next }, f.config.snapshot().revision, signal())
  const original = f.agents.setWorkspaceType.bind(f.agents)
  let interrupt = true
  t.mock.method(f.agents, 'setWorkspaceType', (...args: Parameters<typeof original>) => {
    if (interrupt) throw new IntegrationError('synthetic_interruption', 'Synthetic interruption', 503)
    return original(...args)
  })
  await assert.rejects(f.config.commit(owner, draft.id, draft.hash, signal()), /Synthetic interruption/)
  assert.equal(f.config.draft(draft.id).status, 'applying')
  await assert.rejects(f.config.propose(owner, { kind: 'domain.create', name: 'Blocked', domainKind: 'shared' }, f.config.snapshot().revision, signal()), /needs recovery/)
  const file = join(f.home, 'agents', f.profile.name, 'AGENT.md')
  await writeFile(file, 'MANUAL_CHANGE_CANARY')
  interrupt = false
  const reopened = new IntegrationStore({ ...f.config.options })
  assert.equal(reopened.draft(draft.id).status, 'applying')
  assert.equal(reopened.ownerAgentFile(f.profile.id).markdown, 'MANUAL_CHANGE_CANARY')
  reopened.cancel(owner, draft.id)
  assert.equal(reopened.draft(draft.id).status, 'cancelled')
  assert.equal(reopened.ownerAgentFile(f.profile.id).markdown, 'MANUAL_CHANGE_CANARY')
  assert.equal((await f.app.request('/api/integrations/discord', { headers: { 'x-owner': 'yes' } })).status, 503,
    'An older runtime must not ignore a concurrent protected-document change')
})

for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  test(`${Store.name}: failed learning admission releases its scope without leaving a phantom running worker`, async t => {
    const f = await fixture(t, Store)
    await f.send()
    const scope = f.integration.openLearningScope(f.id(), signal())
    const boundary = scope.state.channelBoundary!
    const tools = new SessionTools(new Tools(f.home), f.home, [])
    let cleaned = false, workerId = ''
    tools.boundary = {
      memoryAccess: scope.access, signal: scope.signal, assertCurrent: () => f.memory.assert(scope.access),
      begin: async (_input, signal) => scope.inspect(signal), beforeInference: scope.inspect, beforeOutput: scope.inspect,
      stamp: message => message, finish() {}, rememberSummary() {}, close: scope.close,
    }
    tools.onReset(() => { scope.close(); cleaned = true })
    const save = f.storage.saveState.bind(f.storage)
    const failing = t.mock.method(f.storage, 'saveState', async (...[id, state]: Parameters<SessionStore['saveState']>) => {
      if (state.channelBoundary?.learning) { workerId = id; throw new Error('Injected learning admission persistence failure') }
      await save(id, state)
    })
    const requests = f.requests.length
    await assert.rejects(f.sessions.runScopedLearning({
      ownerSessionId: f.id(), epoch: boundary.epoch, revision: boundary.revision,
      batchId: randomUUID(), pipeline: 'reflector', prompt: 'Scoped fixture', input: 'No inference may run',
      signal: scope.signal, tools: () => tools, accepted: () => assert.fail('Unsaved work cannot be accepted'),
    }), /Injected learning admission persistence failure/)
    assert(cleaned)
    assert(workerId)
    assert.equal(f.sessions.getSessionState(workerId), null)
    assert.equal(await f.storage.getState(workerId), null)
    assert.equal(f.requests.length, requests)
    assert.throws(() => f.memory.assert(scope.access))
    failing.mock.restore()
    f.respondWith(messages => learningResponse(messages))
    assert(await f.learning.run('reflector', signal()), 'A subsequent valid learning run can proceed')
  })

  test(`${Store.name}: scoped learning retains source versions, separate cursors and private skills through all pipelines`, async t => {
    const f = await fixture(t, Store)
    await writeFile(join(f.home, 'SOUL.md'), 'GLOBAL_SOUL_MUST_NOT_CHANGE')
    await f.send('201', 'CUSTOMER_A_LEARNING_CANARY')
    await f.send('202', 'CUSTOMER_B_LEARNING_CANARY')
    const a = f.sessions.getSessionState(f.id())!.channelBoundary!
    const b = f.sessions.getSessionState(f.id('202'))!.channelBoundary!
    const sent = f.outbound.length
    f.requests.length = 0
    f.respondWith(messages => learningResponse(messages))
    for (const pipeline of ['reflector', 'encapsulator', 'soulReflector'] as const) {
      assert(await f.learning.run(pipeline, signal()), `${pipeline} completed`)
    }
    for (const request of f.requests) {
      assert.deepEqual(request.tools, ['read', 'learning_record', 'learning_result'])
      const input = learningManifest.parse(JSON.parse(String(request.messages.find(message => message.role === 'user')!.content)))
      const domainId = f.memory.ownerRead(input.requiredInputs[0]!.id).resource.domainId
      const text = JSON.stringify(request.messages)
      assert(!text.includes(domainId === a.domainId ? 'CUSTOMER_B_LEARNING_CANARY' : 'CUSTOMER_A_LEARNING_CANARY'))
      assert(!text.includes('PRIVATE_PROJECT_CANARY') && !text.includes('PRIVATE_SOUL_CANARY') && !text.includes('GLOBAL_SOUL_MUST_NOT_CHANGE'))
    }
    for (const domainId of [a.domainId, b.domainId]) {
      const resources = f.memory.ownerResources().filter(resource => resource.domainId === domainId)
      for (const kind of ['history', 'decision', 'event', 'skill', 'soul-draft']) assert(resources.some(resource => resource.kind === kind), kind)
      assert(resources.every(resource => !resource.publication && resource.sources.every(source => source.domain.id === domainId)))
      assert(resources.filter(resource => resource.kind !== 'history').every(resource => resource.sources.some(source => source.resourceId && source.version)))
    }
    assert.equal(f.outbound.length, sent, 'Learning has no Discord output transport')
    assert.equal(await readFile(join(f.home, 'SOUL.md'), 'utf8'), 'GLOBAL_SOUL_MUST_NOT_CHANGE')
    assert.equal(existsSync(join(f.home, 'memory')), false)
    assert.equal(existsSync(join(f.home, 'skills')), false)
    const workers = f.sessions.listSessions().filter(row => f.sessions.getSessionState(row.sessionId)?.channelBoundary?.learning)
    assert.equal(workers.length, 6)
    for (const worker of workers) {
      const state = await f.storage.getState(worker.sessionId)
      assert.equal(state?.executionStatus, 'completed')
      assert(state?.channelBoundary?.learning && state.channelBoundary.ownerSessionId)
      assert((await f.sessions.getHistory(worker.sessionId, { shallow: true })).messages.some(message => message.role === 'tool'))
    }
    const overview = await f.app.request('/api/integrations/discord', { headers: { 'x-owner': 'yes' } })
    assert.equal(overview.status, 200)
    const status = z.object({ learning: z.array(z.object({ status: z.string() })) }).parse(await overview.json())
    assert.equal(status.learning.filter(item => item.status === 'completed').length, 6)
    f.requests.length = 0
    const reopened = new DiscordLearning({ projectId: f.projectId, directory: join(f.root, 'learning'),
      runtime: f.integration, sessions: f.sessions, memory: f.memory })
    assert.equal(await reopened.run('reflector', signal()), false)
    assert.equal(await reopened.run('encapsulator', signal()), false)
    assert.equal(await reopened.run('soulReflector', signal()), false)
    assert.equal(f.requests.length, 0, 'Completed source versions and downstream events are not replayed after restart')
  })
}

test('two Bot identities with the same Agent and Discord channel retain independent learning domains', async t => {
  const f = await fixture(t)
  const second = f.addBot('901')
  await f.approve({ kind: 'bindings.save', bindings: [{ ...f.a, id: randomUUID(), botInstanceId: second.id, botUserId: '901' }] })
  await f.send('201', 'CUSTOMER_A_LEARNING_CANARY')
  await f.send('201', 'CUSTOMER_B_LEARNING_CANARY', second)
  const firstScope = f.sessions.getSessionState(f.id())!.channelBoundary!
  const secondScope = f.sessions.getSessionState(f.id('201', second))!.channelBoundary!
  assert.notEqual(firstScope.domainId, secondScope.domainId)
  f.requests.length = 0
  f.respondWith(messages => learningResponse(messages))
  await f.learning.run('reflector', signal())
  const decisions = f.memory.ownerResources().filter(resource => resource.kind === 'decision')
  assert.equal(decisions.length, 2)
  assert.match(f.memory.ownerRead(decisions.find(resource => resource.domainId === firstScope.domainId)!.id).content, /CUSTOMER_A_LEARNING_CANARY/)
  const secondContent = f.memory.ownerRead(decisions.find(resource => resource.domainId === secondScope.domainId)!.id).content
  assert.match(secondContent, /CUSTOMER_B_LEARNING_CANARY/)
  assert(!secondContent.includes('CUSTOMER_A_LEARNING_CANARY'))
})

test('failed scoped tools never acknowledge input and permission revocation cancels a learning worker', async t => {
  const f = await fixture(t)
  await f.send()
  let forbidden = true
  f.respondWith(messages => {
    if (forbidden) { forbidden = false; return { content: '', toolCalls: [{ id: 'denied', name: 'read', arguments: { path: 'SOUL.md' } }] } }
    return learningResponse(messages)
  })
  assert.equal(await f.learning.run('reflector', signal()), false)
  assert.equal(f.memory.ownerResources().filter(resource => resource.kind === 'decision').length, 0)
  assert.match(f.learning.status().find(item => item.pipeline === 'reflector')!.summary, /verified receipt|successful tools/)
  f.respondWith(messages => learningResponse(messages))
  assert(await f.learning.run('reflector', signal(), undefined, true))
  f.respondWith(undefined)
  await f.send('201', 'A new source after the acknowledged range')
  f.requests.length = 0
  const pending = Promise.withResolvers<LLMResponse>()
  f.hold(pending.promise)
  const running = f.learning.run('reflector', signal())
  await until(() => f.requests.length > 0)
  await f.approve({ kind: 'bindings.save', bindings: [{ ...f.a, tools: ['read'] }] })
  await running
  assert(f.sessions.listSessions().some(row => {
    const state = f.sessions.getSessionState(row.sessionId)
    return state?.channelBoundary?.learning && state.executionStatus === 'cancelled'
  }))
  assert.equal(f.memory.ownerResources().filter(resource => resource.kind === 'decision').length, 1)
  assert(!f.escaped())
})

test('a prepared learning commit recovers without repeating inference or duplicating domain artifacts', async t => {
  const f = await fixture(t)
  await f.send()
  f.respondWith(messages => learningResponse(messages))
  const original = PrivateDocument.prototype.write
  let injected = false
  const write = t.mock.method(PrivateDocument.prototype, 'write', function (this: PrivateDocument<unknown>, value: unknown) {
    const journal = z.object({ scope: z.object({ sessionId: z.string() }), batches: z.array(z.object({ status: z.string() })) }).safeParse(value)
    if (!injected && journal.success && journal.data.batches.some(batch => batch.status === 'completed')) {
      injected = true; throw new Error('Injected interruption after atomic memory commit')
    }
    return original.call(this, value)
  })
  assert.equal(await f.learning.run('reflector', signal()), false)
  assert(injected)
  const artifacts = f.memory.ownerResources().map(resource => ({ id: resource.id, version: resource.version }))
  const calls = f.requests.length
  write.mock.restore()
  const reopened = new DiscordLearning({ projectId: f.projectId, directory: join(f.root, 'learning'),
    runtime: f.integration, sessions: f.sessions, memory: f.memory })
  assert(await reopened.run('reflector', signal(), undefined, true))
  assert.equal(f.requests.length, calls)
  assert.deepEqual(f.memory.ownerResources().map(resource => ({ id: resource.id, version: resource.version })), artifacts)
})

test('successive decision versions remain distinct downstream inputs and new epochs never replay old learning', async t => {
  const f = await fixture(t)
  await f.send('201', 'CUSTOMER_A_LEARNING_CANARY')
  f.respondWith(messages => learningResponse(messages))
  await f.learning.run('reflector', signal())
  const previous = f.memory.ownerResources().find(resource => resource.kind === 'decision')!
  f.respondWith(undefined)
  await f.send('201', 'Reconsider this decision with another observation')
  f.respondWith(messages => learningResponse(messages))
  await f.learning.run('reflector', signal())
  const current = f.memory.ownerResources().find(resource => resource.kind === 'decision')!
  assert.equal(current.id, previous.id)
  assert.notEqual(current.version, previous.version)
  f.requests.length = 0
  assert(await f.learning.run('encapsulator', signal()))
  const input = learningManifest.parse(JSON.parse(String(f.requests[0]!.messages.find(message => message.role === 'user')!.content)))
  assert(input.requiredInputs.some(ref => ref.id === previous.id && ref.version === previous.version))
  assert(input.requiredInputs.some(ref => ref.id === current.id && ref.version === current.version))
  await f.approve({ kind: 'bindings.save', bindings: [f.a] })
  f.respondWith(undefined)
  await f.send('201', 'Fresh authorization epoch')
  f.respondWith(messages => learningResponse(messages, false))
  f.requests.length = 0
  assert(await f.learning.run('reflector', signal()))
  assert(!JSON.stringify(f.requests).includes('CUSTOMER_A_LEARNING_CANARY'))
})

test('legacy Project learning recovery cannot acknowledge a channel-scoped source', async t => {
  const f = await fixture(t)
  await f.send()
  const legacy = new LearningRuntime(f.sessions, f.projectId)
  const state = f.sessions.getSessionState(f.id())!
  const batch = legacy.ledger.create('reflector', [{ sessionId: f.id(), physicalId: physicalSessionId(state),
    segmentIndex: state.segmentIndex, offset: 0, end: 1 }], [])
  legacy.ledger.bind(batch.id, 'cron:legacy-channel-learning')
  legacy.ledger.propose(batch.id, 'no_change', 'Unverified legacy receipt')
  await legacy.recover()
  assert.match(legacy.ledger.retry('reflector').paused!, /Channel-scoped/)
  assert.equal(legacy.ledger.cursor(batch.sources[0]!), 0)
  assert.equal(legacy.ledger.pending('reflector')?.state, 'pending')
})
