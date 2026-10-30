import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { Hono } from 'hono'
import { Bus } from '../bus/bus.ts'
import { WebChannel } from '../channels/web.ts'
import { CommandDispatcher } from '../slash-commands/index.ts'
import { createClearCommand } from '../slash-commands/handlers/clear.ts'
import { EventService } from '../events/service.ts'
import { HandoffManager } from '../sessions/handoff/manager.ts'
import { McpManager } from '../mcp/manager.ts'
import type { LLMProvider, LLMResponse } from '../providers/provider.ts'
import type { AcceptedSessionInput, DeliverInput, SessionTurnFact } from '../sessions/input.ts'
import { SessionManager } from '../sessions/session-manager.ts'
import { JsonlSessionStore } from '../sessions/session-store-jsonl.ts'
import { SqliteSessionStore } from '../sessions/session-store-sqlite.ts'
import { physicalSessionId } from '../sessions/session-identity.ts'
import { resolveSessionLocations } from '../sessions/locality.ts'
import { isCommandReceipt } from '../slash-commands/receipt.ts'
import { sessionsApiPlugin } from '../sessions/routes.ts'
import { SkillsManager } from '../skills/loader.ts'
import { Tools } from '../tools/registry.ts'
import { AgentApp } from './app.ts'
import { AgentTypesManager } from './types/manager.ts'
import { BackgroundTaskManager } from './background-task.ts'
import { ContextBuilder, type SessionPromptContext } from './context/builder.ts'
import { IdentityManager } from './identity.ts'
import type { LlmRuntimeConfig } from './llm-config.ts'
import { channelSessionId, type OutboundMessage } from '../bus/events.ts'

for (const storage of ['jsonl', 'sqlite'] as const) {
test(`web admission, channel fanout, commands and retry follow one directed input path (${storage})`, { timeout: 15_000 }, async (t) => {
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
  const providerInputs: string[] = []
  let heldCall: {
    response: ReturnType<typeof Promise.withResolvers<LLMResponse>>
    started: ReturnType<typeof Promise.withResolvers<AbortSignal>>
  } | undefined
  const provider: LLMProvider = {
    name: 'fixture',
    async listModels() { return ['fixture'] },
    async chat(_messages, _tools, options) {
      providerInputs.push(JSON.stringify(_messages))
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
  const store = storage === 'jsonl' ? new JsonlSessionStore(join(workspace, '.sessions'))
    : new SqliteSessionStore(join(workspace, '.sessions'))
  await store.init()
  const agentTypes = new AgentTypesManager(workspace)
  const identity = new IdentityManager(workspace)
  const managerDeps = {
    workspace, bus, provider, tools, context, store, events, agentTypes,
    identity,
    handoffManager: new HandoffManager(provider, llm.contextWindow, { autoHandoff: false }, workspace, store),
    backgroundTasks: new BackgroundTaskManager(bus, events),
    getLlmRuntimeConfig: () => llm,
  }
  const sessions = new SessionManager(managerDeps)
  deliver = (id, input) => sessions.deliver(id, input)
  const commands = new CommandDispatcher()
  commands.register(createClearCommand(sessions))
  let commandsRun = 0
  commands.register({
    name: 'probe', description: 'fixture command', adminOnly: true,
    async execute() { commandsRun++; return 'Command handled' },
  })
  commands.register({
    name: 'fail', description: 'Synthetic failure', adminOnly: true,
    async execute() { throw new Error('Synthetic command failure') },
  })
  const mcpManager = new McpManager(async () => {})
  const agent = new AgentApp({
    identity,
    bus, sessions, events, agentTypes, commandDispatcher: commands,
    skills: new SkillsManager(workspace), mcpManager,
    getLlmRuntimeConfig: () => llm,
  })
  const live: Array<{ sessionId: string; payload: unknown; requestId?: string }> = []
  const channel = new WebChannel(bus, { workspace, sessionManager: sessions, realtime: {
    chat(sessionId, payload, requestId) { live.push({ sessionId, payload, requestId }) },
    invalidateSessions() {}, invalidateActivity() {}, close() {},
  } })
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
    if (store instanceof SqliteSessionStore) store.close()
    await rm(workspace, { recursive: true, force: true })
  })
  await events.start()
  await agent.start()
  await channel.start(app)
  await sessionsApiPlugin(sessions)(app)
  events.subscribe({ sessionId: 'web:origin', event: 'channel.message', channel: 'web', chatId: 'origin' })
  events.subscribe({ sessionId: 'web:mirror', event: '*', channel: 'web', chatId: 'origin' })
  events.subscribe({ sessionId: 'web:mirror', event: 'channel.message', channel: 'web', chatId: 'origin' })
  const commandSubscription = events.subscribe({ sessionId: 'web:command-mirror', event: 'channel.message', channel: 'web', chatId: 'commands' })

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

  const commandResponse = await send({ chatId: 'commands', content: '/probe' })
  assert.equal(commandResponse.status, 200)
  const commandAdmission = await commandResponse.json()
  assert(isCommandReceipt(commandAdmission.commandReceipt))
  assert.equal(commandsRun, 1)
  assert.equal(modelCalls, 2, 'Commands must not call a provider, including through subscriptions')
  assert.equal(facts.length, 2, 'A command is not a model turn')
  assert.equal(sessions.getSessionState('web:command-mirror'), null)
  assert.equal(sessions.getActiveSession('web:commands'), undefined)
  const commandState = sessions.getSessionState('web:commands')!
  const locations = resolveSessionLocations(workspace, commandState)
  assert(locations.workdir.available && locations.workdir.locality === 'local')
  assert((await stat(locations.workdir.path)).isDirectory(), 'Scratch workdir exists before command completion')
  assert.deepEqual((await sessions.getHistory('web:commands')).messages, [])
  assert.deepEqual(await sessions.getCommandResults('web:commands'), [commandAdmission.commandReceipt])
  assert.deepEqual(live.find(item => item.requestId === commandAdmission.requestId)?.payload, {
    event: 'command_result', done: true, receipt: commandAdmission.commandReceipt,
  })
  const commandSnapshot = await (await app.request('/api/chat/session?chatId=commands')).json()
  assert.deepEqual(commandSnapshot.history, [])
  assert.deepEqual(commandSnapshot.commandResults, [commandAdmission.commandReceipt])
  const commandPhysical = physicalSessionId(commandState)
  for (const key of ['web:commands', commandPhysical]) {
    const snapshot = await (await app.request(`/api/sessions/${encodeURIComponent(key)}`)).json()
    assert.deepEqual(snapshot.messages, [])
    assert.deepEqual(snapshot.commandResults, [commandAdmission.commandReceipt])
  }
  for (const content of ['/unknown-command', '/fail']) {
    const response = await send({ chatId: 'commands', content })
    assert.equal(response.status, 200)
    const admission = await response.json()
    assert(isCommandReceipt(admission.commandReceipt))
    assert.equal(admission.commandReceipt.failed, true)
    assert.match(admission.commandReceipt.output, /^Error:/)
  }
  assert.equal(modelCalls, 2)
  assert.equal((await sessions.getCommandResults('web:commands')).length, 3)
  events.unsubscribe(commandSubscription.id)
  assert.equal((await send({ chatId: 'commands', content: 'Normal message after command' })).status, 200)
  await finished(3)
  assert.equal(modelCalls, 3)
  assert.doesNotMatch(providerInputs.at(-1)!, /\/probe|Command handled|unknown-command|\/fail/)
  assert.match(providerInputs.at(-1)!, /Normal message after command/)
  await sessions.buildSession('web:command-fork', { id: 'web:commands', physicalId: commandPhysical, index: 1 }, { parentSessionId: null })
  assert.deepEqual(await sessions.getCommandResults('web:command-fork'), [])
  const forkHistory = JSON.stringify((await sessions.getHistory('web:command-fork')).messages)
  assert.doesNotMatch(forkHistory, /\/probe|Command handled/)
  assert.match(forkHistory, /Normal message after command/, 'Receipts cannot shift model-history fork indexes')
  assert.doesNotMatch(forkHistory, /Synthetic answer/, 'The fork stops at the requested message')
  const remoteDisplayPath = join(workspace, 'remote-display-path-not-a-local-directory')
  await sessions.buildSession('web:command-remote', undefined, { workdir: {
    version: 2, nodeId: 'remote-node', workdirId: 'remote-capability', displayPathSnapshot: remoteDisplayPath,
  } })
  await sessions.prepareCommandSession('web:command-remote')
  assert((await stat(resolveSessionLocations(workspace, sessions.getSessionState('web:command-remote')!).sessionDataDir)).isDirectory())
  await assert.rejects(stat(remoteDisplayPath), { code: 'ENOENT' })

  const reopenedStore = storage === 'jsonl' ? new JsonlSessionStore(join(workspace, '.sessions'))
    : new SqliteSessionStore(join(workspace, '.sessions'))
  await reopenedStore.init()
  const reopened = new SessionManager({ ...managerDeps, store: reopenedStore, bus: new Bus() })
  try {
    await reopened.start()
    assert.deepEqual(await reopened.getCommandResults('web:commands'), await sessions.getCommandResults('web:commands'))
    assert.doesNotMatch(JSON.stringify((await reopened.getHistory('web:commands')).messages), /\/probe|Command handled|unknown-command/)
  } finally {
    await reopened.stop()
    if (reopenedStore instanceof SqliteSessionStore) reopenedStore.close()
  }

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

  const priorCalls = modelCalls
  const oldPhysical = physicalSessionId(sessions.getSessionState('web:commands')!)
  const cleared = await (await send({ chatId: 'commands', content: '/clear' })).json()
  assert(isCommandReceipt(cleared.commandReceipt))
  assert.equal(cleared.commandReceipt.failed, false)
  assert.match(cleared.commandReceipt.output, /AI context cleared/)
  assert.equal(modelCalls, priorCalls)
  const clearedSnapshot = await (await app.request('/api/chat/session?chatId=commands')).json()
  assert.deepEqual(clearedSnapshot.history, [])
  assert.deepEqual(clearedSnapshot.commandResults, [cleared.commandReceipt])
  assert.match(JSON.stringify(await sessions.getHistory('web:commands', { physicalId: oldPhysical })), /Normal message after command/)
  assert.deepEqual(live.find(item => item.requestId === cleared.requestId)?.payload, {
    event: 'command_result', done: true, receipt: cleared.commandReceipt,
  })

  const commandReplies: OutboundMessage[] = []
  bus.on('message.outbound', message => { if (message.metadata?.command) commandReplies.push(message) })
  t.mock.getter(sessions, 'projectId', () => 'org')
  for (const botInstanceId of ['bot-a', 'bot-b']) {
    const channelAddress = { projectId: 'org', botInstanceId, platform: 'discord', conversationId: 'same-chat' }
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
    channelAddress: { projectId: 'foreign', botInstanceId: 'bot-a', platform: 'discord', conversationId: 'same-chat' },
    senderId: 'alice', messageId: 'foreign-command', content: '/probe', admin: true, timestamp: new Date().toISOString(),
  }), /another project/)
  assert.equal(commandsRun, beforeCommands)
  assert.equal(accepted.length, beforeAccepted)
  assert.equal(commandReplies.length, 2)
})
}
