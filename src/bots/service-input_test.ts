import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { withTempWorkspace } from '../testing/workspace.ts'
import { BotDeployments } from './deployments.ts'
import { DirectoryBots, DirectoryBotService } from './runtime.ts'
import { botConversationPolicies } from '../channels/bot-policies.ts'
import { BotInstanceStore } from '../channels/bot-store.ts'
import { channelInputFixture } from '../testing/channel-input.ts'
import { channelSessionId, deriveSessionId, type InboundMessage } from '../bus/events.ts'
import { channelMessageInput } from '../sessions/input.ts'
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
import { Tools } from '../tools/registry.ts'
import type { LLMProvider } from '../providers/provider.ts'

for (const platform of ['qq', 'feishu'] as const)
for (const Store of [JsonlSessionStore, SqliteSessionStore]) test(`${platform} frontmatter settings and service filters before real Session creation/provider calls (${Store.name})`, async () => {
  await withTempWorkspace(async workspace => {
    const projectId = 'p', bots = new BotInstanceStore({ projectId, path: join(workspace, 'bots.json') })
    const bot = bots.create(platform, 'support', platform === 'qq' ? { appId: 'test', secret: 'test', enabled: true } : { appId: 'test', appSecret: 'test', enabled: true })
    const inference = { model: 'chosen-model', temperature: 0.4, maxTokens: 321, thinking: { type: 'enabled' }, reasoningEffort: 'high' }
    const deployments = new BotDeployments({ projectId, directory: join(workspace, 'deployments'), runGit: async () => { throw new Error('No git') } })
    const directory = new DirectoryBots(deployments)
    const deploy = async (subscriptions?: unknown[]) => {
      const frozen = deployments.freeze({ 'BOT.md': '---\nid: support\nconfig: bot.json\nmode: service\nmodel: chosen-model\ntemperature: 0.4\nmaxTokens: 321\nthinking: {type: enabled}\nreasoningEffort: high\n---\nService-only prompt', 'bot.json': JSON.stringify({ allowedModules: [], tools: [],
        bindings: [{ platform, botInstanceId: bot.id, conversationId: 'group:one', tools: [], allowFrom: ['owner'] }], ...(subscriptions ? { subscriptions } : {}) }) })
      await deployments.deploy({ id: 'support', source: { folderId: 'fixture', directory: '' }, ...frozen, expectedRevision: deployments.read('support')?.deployment.revision })
    }
    const policy = new DirectoryBotService({ projectId, workspace,
      folders: { get: () => undefined, requireAvailable: async () => { throw new Error('No folders') }, acquireAccess: () => () => {} } }, directory)
    const bus = new Bus(), agents = new AgentTypesManager(workspace); await agents.load()
    const tools = new Tools(workspace)
    tools.register({ name: 'exec', description: 'private tool', parameters: { type: 'object', properties: {} }, execute: async () => { throw new Error('Must not escape') } })
    const context = new ContextBuilder(workspace); context.register({ name: 'private', getPromptSection: () => 'PRIVATE_CONTEXT' })
    const calls: Array<{ prompt: string; tools: string[]; inference: import('../agent/llm-config.ts').InferenceSettings }> = []
    const provider: LLMProvider = { name: 'fixture', listModels: () => [], chat: async (messages, definitions, options) => {
      calls.push({ prompt: JSON.stringify(messages), tools: definitions.map(tool => tool.function.name), inference: { model: options.model, temperature: options.temperature, maxTokens: options.maxTokens, thinking: options.thinking, reasoningEffort: options.reasoningEffort } }); return { content: 'done', toolCalls: [] }
    } }
    const store = new Store(join(workspace, 'sessions'))
    const events = new EventService(workspace, bus, async () => { throw new Error('No event fanout') })
    const backgroundTasks = new BackgroundTaskManager(bus, events)
    const handoff = new HandoffManager(provider, 128000, { autoHandoff: false }, workspace, store)
    const sessions = new SessionManager({ projectId, workspace, store, bus, provider, tools, agentTypes: agents, context, identity: new IdentityManager(workspace), handoffManager: handoff, events, backgroundTasks,
      conversationPolicies: botConversationPolicies(bots, policy, directory), getLlmRuntimeConfig: () => ({ model: 'default', temperature: 0, contextWindow: 128000 }) })
    const inputs = channelInputFixture({ projectId, sessions, bots, directory, receive: message => sessions.deliver(deriveSessionId(message), channelMessageInput(message)) })
    const address = { projectId, botInstanceId: bot.id, platform, conversationId: 'group:one' }
    const message: InboundMessage = { channelAddress: address, channel: platform, chatId: address.conversationId, isGroup: true, admin: false, senderId: 'owner', content: 'hello', messageId: 'native', platformMessageId: 'native', timestamp: new Date().toISOString() }
    try {
      await sessions.start()
      let policies = 0
      const runPolicy = async () => { policies++; await inputs.receive(message) }
      await assert.rejects(inputs.policy(message, runPolicy), /subscription/)
      await deploy([])
      await assert.rejects(inputs.policy(message, runPolicy), /subscription/)
      await deploy()
      await assert.rejects(inputs.policy({ ...message, senderId: 'stranger' }, runPolicy), /not authorized/)
      assert.equal(policies, 0)
      await inputs.policy(message, async () => {
        assert.equal((await inputs.receive({ ...message, silent: true })).disposition, 'filtered')
      })
      assert.equal(calls.length, 0)
      assert.equal(sessions.listSessions().length, 0)
      assert.equal(sessions.listActiveSessions().length, 0)
      const finished = Promise.withResolvers<void>()
      bus.on('session.turn.finished', fact => { if (fact.inputId === message.messageId) finished.resolve() })
      await inputs.policy(message, runPolicy); await finished.promise
      assert.equal(policies, 1)
      assert.equal(calls.length, 1)
      assert.deepEqual(calls[0]?.inference, inference)
      assert.deepEqual(calls[0]?.tools, [])
      assert.match(calls[0]!.prompt, /Service-only prompt/)
      assert.doesNotMatch(calls[0]!.prompt, /PRIVATE_CONTEXT/)
      assert.ok(sessions.getSessionState(channelSessionId(address)))
      await deploy([])
      await assert.rejects(inputs.policy({ ...message, messageId: 'revoked' }, runPolicy), /subscription/)
      assert.equal(policies, 1)
      assert.equal(calls.length, 1)
    } finally {
      await sessions.stop(); await handoff.stop(); await backgroundTasks.stop(); await events.stop(); bus.stopAll()
      if (store instanceof SqliteSessionStore) store.close()
    }
  })
})
