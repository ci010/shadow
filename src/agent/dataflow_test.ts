import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { Hono } from 'hono'
import { Bus } from '../bus/bus.ts'
import { WebChannel } from '../channels/web.ts'
import { CommandDispatcher } from '../slash-commands/index.ts'
import { EventService } from '../events/service.ts'
import { HandoffManager } from '../sessions/handoff/manager.ts'
import { McpManager } from '../mcp/manager.ts'
import type { LLMProvider, LLMResponse } from '../providers/provider.ts'
import type { AcceptedSessionInput, DeliverInput, SessionTurnFact } from '../sessions/input.ts'
import { SessionManager } from '../sessions/session-manager.ts'
import { JsonlSessionStore } from '../sessions/session-store-jsonl.ts'
import { SkillsManager } from '../skills/loader.ts'
import { Tools } from '../tools/registry.ts'
import { AgentApp } from './app.ts'
import { AgentTypesManager } from './types/manager.ts'
import { BackgroundTaskManager } from './background-task.ts'
import { ContextBuilder, type SessionPromptContext } from './context/builder.ts'
import { IdentityManager } from './identity.ts'
import type { LlmRuntimeConfig } from './llm-config.ts'
import { channelSessionId, type OutboundMessage } from '../bus/events.ts'

test('web admission, channel fanout, commands and retry follow one directed input path', { timeout: 15_000 }, async (t) => {
  await mkdir('.test-data', { recursive: true })
  const workspace = await mkdtemp(join(process.cwd(), '.test-data', 'dataflow-'))
  const bus = new Bus()
  const facts: SessionTurnFact[] = []
  const releaseMocks: Array<() => void> = []
  const accepted: AcceptedSessionInput[] = []
  const waiters: Array<{ count: number; resolve: () => void }> = []
  bus.on('session.input.accepted', (event) => { accepted.push(event) })
  bus.on('session.turn.finished', (event) => {
    facts.push(event)
    for (const waiter of waiters) if (facts.length >= waiter.count) waiter.resolve()
  })
  const finished = (count: number) => facts.length >= count ? Promise.resolve()
    : new Promise<void>((resolve) => { waiters.push({ count, resolve }) })
  let legacyInbound = 0
  bus.on('message.inbound', () => { legacyInbound++ })
  let deliver: DeliverInput = async () => { throw new Error('not ready') }
  const events = new EventService(workspace, bus, (id, input) => deliver(id, input))
  const tools = new Tools(workspace)
  const context = new ContextBuilder(workspace)
  const contexts: SessionPromptContext[] = []
  context.register({
    name: 'fixture',
    getPromptSection(ctx) {
      if (ctx.sessionId === 'web:reject') throw new Error('Synthetic context unavailable')
      contexts.push(ctx)
      return 'Synthetic test context'
    },
  })
  let modelCalls = 0
  let heldCall: {
    response: ReturnType<typeof Promise.withResolvers<LLMResponse>>
    started: ReturnType<typeof Promise.withResolvers<AbortSignal>>
  } | undefined
  const provider: LLMProvider = {
    name: 'fixture',
    async listModels() { return ['fixture'] },
    async chat(_messages, _tools, options) {
      modelCalls++
      const held = heldCall
      heldCall = undefined
      if (held) {
        const signal = options.signal!
        const abort = () => held.response.reject(signal.reason)
        signal.addEventListener('abort', abort, { once: true })
        held.started.resolve(signal)
        try {
          return await held.response.promise
        } finally {
          signal.removeEventListener('abort', abort)
        }
      }
      return { content: 'Synthetic answer', toolCalls: [], finishReason: 'stop' }
    },
  }
  const llm: LlmRuntimeConfig = { model: 'fixture', contextWindow: 100_000, temperature: 0 }
  const store = new JsonlSessionStore(join(workspace, '.sessions'))
  await store.init()
  const agentTypes = new AgentTypesManager(workspace)
  const identity = new IdentityManager(workspace)
  const sessions = new SessionManager({
    workspace, bus, provider, tools, context, store, events, agentTypes,
    identity,
    handoffManager: new HandoffManager(provider, llm.contextWindow, { autoHandoff: false }, workspace, store),
    backgroundTasks: new BackgroundTaskManager(bus, events),
    getLlmRuntimeConfig: () => llm,
  })
  deliver = (id, input) => sessions.deliver(id, input)
  const commands = new CommandDispatcher()
  let commandsRun = 0
  commands.register({
    name: 'probe', description: 'fixture command', adminOnly: true,
    async execute() { commandsRun++; return 'Command handled' },
  })
  const mcpManager = new McpManager(async () => {})
  t.mock.method(mcpManager, 'startWatching', () => {})
  const agent = new AgentApp({
    identity,
    bus, sessions, events, agentTypes, commandDispatcher: commands,
    skills: new SkillsManager(workspace), mcpManager,
    getLlmRuntimeConfig: () => llm,
  })
  const channel = new WebChannel(bus, { workspace, sessionManager: sessions })
  channel.setReceiver((message) => agent.receiveChannelMessage(message))
  const app = new Hono()
  t.after(async () => {
    await events.stop()
    const active = sessions.listActiveSessions().map(({ sessionId }) => sessions.getActiveSession(sessionId)?.completion)
    const shutdown = agent.shutdown()
    for (const release of releaseMocks) release()
    await shutdown
    await Promise.all(active)
    await channel.stop()
    bus.stopAll()
    await rm(workspace, { recursive: true, force: true })
  })
  await events.start()
  await agent.start()
  await channel.start(app)
  events.subscribe({ sessionId: 'web:origin', event: 'channel.message', channel: 'web', chatId: 'origin' })
  events.subscribe({ sessionId: 'web:mirror', event: '*', channel: 'web', chatId: 'origin' })
  events.subscribe({ sessionId: 'web:mirror', event: 'channel.message', channel: 'web', chatId: 'origin' })
  events.subscribe({ sessionId: 'web:command-mirror', event: 'channel.message', channel: 'web', chatId: 'commands' })

  const send = (body: object) => app.request('/api/chat/send', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ stream: false, ...body }),
  })
  assert.equal((await send({ chatId: 'origin', content: 'hello' })).status, 200)
  await finished(2)
  assert.equal(legacyInbound, 0)
  assert.equal(modelCalls, 2)
  assert.deepEqual(accepted.map((event) => event.sessionId), ['web:origin', 'web:mirror'])
  assert.equal(accepted[0].input.source.kind, 'user')
  const mirrored = accepted[1].input
  assert(mirrored.kind === 'message' && mirrored.source.kind === 'event')
  assert.equal(mirrored.policy, 'queue')
  assert.equal(mirrored.source.eventId, accepted[0].input.id)
  assert.equal(mirrored.source.origin?.inputId, accepted[0].input.id)
  assert.equal(contexts.find((ctx) => ctx.sessionId === 'web:mirror')?.admin, false)

  assert.equal((await send({ chatId: 'commands', content: '/probe' })).status, 200)
  await finished(3)
  assert.equal(commandsRun, 1)
  assert.equal(modelCalls, 3)
  assert.equal(facts[2].sessionId, 'web:command-mirror')
  assert.equal(contexts.find((ctx) => ctx.sessionId === 'web:command-mirror')?.admin, false)
  const forwardedHistory = await sessions.getHistory('web:command-mirror')
  assert.match(JSON.stringify(forwardedHistory.messages), /event.*channel.message/)
  assert.doesNotMatch(JSON.stringify(forwardedHistory.messages), /admin=\\?"true/)

  const priorAccepted = accepted.length
  assert.equal((await send({ chatId: 'origin', content: 'hello', retry: true })).status, 200)
  await finished(4)
  assert.equal(modelCalls, 4)
  assert.equal(accepted.length, priorAccepted + 1)
  assert.equal(accepted.at(-1)?.input.kind, 'control')
  const history = await sessions.getHistory('web:origin')
  assert.equal(history.messages.filter((message) => message.role === 'user').length, 1)

  async function queueWhileBusy(chatId: string, signal: AbortSignal) {
    const targetSessionId = `web:${chatId}`
    const startedCalls = modelCalls
    await events.emit({
      id: `${chatId}:default`, type: 'fixture', source: 'test',
      targetSessionId, content: 'Default queue',
      meta: { urgency: 'steering', __eventDispatch: false },
    })
    await events.emit({
      id: `${chatId}:explicit`, type: 'fixture', source: 'test',
      targetSessionId, content: 'Explicit queue', delivery: { urgency: 'queue' },
    })
    const flushed = Promise.withResolvers<AcceptedSessionInput>()
    const subscription = bus.on('session.input.accepted', (entry) => {
      if (entry.input.source.kind === 'event' && entry.input.source.eventId === `${chatId}:latest`) {
        flushed.resolve(entry)
      }
    })
    try {
      for (const id of ['earlier', 'latest']) {
        await events.emit({
          id: `${chatId}:${id}`, type: 'fixture-burst', source: 'test',
          targetSessionId, content: `Burst ${id}`,
          delivery: { urgency: 'debounce', debounceMs: 5 },
        })
      }
      const flush = await flushed.promise
      assert(flush.input.kind === 'message' && flush.input.source.kind === 'event')
      assert.equal(flush.input.policy, 'queue')
      assert.equal(flush.input.source.coalesced?.count, 2)
      assert.deepEqual(flush.input.source.coalesced?.eventIds, [`${chatId}:earlier`, `${chatId}:latest`])
      assert.equal(signal.aborted, false)
      assert.equal(modelCalls, startedCalls)
      const queued = accepted.filter((entry) => entry.sessionId === targetSessionId && entry.input.source.kind === 'event')
      assert.equal(queued.length, 3)
      assert(queued.every((entry) => entry.input.kind === 'message' && entry.input.policy === 'queue'))
    } finally {
      bus.off(subscription)
    }
  }

  // The real event router must preserve queue semantics across an active provider await.
  const llmGate = {
    response: Promise.withResolvers<LLMResponse>(),
    started: Promise.withResolvers<AbortSignal>(),
  }
  heldCall = llmGate
  const beforeLlm = facts.length
  assert.equal((await send({ chatId: 'busy-llm', content: 'Hold provider' })).status, 200)
  const llmSignal = await llmGate.started.promise
  await queueWhileBusy('busy-llm', llmSignal)
  llmGate.response.resolve({ content: 'Released provider', toolCalls: [] })
  await finished(beforeLlm + 4)
  assert(facts.slice(beforeLlm).every((entry) => entry.status === 'completed'))

  // The same path must not steer queued event payloads into the active tool turn.
  const toolGate = Promise.withResolvers<string>()
  releaseMocks.push(() => toolGate.resolve('Fixture cleanup'))
  const toolStarted = Promise.withResolvers<AbortSignal>()
  tools.register({
    name: 'exec', description: 'Synthetic blocking tool', parameters: { type: 'object', properties: {} },
    async execute(_args, ctx) {
      toolStarted.resolve(ctx.signal)
      return toolGate.promise
    },
  })
  const toolCall = {
    response: Promise.withResolvers<LLMResponse>(),
    started: Promise.withResolvers<AbortSignal>(),
  }
  toolCall.response.resolve({
    content: '', toolCalls: [{ id: 'tool-call', name: 'exec', arguments: {} }],
  })
  heldCall = toolCall
  const beforeTool = facts.length
  assert.equal((await send({ chatId: 'busy-tool', content: 'Hold tool' })).status, 200)
  await queueWhileBusy('busy-tool', await toolStarted.promise)
  toolGate.resolve('Released tool')
  await finished(beforeTool + 4)
  assert(facts.slice(beforeTool).every((entry) => entry.status === 'completed'))
  assert.equal((await sessions.getHistory('web:busy-tool')).messages.filter((message) => message.role === 'user').length, 4)

  const rejected = await send({ chatId: 'reject', content: 'not accepted' })
  assert.equal(rejected.status, 503)
  assert.match(await rejected.text(), /Synthetic context unavailable/)
  assert(!accepted.some((entry) => entry.sessionId === 'web:reject'))
  assert.equal(legacyInbound, 0)

  const commandReplies: OutboundMessage[] = []
  bus.on('message.outbound', message => { if (message.metadata?.command) commandReplies.push(message) })
  t.mock.getter(sessions, 'organizationId', () => 'org')
  for (const botInstanceId of ['bot-a', 'bot-b']) {
    const channelAddress = { organizationId: 'org', botInstanceId, platform: 'discord', conversationId: 'same-chat' }
    const receipt = await agent.receiveChannelMessage({
      channel: 'discord', chatId: 'same-chat', channelAddress, senderId: 'alice', messageId: 'same-message',
      content: '/probe', admin: true, timestamp: new Date().toISOString(),
    })
    assert.equal(receipt.sessionId, channelSessionId(channelAddress))
    assert.deepEqual(commandReplies.at(-1)?.channelAddress, channelAddress)
    assert.doesNotMatch((await identity.lookupByAccount('discord', 'alice', channelAddress)).personContext, /No profile found/)
  }
  const beforeCommands = commandsRun
  const beforeAccepted = accepted.length
  await assert.rejects(agent.receiveChannelMessage({
    channel: 'discord', chatId: 'same-chat',
    channelAddress: { organizationId: 'foreign', botInstanceId: 'bot-a', platform: 'discord', conversationId: 'same-chat' },
    senderId: 'alice', messageId: 'foreign-command', content: '/probe', admin: true, timestamp: new Date().toISOString(),
  }), /another organization/)
  assert.equal(commandsRun, beforeCommands)
  assert.equal(accepted.length, beforeAccepted)
  assert.equal(commandReplies.length, 2)
})
