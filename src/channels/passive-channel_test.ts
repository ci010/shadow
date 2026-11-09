import { validateServiceAssignments } from '../bots/assignment-validation.ts'
import { parseBot } from '../bots/sdk.ts'
import { publishBotChange } from '../bots/publication.ts'
import { WriteTool } from '../tools/filesystem.ts'
import { isLearningSourceEligible } from '../agent/learning/source-eligibility.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { withTempWorkspace } from '../testing/workspace.ts'
import { BotDeployments } from '../bots/deployments.ts'
import { DirectoryBots, DirectoryBotService } from '../bots/runtime.ts'
import { botPackageTool } from '../bots/management.ts'
import { botConversationPolicies } from './bot-policies.ts'
import { BotInstanceStore } from './bot-store.ts'
import { channelInputFixture } from '../testing/channel-input.ts'
import { channelSessionId } from '../bus/events.ts'
import { passiveChannelId, parseChannelSource, passiveAttachmentReferences } from './passive-contract.ts'
import { ChannelManager } from './manager.ts'
import { QQChannel } from './qq.ts'
import { Bus } from '../bus/bus.ts'
import { SessionManager } from '../sessions/session-manager.ts'
import { JsonlSessionStore } from '../sessions/session-store-jsonl.ts'
import { SqliteSessionStore } from '../sessions/session-store-sqlite.ts'
import { AgentTypesManager } from '../agent/types/manager.ts'
import { ContextBuilder } from '../agent/context/builder.ts'
import { IdentityManager } from '../agent/identity.ts'
import { EventService } from '../events/service.ts'
import { BackgroundTaskManager } from '../agent/background-task.ts'
import { HandoffManager } from '../sessions/handoff/manager.ts'
import { Tools, SessionTools } from '../tools/registry.ts'
import { AskTool } from '../tools/ask.ts'
import { YieldManager } from '../sessions/yield.ts'
import { ConfigSchema } from '../config/schema.ts'
import type { ExecutionContext } from '../tools/context.ts'
import type { LLMProvider } from '../providers/provider.ts'
import { AgentApp, type AgentOptions } from '../agent/app.ts'

for (const Store of [JsonlSessionStore, SqliteSessionStore]) test(`real QQ passive ingress -> trusted owner source assignment -> exact deployment -> new inputs only (${Store.name})`, async t => {
  await withTempWorkspace(async workspace => {
    const projectId = 'p', bus = new Bus(), bots = new BotInstanceStore({ projectId, path: join(workspace, 'connections.json') })
    const connection = bots.create('qq', 'Shared QQ', { appId: 'synthetic', secret: 'synthetic', enabled: true }, undefined, 'service')
    const deployments = new BotDeployments({ projectId, directory: join(workspace, 'deployments'), runGit: async () => { throw new Error('No git') } }), directory = new DirectoryBots(deployments)
    const sourcePath = join(workspace, 'source'); mkdirSync(sourcePath)
    writeFileSync(join(sourcePath, 'BOT.md'), '---\nid: support\nconfig: bot.json\nmode: service\n---\nSupport only')
    writeFileSync(join(sourcePath, 'bot.json'), JSON.stringify({ allowedModules: [], tools: [], bindings: [], subscriptions: [] }))
    const service = new DirectoryBotService({ projectId, workspace, folders: { get: () => undefined, requireAvailable: async () => { throw new Error('unused') }, acquireAccess: () => () => {} } }, directory)
    const agents = new AgentTypesManager(workspace); await agents.load()
    const tools = new Tools(workspace), context = new ContextBuilder(workspace), prompts: string[] = []
    let block: ReturnType<typeof Promise.withResolvers<void>> | undefined, started: ReturnType<typeof Promise.withResolvers<void>> | undefined
    const provider: LLMProvider = { name: 'fixture', listModels: () => [], chat: async messages => { prompts.push(JSON.stringify(messages)); started?.resolve(); await block?.promise; return { content: 'new input reply', toolCalls: [] } } }
    const store = new Store(join(workspace, 'sessions')), events = new EventService(workspace, bus, async () => { throw new Error('No fanout') }), backgroundTasks = new BackgroundTaskManager(bus, events)
    const handoff = new HandoffManager(provider, 128000, { autoHandoff: false }, workspace, store)
    const makeSessions = () => new SessionManager({ projectId, workspace, store, bus, provider, tools, agentTypes: agents, context, identity: new IdentityManager(workspace), handoffManager: handoff, events, backgroundTasks,
      conversationPolicies: botConversationPolicies(bots, service, directory), getLlmRuntimeConfig: () => ({ model: 'fixture', temperature: 0, contextWindow: 128000 }) })
    let sessions = makeSessions(), commands = 0, replies = 0, outbound = 0
    bus.on('message.outbound', message => { if (!message.inferenceError && message.content.trim()) outbound++ })
    const makeAgent = () => new AgentApp({ bus, sessions, agentTypes: agents, skills: { load: async () => {}, startWatching: () => {} } as unknown as AgentOptions['skills'], mcpManager: { ensureLoaded: async () => {} } as unknown as AgentOptions['mcpManager'], commandDispatcher: { dispatch: async () => { commands++; throw new Error('No passive commands') } } as unknown as AgentOptions['commandDispatcher'], getLlmRuntimeConfig: () => ({ model: 'fixture', temperature: 0, contextWindow: 128000 }) })
    let agent = makeAgent(), manager: ChannelManager | undefined
    const connect = async () => {
      const inputs = channelInputFixture({ projectId, sessions, bots, directory, receive: message => agent.receiveChannelMessage(message) })
      manager = new ChannelManager(ConfigSchema.parse({ agent: { workspace } }), bus, sessions, inputs.receive, { projectId, instanceStore: bots, serviceAssigned: directory.serviceAssigned, serviceGeneration: address => { const policy = directory.resolve(address); return policy?.binding.enabled ? policy.generation ?? policy.revision : undefined }, routeInputPolicy: inputs.policy })
      await manager.init()
      const adapter = manager['channels'].get(connection.id); assert.ok(adapter instanceof QQChannel)
      t.mock.method(adapter, 'onMessage', async () => { replies++ })
      t.mock.method(adapter as never, 'downloadAttachments' as never, (async (_data: unknown, _chatId: string, content: string) => ({ content })) as never)
      return (id: string, content: string, group = 'one', mentioned = false) => adapter['handleDispatch'](mentioned ? 'GROUP_AT_MESSAGE_CREATE' : 'GROUP_MESSAGE_CREATE', { id, group_openid: group, group_name: 'Support group', author: { member_openid: 'owner', username: 'Sender' }, content, attachments: [{ url: 'https://cdn.invalid/file?secret=signed', content_type: 'image/png', size: 12 }] })
    }
    const inboxId = passiveChannelId({ projectId, botInstanceId: connection.id, platform: 'qq', conversationId: 'group:one' })
    let approve = false, asks = 0
    const yields = new YieldManager({ getState: id => ({ sessionId: id, segmentIndex: 0 }), getPolicy: () => ({ timeoutMs: null }), notifyParent: async () => { throw new Error('Owner only') }, notifyUser: async request => { asks++; await yields.answerUser(request.sessionId, request.id, approve ? request.options[0]! : request.options[1]!) } })
    const ask = new AskTool(yields, { get: () => null, ask: async () => { throw new Error('No ordinary input') } })
    const sessionTools = new SessionTools(tools, workspace); sessionTools.setExecutionScope('session', [])
    const owner = { projectId, sessionId: 'web:owner', physicalSessionId: 'owner-physical', channel: 'web', senderId: 'owner', inputSource: 'user', admin: true, tools: sessionTools, signal: new AbortController().signal } as ExecutionContext
    const packageTool = botPackageTool({ projectId, deployments, runtime: directory, folders: { acquireAccess: () => () => {}, requireAvailable: async () => ({ id: 'folder', name: 'Source', path: sourcePath, createdAt: new Date().toISOString() }), list: () => [] }, ask, canAuthor: id => id === 'web:owner', pending: new Map(), changed: () => {}, validate: async files => { const candidate = parseBot(files); await validateServiceAssignments(projectId, bots, candidate, directory.definitions().filter(item => item.bot.id !== candidate.id).map(item => item.bot), async () => { throw new Error('No folder read grants') }) }, publish: async (_id, run) => publishBotChange(sessions, service, id => id === channelSessionId({ projectId, botInstanceId: connection.id, platform: 'qq', conversationId: 'group:one' }), false, run), channelSource: id => {
      const state = sessions.getSessionState(id)
      if (!state || state.projectId !== projectId) throw new Error('Channel source is not in this Project')
      return parseChannelSource(state.channelSource, id, projectId)!
    } })
    const inspect = async () => JSON.parse(await packageTool.execute({ action: 'source', folderId: 'folder', channelSessionId: inboxId }, owner) as string)
    const assign = async (enabled: boolean, sourceRevision: string, expectedRevision?: string) => {
      const prepared = JSON.parse(await packageTool.execute({ action: 'assign', folderId: 'folder', channelSessionId: inboxId, sourceRevision, expectedRevision, summary: 'Assign the referenced Support inbox', bindingJson: JSON.stringify({ enabled, trigger: 'mention', allowFrom: ['owner'], tools: [] }) }, owner) as string)
      assert.equal(prepared.status, 'assignment-prepared')
      const writer = new WriteTool(sourcePath, true)
      const receipt = await writer.execute(prepared.edit, owner)
      assert.doesNotMatch(receipt, /^Error:/)
      const result = JSON.parse(await packageTool.execute({ action: 'propose', folderId: 'folder', expectedRevision, sourceRevision: prepared.candidateRevision, summary: 'Deploy the exact referenced inbox assignment' }, owner) as string)
      return { ...result, sourceUpdated: true }
    }
    try {
      await agent.start(); let send = await connect()
      await Promise.all([send('old', '/cancel OLD_PASSIVE'), send('old', '/cancel OLD_PASSIVE')])
      assert.equal(prompts.length, 0); assert.equal(commands, 0); assert.equal(replies, 0); assert.equal(sessions.listActiveSessions().length, 0)
      const state = sessions.getSessionState(inboxId)!; assert.equal(state.channelSource?.conversationId, 'group:one')
      assert.equal(sessions.isManagedConversation(inboxId), true)
      assert.equal(isLearningSourceEligible(state, () => null), false, 'Passive messages cannot start automatic learning inference')
      assert.equal((await sessions.getHistory(inboxId)).total, 1, 'Owner Web can inspect the real stored history')
      const physical = SessionManager.currentPhysicalId(state)
      const before = await Array.fromAsync(store.readSessionLog(physical)); assert.equal(before.filter(row => row.channel_input_id === 'old').length, 1)
      assert.match(JSON.stringify(before), /cdn.invalid/); assert.doesNotMatch(JSON.stringify(before), /signed|image_url/)
      await assert.rejects(() => sessions.deliver(inboxId, { id: 'attack', timestamp: new Date().toISOString(), kind: 'message', policy: 'interactive', content: 'run', source: { kind: 'user', sender: { channel: 'web', chatId: inboxId, messageId: 'attack', senderId: 'owner' } } }), /read-only/)
      const inspected = await inspect(); assert.equal(inspected.channelSource.botInstanceId, connection.id)
      const cancelled = await assign(true, inspected.sourceRevision); assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.sourceUpdated, true); assert.equal(deployments.list().length, 0)
      assert.equal(JSON.parse(readFileSync(join(sourcePath, 'bot.json'), 'utf8')).bindings[0].conversationId, 'group:one')
      await send('still-unassigned', 'NO_APPROVAL'); assert.equal(prompts.length, 0)
      await assert.rejects(() => assign(true, inspected.sourceRevision), /source changed/)
      const archiveStarted = Promise.withResolvers<void>(), archiveRelease = Promise.withResolvers<void>()
      const append = store.appendMessages.bind(store)
      t.mock.method(store, 'appendMessages', async (id: string, entries: import('../sessions/session-store.ts').StoredMessage[]) => {
        if (entries.some(entry => entry.channel_input_id === 'assignment-race')) { archiveStarted.resolve(); await archiveRelease.promise }
        await append(id, entries)
      })
      const racing = send('assignment-race', 'ARRIVED_BEFORE_ASSIGNMENT', 'one', true)
      await archiveStarted.promise
      approve = true
      const deployed = await assign(true, (await inspect()).sourceRevision); assert.equal(deployed.status, 'deployed'); assert.equal(asks, 2)
      archiveRelease.resolve(); await racing; assert.equal(prompts.length, 0)
      await send('unmentioned', 'NEW_UNMENTIONED'); assert.equal(prompts.length, 0)
      const finished = Promise.withResolvers<void>(); bus.on('session.turn.finished', fact => { if (fact.inputId === 'new') finished.resolve() })
      await send('new', 'NEW_TRIGGER', 'one', true); await finished.promise
      assert.equal(prompts.length, 1); assert.match(prompts[0]!, /NEW_TRIGGER/); assert.doesNotMatch(prompts[0]!, /OLD_PASSIVE|NO_APPROVAL|ARRIVED_BEFORE_ASSIGNMENT/)
      await send('other', 'OTHER_GROUP', 'two', true); assert.equal(prompts.length, 1)
      // Stop transport and session manager, then recover the same durable inbox and dedup set.
      await manager!.stopAll(); await sessions.stop(); sessions = makeSessions(); agent = makeAgent(); await agent.start(); send = await connect()
      await send('old', '/cancel OLD_PASSIVE'); assert.equal((await Array.fromAsync(store.readSessionLog(physical))).filter(row => row.channel_input_id === 'old').length, 1)
      assert.equal(sessions.getSessionState(inboxId)?.channelSource?.kind, 'group')
      const resumed = Promise.withResolvers<void>(); bus.on('session.turn.finished', fact => { if (fact.inputId === 'resumed') resumed.resolve() })
      await send('resumed', 'AFTER_RESTART', 'one', true); await resumed.promise
      assert.equal(prompts.length, 2); assert.doesNotMatch(prompts[1]!, /OLD_PASSIVE|ARRIVED_BEFORE_ASSIGNMENT/)
      // Revocation during inference suppresses output; incoming archive remains independent.
      block = Promise.withResolvers<void>(); started = Promise.withResolvers<void>()
      const completed = Promise.withResolvers<void>(); bus.on('session.turn.finished', fact => { if (fact.inputId === 'inflight') completed.resolve() })
      await send('inflight', 'INFLIGHT', 'one', true); await started.promise
      const beforeRevokeOutput = outbound
      // Unassign through the same file + exact approval path; receipt continues, inference does not.
      await assign(false, (await inspect()).sourceRevision, deployments.read('support')!.deployment.revision)
      block.resolve(); block = undefined; await completed.promise
      assert.equal(outbound, beforeRevokeOutput, 'Revoked in-flight inference cannot emit a reply')
      await send('after-unassign', 'AFTER_UNASSIGN', 'one', true)
      assert.equal(prompts.length, 3)
      assert.match(JSON.stringify(await Array.fromAsync(store.readSessionLog(physical))), /AFTER_UNASSIGN/)
      const executionId = channelSessionId({ projectId, botInstanceId: connection.id, platform: 'qq', conversationId: 'group:one' })
      const oldGeneration = sessions.getSessionState(executionId)!.serviceGeneration
      await assign(true, (await inspect()).sourceRevision, deployments.read('support')!.deployment.revision)
      const reenabled = Promise.withResolvers<void>(); bus.on('session.turn.finished', fact => { if (fact.inputId === 'reenabled') reenabled.resolve() })
      await send('reenabled', 'REENABLED_ONLY', 'one', true); await reenabled.promise
      assert.equal(prompts.length, 4); assert.doesNotMatch(prompts[3]!, /NEW_TRIGGER|AFTER_RESTART|INFLIGHT|AFTER_UNASSIGN/)
      assert.notEqual(sessions.getSessionState(executionId)!.serviceGeneration, oldGeneration)
      const transferStarted = Promise.withResolvers<void>(), transferRelease = Promise.withResolvers<void>()
      const transferAppend = store.appendMessages.bind(store)
      t.mock.method(store, 'appendMessages', async (id: string, entries: import('../sessions/session-store.ts').StoredMessage[]) => {
        if (entries.some(entry => entry.channel_input_id === 'transfer-race')) { transferStarted.resolve(); await transferRelease.promise }
        await transferAppend(id, entries)
      })
      const transferRace = send('transfer-race', 'ARRIVED_UNDER_A', 'one', true)
      await transferStarted.promise
      // Transfer ownership: remove A's binding with exact approval, then assign B from the same trusted inbox.
      const writer = new WriteTool(sourcePath, true), configPath = join(sourcePath, 'bot.json')
      await writer.execute({ path: 'bot.json', match: readFileSync(configPath, 'utf8'), content: JSON.stringify({ allowedModules: [], tools: [], bindings: [], subscriptions: [] }) }, owner)
      await packageTool.execute({ action: 'propose', folderId: 'folder', expectedRevision: deployments.read('support')!.deployment.revision, summary: 'Remove A binding before transferring ownership' }, owner)
      await writer.execute({ path: 'BOT.md', match: 'id: support', content: 'id: beta' }, owner)
      await assign(true, (await inspect()).sourceRevision)
      transferRelease.resolve(); await assert.rejects(transferRace, /assignment changed/)
      assert.equal(prompts.length, 4)
      const transferred = Promise.withResolvers<void>(); bus.on('session.turn.finished', fact => { if (fact.inputId === 'beta') transferred.resolve() })
      await send('beta', 'BETA_ONLY', 'one', true); await transferred.promise
      assert.equal(prompts.length, 5); assert.doesNotMatch(prompts[4]!, /REENABLED_ONLY|NEW_TRIGGER|AFTER_RESTART|INFLIGHT|OLD_PASSIVE|ARRIVED_UNDER_A/)
      await assert.rejects(() => packageTool.execute({ action: 'source', folderId: 'folder', channelSessionId: inboxId }, { ...owner, projectId: 'foreign' }), /authenticated owner/)
      await assert.rejects(() => packageTool.execute({ action: 'source', folderId: 'folder', channelSessionId: inboxId }, { ...owner, channel: 'qq' }), /authenticated owner/)
      await assert.rejects(() => packageTool.execute({ action: 'source', folderId: 'folder', channelSessionId: 'channel-inbox:foreign:fake:qq:group%3Aone' }, owner), /not in this Project/)
    } finally { block?.resolve(); await manager?.stopAll(); await sessions.stop(); await agents.stopWatching(); await handoff.stop(); await backgroundTasks.stop(); await events.stop(); bus.stopAll(); if (store instanceof SqliteSessionStore) store.close() }
  })
})

test('attachment references retain platform identifiers, not signed URLs, credentials, local paths or content', () => {
  assert.deepEqual(passiveAttachmentReferences([{ url: 'https://cdn.invalid/a?token=secret#fragment', size: 1 }, { url: 'file:///private/secret' }, { url: 'https://user:pass@cdn.invalid/a' }, { file_key: 'platform-key', url: 'https://cdn.invalid/key?secret=hidden' }]), [{ id: 'attachment:0', reference: 'https://cdn.invalid', size: 1 }, { id: 'platform-key' }])
})
