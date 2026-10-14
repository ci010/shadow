import { withProviderRetry, type RateLimitWait } from '../providers/retry.ts'
import { ProviderHttpError } from '../providers/provider.ts'
import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { describe, test } from 'node:test'
import { Hono } from 'hono'
import { Bus } from '../bus/bus.ts'
import { QQChannel } from '../channels/qq.ts'
import { BackgroundTaskManager } from '../agent/background-task.ts'
import { EventService } from '../events/service.ts'
import { channelSessionId, type OutboundMessage } from '../bus/events.ts'
import type { LLMProvider, LLMResponse, ChatMessage } from '../providers/provider.ts'
import type { HandoffManager } from './handoff/manager.ts'
import { SessionTools, Tools } from '../tools/registry.ts'
import { MessageTool } from '../tools/message.ts'
import type { ExecutionContext } from '../tools/context.ts'
import { JsonlSessionStore } from './session-store-jsonl.ts'
import { SqliteSessionStore } from './session-store-sqlite.ts'
import type { SessionState, SessionStore } from './session-store.ts'
import { createResponseContext, hasNoAdmittedUserInput } from './response-context.ts'
import { channelMessageInput, type SessionInput, type SessionMessageInput, type SessionTurnFact } from './input.ts'
import { SessionManager, type SessionManagerDeps } from './session-manager.ts'
import { Session } from './session.ts'
import { sessionsApiPlugin } from './routes.ts'
import { sessionWorkspacePath } from '../utils/paths.ts'

function assertNoAudienceEvents(messages: ChatMessage[]): void {
  assert(!messages.some(message => message.name === 'runtime-context'
    && JSON.stringify(message.content).includes('runtime-context-audience')))
}

const llm = { model: 'fixture', contextWindow: 128_000, temperature: 0 }
const done = (content = 'Finished'): LLMResponse => ({ content, toolCalls: [] })

function input(id: string, policy: SessionMessageInput['policy'] = 'queue'): SessionMessageInput {
  return {
    id, timestamp: new Date().toISOString(), kind: 'message', content: id, policy,
    source: { kind: 'event', eventId: id, type: 'fixture', source: 'system' },
  }
}

function control(id: string, type: 'retry' | 'cancel' | 'compact'): SessionInput {
  return { ...input(id), kind: 'control', command: { type } }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const until = Date.now() + 5_000
  while (!predicate()) {
    assert(Date.now() < until, 'timed out waiting for fixture')
    await delay(1)
  }
}

function controlledProvider() {
  const calls: Array<{
    messages: ChatMessage[]
    signal: AbortSignal
    model: string | undefined
    resolve: (response: LLMResponse) => void
    reject: (error: Error) => void
  }> = []
  const provider: LLMProvider = {
    name: 'fixture',
    listModels: () => ['fixture'],
    chat: async (messages, _tools, options) => {
      const pending = Promise.withResolvers<LLMResponse>()
      const signal = options!.signal!
      const abort = () => pending.reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      calls.push({ messages: structuredClone(messages), signal, model: options?.model, ...pending })
      try {
        signal.throwIfAborted()
        return await pending.promise
      } finally {
        signal.removeEventListener('abort', abort)
      }
    },
  }
  return { provider, calls }
}

async function fixture(options: {
  storage?: 'jsonl' | 'sqlite'
  ephemeral?: boolean
  manager?: boolean
  state?: Partial<SessionState>
  quickModel?: string
  sleepInactivityMs?: number
  handoff?: HandoffManager
  buildSystemPrompt?: () => Promise<string>
} = {}) {
  await mkdir('.test-data', { recursive: true })
  const workspace = await mkdtemp(join(process.cwd(), '.test-data', 'input-scheduling-'))
  const bus = new Bus()
  const facts: SessionTurnFact[] = []
  const ended: string[] = []
  const accepted: string[] = []
  const outbound: string[] = []
  const outboundMessages: OutboundMessage[] = []
  bus.on('session.turn.finished', (fact) => { facts.push(fact) })
  bus.on('session.ended', ({ sessionId }) => { ended.push(sessionId) })
  bus.on('session.input.accepted', ({ input }) => { accepted.push(input.id) })
  bus.on('message.outbound', (message) => {
    outbound.push(message.content)
    outboundMessages.push(message)
  })
  const { provider, calls } = controlledProvider()
  const tools = new Tools(workspace)
  const store: SessionStore = options.storage === 'sqlite'
    ? new SqliteSessionStore(join(workspace, 'sessions'))
    : new JsonlSessionStore(join(workspace, 'sessions'))
  await store.init()
  const state: SessionState = { sessionId: 'test:queue', segmentIndex: 0, mode: options.ephemeral ? 'task' : 'session', ...options.state }
  await store.saveState(state.sessionId, state)
  const reports: Array<Record<string, any>> = []
  let preparations = 0
  const handoff = options.handoff ?? { shouldHandoff: () => false } as unknown as HandoffManager
  const manager = options.manager ? new SessionManager({
    workspace, store, bus, provider, tools, handoffManager: handoff,
    sleep: { inactivityMs: options.sleepInactivityMs ?? 15 * 60_000 },
    getLlmRuntimeConfig: () => llm,
    quickModel: options.quickModel,
    events: { emit: async (event: Record<string, any>) => { reports.push(event) } },
    context: {
      buildSystemPrompt: async () => {
        preparations++
        return options.buildSystemPrompt ? options.buildSystemPrompt() : 'Fixture'
      },
    },
    agentTypes: {
      resolve: () => ({ name: 'fixture', description: '', prompt: '', defaultMode: options.ephemeral ? 'task' : 'session' }),
    },
  } as unknown as SessionManagerDeps) : undefined
  await manager?.start()
  const session = manager ? undefined : new Session(
    workspace, state.sessionId, state, [], provider, new SessionTools(tools, workspace), bus, store,
    handoff, () => {}, options.quickModel, options.sleepInactivityMs,
  )
  return {
    workspace, bus, facts, calls, provider, tools, store, state, session: session!, manager: manager!,
    reports, ended, accepted, outbound, outboundMessages, preparations: () => preparations,
    async close() {
      const active = manager
        ? manager.listActiveSessions().map(({ sessionId }) => manager.getActiveSession(sessionId)!)
        : [session!]
      const stopping = manager?.stop()
      session?.stop()
      try {
        await stopping
        await Promise.all(active.map((session) => session.completion))
      } finally {
        store.close?.()
        await rm(workspace, { recursive: true, force: true })
      }
    },
  }
}

function userInput(id: string, policy: SessionMessageInput['policy'] = 'queue'): SessionMessageInput {
  return { ...input(id, policy), source: { kind: 'user', sender: {
    channel: 'web', chatId: 'owner', messageId: id, senderId: 'owner',
  } } }
}

test('queued web messages neither interrupt nor steer the current turn and run FIFO afterwards', async () => {
  const f = await fixture()
  try {
    f.session.dispatch(userInput('initial'), llm)
    await waitFor(() => f.calls.length === 1)
    for (const id of ['queued-first', 'queued-second']) {
      f.session.dispatch(channelMessageInput({ channel: 'web', chatId: 'owner', senderId: 'owner',
        messageId: id, timestamp: new Date().toISOString(), content: id, delivery: 'queue' }), llm)
    }
    assert.equal(f.calls[0].signal.aborted, false)
    assert.equal(f.calls.length, 1)
    assert.doesNotMatch(JSON.stringify(f.calls[0].messages), /queued-first|queued-second/)
    f.calls[0].resolve(done('Initial result'))
    await waitFor(() => f.calls.length === 2)
    assert.match(JSON.stringify(f.calls[1].messages), /queued-first/)
    assert.doesNotMatch(JSON.stringify(f.calls[1].messages), /queued-second/)
    f.calls[1].resolve(done('First queued result'))
    await waitFor(() => f.calls.length === 3)
    assert.match(JSON.stringify(f.calls[2].messages), /queued-second/)
    f.calls[2].resolve(done('Second queued result'))
    await waitFor(() => f.facts.length === 3)
    assert.deepEqual(f.facts.map(fact => fact.inputId), ['initial', 'queued-first', 'queued-second'])
  } finally { await f.close() }
})

for (const phase of ['llm', 'tool'] as const) {
  test(`background completion during ${phase} joins the next inference without aborts or an unnecessary later turn`, async () => {
    const f = await fixture({ quickModel: 'fixture' })
    const work = Promise.withResolvers<string>()
    const started = Promise.withResolvers<void>()
    const events = new EventService(f.workspace, f.bus, async (sessionId, message) => {
      assert.equal(sessionId, f.state.sessionId)
      f.session.dispatch(message, llm)
      return { status: 'accepted', sessionId, inputId: message.id }
    })
    await events.start()
    const tasks = new BackgroundTaskManager(f.bus, events)
    f.tools.register({
      name: 'wait_for_work', description: '', parameters: { type: 'object', properties: {} },
      execute: async () => { started.resolve(); return work.promise },
    })
    const toolCall: LLMResponse = { content: '', toolCalls: [{ id: 'work', name: 'wait_for_work', arguments: {} }] }
    try {
      f.session.dispatch(userInput('build'), llm)
      await waitFor(() => f.calls.length === 1)
      if (phase === 'tool') { f.calls[0].resolve(toolCall); await started.promise }
      const task = tasks.createDeferredTask({
        kind: 'process', title: 'Completed dependency', sessionId: f.state.sessionId, inputId: 'build',
        callback: { sessionId: f.state.sessionId },
      })
      task.complete('Exact completed output')
      const observed = await tasks.getTaskOutput(task.taskId)
      assert.match(observed, /Exact completed output/)
      assert.equal(f.calls[0].signal.aborted, false)
      if (phase === 'llm') { f.calls[0].resolve(toolCall); await started.promise }
      work.resolve(observed)
      await waitFor(() => f.calls.length === 2)
      const messages = f.calls[1].messages
      assert(messages.some(message => message.role === 'tool' && String(message.content).includes('Exact completed output')))
      assert(messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('Exact completed output')))
      assert.deepEqual(messages.filter(message => message.role === 'tool').map(message => message.tool_call_id), ['work'])
      f.calls[1].resolve(done())
      await waitFor(() => f.facts.length === 1)
      await delay(20)
      assert.equal(f.calls.length, 2)
      assert.equal(f.facts[0].status, 'completed')
      assert.equal(f.calls[1].signal.aborted, false)
      const late = tasks.createDeferredTask({
        kind: 'process', title: 'Idle completion', sessionId: f.state.sessionId,
        callback: { sessionId: f.state.sessionId },
      })
      late.complete('A later result still wakes an idle owner')
      await waitFor(() => f.calls.length === 3)
      assert.match(JSON.stringify(f.calls[2].messages), /A later result still wakes an idle owner/)
      f.calls[2].resolve(done())
      await waitFor(() => f.facts.length === 2)
    } finally {
      work.resolve('cleanup')
      await tasks.stop()
      await events.stop()
      await f.close()
    }
  })
}

test('next-step arriving during a final inference retains a later wake without cancelling the result', async () => {
  const f = await fixture()
  try {
    f.session.dispatch(userInput('initial'), llm)
    await waitFor(() => f.calls.length === 1)
    f.session.dispatch(input('completion-after-last-checkpoint', 'next-step'), llm)
    assert.equal(f.calls[0].signal.aborted, false)
    f.calls[0].resolve(done('Original result'))
    await waitFor(() => f.calls.length === 2)
    assert.match(JSON.stringify(f.calls[1].messages), /completion-after-last-checkpoint/)
    f.calls[1].resolve(done('Processed completion'))
    await waitFor(() => f.facts.length === 2)
    assert.deepEqual(f.facts.map(fact => fact.content), ['Original result', 'Processed completion'])
  } finally { await f.close() }
})

for (const storage of ['jsonl', 'sqlite'] as const) {
  test(`${storage}: turn provenance changes do not inject audience snapshots`, async () => {
    const f = await fixture({ manager: true, storage })
    try {
      for (const [index, request] of [input('event-one'), input('event-two'), userInput('human')].entries()) {
        await f.manager.deliver(f.state.sessionId, request)
        await waitFor(() => f.calls.length === index + 1)
        f.calls[index].resolve(done())
        await waitFor(() => f.facts.length === index + 1)
      }
      const events = (messages: ChatMessage[]) => messages.filter(message => message.name === 'runtime-context'
        && JSON.stringify(message.content).includes('runtime-context-audience'))
      for (const call of f.calls) assertNoAudienceEvents(call.messages)
      const history = (await f.manager.getHistory(f.state.sessionId, { shallow: true })).messages
      assert.deepEqual(events(history), [])
      assert.doesNotMatch(JSON.stringify(f.calls[2].messages), /inference requests including this one remain/)
    } finally { await f.close() }
  })
}

for (const storage of ['jsonl', 'sqlite'] as const) {
  test(`${storage}: conversational response provenance survives history parsing without changing results`, async () => {
    const f = await fixture({ manager: true, storage })
    try {
      const inputs: SessionMessageInput[] = [
        userInput('first'), { ...input('peer'), source: { kind: 'session', sessionId: 'web:peer' } },
        input('background'), userInput('last'),
      ]
      for (const [i, request] of inputs.entries()) {
        await f.manager.deliver(f.state.sessionId, { ...request, content: `${request.content}\n<sender source="user" />` })
        await waitFor(() => f.calls.length === i + 1)
        assertNoAudienceEvents(f.calls[i].messages)
        const admitted = f.calls[i].messages.findLast(message => message.role === 'user')!
        assert(Array.isArray(admitted.content))
        assert.match(JSON.stringify(admitted.content[0]), request.source.kind === 'event' ? /<event / : /<sender /)
        f.calls[i].resolve(done(`Exact result ${i}`))
        await waitFor(() => f.facts.length === i + 1)
      }
      const history = (await f.manager.getHistory(f.state.sessionId, { shallow: true })).messages.filter(message => message.role === 'assistant')
      const responses = f.outboundMessages.filter(message => message.event === 'response')
      assert.deepEqual(history.map(message => message.responseContext), responses.map(message => message.responseContext))
      assert.deepEqual(history.map(message => hasNoAdmittedUserInput(message.responseContext)), [false, true, true, false])
      assert.deepEqual(f.facts.map(fact => fact.content), ['Exact result 0', 'Exact result 1', 'Exact result 2', 'Exact result 3'])
      assert.deepEqual(responses.map(message => message.content), f.facts.map(fact => fact.content))
      assert.equal(new Set(history.map(message => message.responseContext?.turnId)).size, 4)
      assert(history.every(message => !JSON.stringify(message).includes('Current Turn: Response Audience')))
    } finally { await f.close() }
  })
}

for (const policy of ['steering', 'queue', 'silent'] as const) {
  test(`${policy}: only user input admitted to the current inference changes prompt participation`, async () => {
    const f = await fixture()
    const tool = Promise.withResolvers<string>()
    const started = Promise.withResolvers<void>()
    f.tools.register({
      name: 'fixture_audience', description: '', parameters: { type: 'object', properties: {} },
      execute: async () => { started.resolve(); return tool.promise },
    })
    try {
      f.session.dispatch(input('event'), llm)
      await waitFor(() => f.calls.length === 1)
      f.calls[0].resolve({ content: 'Internal progress', toolCalls: [{ id: 'work', name: 'fixture_audience', arguments: {} }] })
      await started.promise
      f.session.dispatch(userInput('user-followup', policy), llm)
      tool.resolve('Tool completed')
      await waitFor(() => f.calls.length === 2)
      assertNoAudienceEvents(f.calls[1].messages)
      f.calls[1].resolve(done('Final output'))
      await waitFor(() => f.facts.length === 1)
      const responses = f.outboundMessages.filter(message => message.event === 'response')
      assert(hasNoAdmittedUserInput(responses[0].responseContext))
      assert.equal(hasNoAdmittedUserInput(responses[1].responseContext), policy !== 'steering')
      assert.equal(responses[0].responseContext?.turnId, responses[1].responseContext?.turnId)
      assert.notEqual(responses[0].responseContext?.responseId, responses[1].responseContext?.responseId)
      if (policy === 'queue') {
        await waitFor(() => f.calls.length === 3)
        assertNoAudienceEvents(f.calls[2].messages)
        f.calls[2].resolve(done())
        await waitFor(() => f.facts.length === 2)
      } else if (policy === 'silent') {
        await waitFor(() => f.session.history.some(message => JSON.stringify(message.content).includes('user-followup')))
        assert.equal(f.calls.length, 2)
      }
    } finally { tool.resolve('cleanup'); await f.close() }
  })
}

for (const type of ['retry', 'resume'] as const) {
  test(`user ${type} of a failed event turn is a user-involved response without another history input`, async () => {
    const f = await fixture()
    try {
      f.session.dispatch(input('event'), llm)
      await waitFor(() => f.calls.length === 1)
      f.calls[0].reject(new Error('Synthetic background failure'))
      await waitFor(() => f.facts.length === 1 && f.session.phase === 'idle')
      const recoveryId = f.session.getState().recovery!.id
      f.session.dispatch({ ...userInput('continue'), kind: 'control',
        command: type === 'retry' ? { type } : { type, recoveryId } }, llm)
      await waitFor(() => f.calls.length === 2)
      assertNoAudienceEvents(f.calls[1].messages)
      assert.equal(f.calls[1].messages.filter(message => message.role === 'user' && message.name !== 'runtime-context').length, 1)
      f.calls[1].resolve(done())
      await waitFor(() => f.facts.length === 2)
      assert.equal(f.outboundMessages.at(-1)?.responseContext?.userInvolved, true)
    } finally { await f.close() }
  })
}

test('event steering cannot remove user involvement from the current turn', async () => {
  const f = await fixture()
  const tool = Promise.withResolvers<string>()
  const started = Promise.withResolvers<void>()
  f.tools.register({ name: 'fixture_mixed', description: '', parameters: { type: 'object', properties: {} },
    execute: async () => { started.resolve(); return tool.promise } })
  try {
    f.session.dispatch(userInput('user'), llm)
    await waitFor(() => f.calls.length === 1)
    f.calls[0].resolve({ content: null, toolCalls: [{ id: 'mixed', name: 'fixture_mixed', arguments: {} }] })
    await started.promise
    f.session.dispatch(input('event', 'steering'), llm)
    tool.resolve('Done')
    await waitFor(() => f.calls.length === 2)
    assertNoAudienceEvents(f.calls[1].messages)
    f.calls[1].resolve(done())
    await waitFor(() => f.facts.length === 1)
    assert.equal(f.outboundMessages.at(-1)?.responseContext?.userInvolved, true)
  } finally { tool.resolve('cleanup'); await f.close() }
})

for (const afterTools of [false, true]) {
  test(`event interruption ${afterTools ? 'after tools' : 'before the first response'} preserves the unfinished user audience`, async () => {
    const f = await fixture()
    f.tools.register({ name: 'fixture_read', description: '', parameters: { type: 'object', properties: {} },
      execute: async () => 'Source' })
    try {
      f.session.dispatch(userInput('fix'), llm)
      await waitFor(() => f.calls.length === 1)
      if (afterTools) {
        f.calls[0].resolve({ content: null, toolCalls: [{ id: 'read', name: 'fixture_read', arguments: {} }] })
        await waitFor(() => f.calls.length === 2)
      }
      const interrupted = f.calls.at(-1)!
      f.session.dispatch(input('subagent-complete', 'steering'), llm)
      await waitFor(() => f.calls.length === (afterTools ? 3 : 2))
      assert(interrupted.signal.aborted)
      assertNoAudienceEvents(f.calls.at(-1)!.messages)
      f.calls.at(-1)!.resolve(done('Fix completed for the user'))
      await waitFor(() => f.facts.length === 2 && f.session.phase === 'idle')
      const response = f.outboundMessages.at(-1)!
      assert.equal(response.responseContext?.source.kind, 'event')
      assert.equal(response.responseContext?.userInvolved, true)
      assert.equal(f.facts.at(-1)?.source.kind, 'event')
      const stored = await Array.fromAsync(f.store.readSessionLog(SessionManager.currentPhysicalId(f.state)))
      assert.deepEqual(stored.at(-1)?.responseContext, response.responseContext)

      f.session.dispatch(input('independent-event'), llm)
      await waitFor(() => f.calls.length === (afterTools ? 4 : 3))
      assertNoAudienceEvents(f.calls.at(-1)!.messages)
      f.calls.at(-1)!.resolve(done('Background coordination'))
      await waitFor(() => f.facts.length === 3)
      assert(hasNoAdmittedUserInput(f.outboundMessages.at(-1)?.responseContext))
    } finally { await f.close() }
  })
}

for (const storage of ['jsonl', 'sqlite'] as const) {
  test(`${storage}: history repairs lost user audience before pagination and restores it on the next event`, async () => {
    const f = await fixture({ storage, manager: true })
    const foreground = createResponseContext('user-turn', userInput('fix').source, 'session', 'web')!
    const background = createResponseContext('event-turn', input('completed').source, 'session', 'web')!
    const tool_calls: ChatMessage['tool_calls'] = [{
      id: 'read', type: 'function', function: { name: 'read', arguments: '{}' },
    }]
    const records = [
      { role: 'assistant' as const, content: null, tool_calls, responseContext: foreground },
      { role: 'tool' as const, content: 'Source', tool_call_id: 'read', name: 'read' },
      { role: 'assistant' as const, content: null, tool_calls: [{ ...tool_calls[0], id: 'check' }], responseContext: background },
      { role: 'tool' as const, content: 'Checked', tool_call_id: 'check', name: 'read' },
    ].map(message => ({ ...message, timestamp: '2026-01-01T00:00:00Z' }))
    const physicalId = SessionManager.currentPhysicalId(f.state)
    try {
      await f.store.appendMessages(physicalId, records)
      for (const query of [{}, { shallow: true }, { physicalId }, { offset: 2, pageSize: 1 }, { maxMessages: 2 }]) {
        const history = await f.manager.getHistory(f.state.sessionId, query)
        const restored = history.messages.find(message => message.responseContext?.turnId === 'event-turn')
        assert.equal(restored?.responseContext?.userInvolved, true)
        assert.deepEqual(restored?.responseContext?.source, background.source)
      }
      const persisted = await Array.fromAsync(f.store.readSessionLog(physicalId))
      assert.equal(persisted.length, records.length)
      assert.deepEqual(persisted[2].responseContext, background)

      await f.manager.deliver(f.state.sessionId, input('next-completion'), llm)
      await waitFor(() => f.calls.length === 1)
      assertNoAudienceEvents(f.calls[0].messages)
      f.calls[0].resolve(done('User-facing final result'))
      await waitFor(() => f.facts.length === 1)
      assert.equal(f.outboundMessages.at(-1)?.responseContext?.userInvolved, true)
      const live = await f.manager.getHistory(f.state.sessionId, { offset: -1, pageSize: 1 })
      assert.deepEqual(live.messages[0].responseContext, f.outboundMessages.at(-1)?.responseContext)
    } finally { await f.close() }
  })
}

for (const ephemeral of [false, true]) {
  test(`${ephemeral ? 'ephemeral' : 'persistent'} session publishes intermediate phase transitions without polling`, async () => {
    const f = await fixture({ manager: true, ephemeral })
    const tool = Promise.withResolvers<string>()
    const phases: string[] = []
    f.bus.on('session.activity.changed', ({ sessionId }) => {
      phases.push(f.manager.getActiveSession(sessionId)?.phase ?? 'inactive')
    })
    f.tools.register({
      name: 'fixture_phase', description: '', parameters: { type: 'object', properties: {} },
      execute: async () => tool.promise,
    })
    try {
      await f.manager.deliver(f.state.sessionId, input('phase-turn'))
      await waitFor(() => f.calls.length === 1)
      assert(phases.includes('llm'))
      f.calls[0].resolve({ content: null, toolCalls: [{ id: 'phase-tool', name: 'fixture_phase', arguments: {} }] })
      await waitFor(() => phases.includes('tool'))
      assert.equal(phases.at(-1), 'tool')
      tool.resolve('Complete')
      await waitFor(() => f.calls.length === 2)
      assert.equal(phases.at(-1), 'llm')
      f.calls[1].resolve(done())
      await waitFor(() => phases.includes('idle'))
    } finally { tool.resolve('Cleanup'); await f.close() }
  })
}

test('invalidated prompts stay frozen across active turns and refresh after sleep and reactivation', async () => {
  let prompt = 'Trusted audience'
  const f = await fixture({ manager: true, sleepInactivityMs: 100, buildSystemPrompt: async () => prompt })
  try {
    await f.manager.deliver(f.state.sessionId, input('first'))
    await waitFor(() => f.calls.length === 1)
    assert.equal(f.calls[0].messages[0].content, 'Trusted audience')
    prompt = 'Shared audience'
    f.manager.invalidateSystemPrompts()
    f.calls[0].resolve(done())
    await waitFor(() => f.facts.length === 1)
    await f.manager.deliver(f.state.sessionId, input('second'))
    await waitFor(() => f.calls.length === 2)
    assert.equal(f.calls[1].messages[0].content, 'Trusted audience')
    assert.deepEqual(f.calls[1].messages.filter(message => message.role === 'system'), f.calls[0].messages.filter(message => message.role === 'system'))
    assert(f.calls[1].messages.some(message => message.role === 'assistant' && message.content === 'Finished'))
    assert.equal(f.preparations(), 1)
    f.calls[1].resolve(done())
    await waitFor(() => f.facts.length === 2)
    await waitFor(() => !f.manager.getActiveSession(f.state.sessionId))
    await f.manager.deliver(f.state.sessionId, input('after-sleep'))
    await waitFor(() => f.calls.length === 3)
    assert.equal(f.calls[2].messages[0].content, 'Shared audience')
    assert.equal(f.preparations(), 2)
    f.calls[2].resolve(done())
    await waitFor(() => f.facts.length === 3)
  } finally { await f.close() }
})

test('Work context replacement retains the active system snapshot and refreshes only conversational context', async () => {
  let prompt = 'Activation snapshot'
  const f = await fixture({ manager: true, buildSystemPrompt: async () => prompt })
  try {
    await f.manager.deliver(f.state.sessionId, input('first'))
    await waitFor(() => f.calls.length === 1)
    const firstSystem = f.calls[0].messages.filter(message => message.role === 'system')
    f.calls[0].resolve(done())
    const active = f.manager.getActiveSession(f.state.sessionId) as Session
    await waitFor(() => active.quiescent)
    prompt = 'Configuration changed while active'
    f.manager.invalidateSystemPrompts()
    await active.replaceWorkContext('Current Work replacement', 'fixture-transition')
    await f.manager.deliver(f.state.sessionId, input('second'))
    await waitFor(() => f.calls.length === 2)
    assert.deepEqual(f.calls[1].messages.filter(message => message.role === 'system'), firstSystem)
    assert(f.calls[1].messages.some(message => message.name === '__work_handoff__' && message.content === 'Current Work replacement'))
    assert.equal(f.preparations(), 1)
    f.calls[1].resolve(done())
    await waitFor(() => f.facts.length === 2)
  } finally { await f.close() }
})

test('audience invalidation during prompt preparation cannot install a stale prompt', async () => {
  const gate = Promise.withResolvers<void>()
  let prompt = 'Trusted audience'
  let builds = 0
  const f = await fixture({ manager: true, buildSystemPrompt: async () => {
    const snapshot = prompt
    if (++builds === 1) await gate.promise
    return snapshot
  } })
  try {
    const admitted = f.manager.deliver(f.state.sessionId, input('first'))
    await waitFor(() => builds === 1)
    prompt = 'Shared audience'
    f.manager.invalidateSystemPrompts()
    gate.resolve()
    await admitted
    await waitFor(() => f.calls.length === 1)
    assert.equal(f.calls[0].messages[0].content, 'Shared audience')
    assert.equal(builds, 2)
    f.calls[0].resolve(done())
    await waitFor(() => f.facts.length === 1)
  } finally { gate.resolve(); await f.close() }
})

test('prompt invalidation during tool execution preserves the activation snapshot and tool pairing', async () => {
  let prompt = 'Trusted audience'
  const gate = Promise.withResolvers<string>()
  const started = Promise.withResolvers<void>()
  const f = await fixture({ manager: true, buildSystemPrompt: async () => prompt })
  f.tools.register({
    name: 'audience_wait', description: '', parameters: { type: 'object', properties: {} },
    execute: async () => { started.resolve(); return gate.promise },
  })
  try {
    await f.manager.deliver(f.state.sessionId, input('first'))
    await waitFor(() => f.calls.length === 1)
    f.calls[0].resolve({ content: null, toolCalls: [{ id: 'audience-tool', name: 'audience_wait', arguments: {} }] })
    await started.promise
    prompt = 'Shared audience'
    f.manager.invalidateSystemPrompts()
    gate.resolve('Completed tool')
    await waitFor(() => f.calls.length === 2)
    assert.equal(f.calls[1].messages[0].content, 'Trusted audience')
    assert.deepEqual(f.calls[1].messages.filter(message => message.role === 'system'), f.calls[0].messages.filter(message => message.role === 'system'))
    assert.equal(f.calls[1].messages.filter(message => message.tool_call_id === 'audience-tool').length, 1)
    f.calls[1].resolve(done())
    await waitFor(() => f.facts.length === 1)
  } finally { gate.resolve('cleanup'); await f.close() }
})

test('prompt rebuild failures affect reactivation, never mutate an active system snapshot', async () => {
  let fail = false
  const f = await fixture({ manager: true, buildSystemPrompt: async () => {
    if (fail) throw new Error('Audience context unavailable')
    return 'Current audience'
  } })
  try {
    await f.manager.deliver(f.state.sessionId, input('first'))
    await waitFor(() => f.calls.length === 1)
    f.calls[0].resolve(done())
    await waitFor(() => f.facts.length === 1)
    fail = true
    f.manager.invalidateSystemPrompts()
    await f.manager.deliver(f.state.sessionId, input('second'))
    await waitFor(() => f.calls.length === 2)
    assert.equal(f.calls[1].messages[0].content, 'Current audience')
    f.calls[1].resolve(done())
    await waitFor(() => f.facts.length === 2)
    const active = f.manager.getActiveSession(f.state.sessionId)!
    active.stop()
    await active.completion
    await assert.rejects(f.manager.deliver(f.state.sessionId, input('failed-activation')), /Audience context unavailable/)
    assert.equal(f.calls.length, 2)
    fail = false
    await f.manager.deliver(f.state.sessionId, input('third'))
    await waitFor(() => f.calls.length === 3)
    assert.equal(f.calls[2].messages[0].content, 'Current audience')
    f.calls[2].resolve(done())
    await waitFor(() => f.facts.length === 3)
  } finally { await f.close() }
})

for (const outcome of ['tools', 'failure', 'cancel'] as const) {
  test(`project bot address reaches every ${outcome} outbound event`, async () => {
    const address = { projectId: 'org-a', botInstanceId: 'bot-a', platform: 'qq', conversationId: 'shared-room' }
    const f = await fixture({ state: { sessionId: channelSessionId(address), projectId: address.projectId } })
    f.tools.register({
      name: 'fixture_address', description: '', parameters: { type: 'object', properties: {} },
      execute: async (_args, ctx) => {
        assert.equal(ctx.projectId, address.projectId)
        assert.deepEqual(ctx.channelAddress, address)
        return 'Address retained'
      },
    })
    try {
      f.session.dispatch(input('first'), llm)
      await waitFor(() => f.calls.length === 1)
      if (outcome === 'tools') {
        f.calls[0].resolve({ content: null, toolCalls: [{ id: 'tool-1', name: 'fixture_address', arguments: {} }] })
        await waitFor(() => f.calls.length === 2)
        f.calls[1].resolve(done())
      } else if (outcome === 'failure') {
        f.calls[0].reject(new Error('Fixture failure'))
      } else {
        f.session.dispatch(control('cancel', 'cancel'), llm)
      }
      await waitFor(() => f.facts.length === 1)
      assert.deepEqual(f.outboundMessages.map(message => message.event),
        outcome === 'tools' ? ['tool_call', 'tool_result', 'response'] : ['response'])
      for (const message of f.outboundMessages) {
        assert.deepEqual(message.channelAddress, address)
        assert.equal(message.channel, address.platform)
        assert.equal(message.chatId, address.conversationId)
      }
      assert.equal(f.facts[0].status, outcome === 'tools' ? 'completed' : outcome === 'failure' ? 'failed' : 'cancelled')
    } finally { await f.close() }
  })
}

// Before this refactor, the same fixture reproduced EventService's default
// queue projection omitting eventMeta.urgency and aborting an active provider.
for (const origin of ['explicit-queue', 'default-event', 'debounced-event']) {
  test(`${origin}: admitted queue does not abort the active LLM`, async () => {
    const f = await fixture({ quickModel: 'quick' })
    try {
      f.session.dispatch(input('first'), llm)
      await waitFor(() => f.calls.length === 1)
      f.session.dispatch(input(origin), llm)
      assert.equal(f.calls[0].signal.aborted, false)
      assert.equal(f.calls.length, 1)
      f.calls[0].resolve(done('first done'))
      await waitFor(() => f.calls.length === 2)
      assert.equal(f.facts.length, 1)
      assert.equal(f.facts[0].inputId, 'first')
      f.calls[1].resolve(done('queued done'))
      await waitFor(() => f.facts.length === 2)
      assert.deepEqual(f.facts.map((fact) => fact.status), ['completed', 'completed'])
      assert.deepEqual(f.facts.map((fact) => fact.content), ['first done', 'queued done'])
      assert.notEqual(f.facts[0].turnId, f.facts[1].turnId)
    } finally { await f.close() }
  })
}

for (const policy of ['interactive', 'steering'] as const) {
  test(`${policy}: active LLM aborts and produces a cancelled fact`, async () => {
    const f = await fixture()
    try {
      f.session.dispatch(input('first'), llm)
      await waitFor(() => f.calls.length === 1)
      f.session.dispatch(input('next', policy), llm)
      assert.equal(f.calls[0].signal.aborted, true)
      await waitFor(() => f.calls.length === 2)
      assert.equal(f.facts[0].status, 'cancelled')
      f.calls[1].resolve(done())
      await waitFor(() => f.facts.length === 2)
      assert.equal(f.facts[1].status, 'completed')
    } finally { await f.close() }
  })
}

for (const policy of ['queue', 'silent', 'interactive', 'steering'] as const) {
  test(`${policy}: active tool preserves queue/steering semantics and tool pairs`, async () => {
    const f = await fixture({ quickModel: 'quick' })
    const tool = Promise.withResolvers<string>()
    const started = Promise.withResolvers<AbortSignal>()
    f.tools.register({
      name: 'fixture_wait', description: '', parameters: { type: 'object', properties: {} },
      execute: async (_args, ctx) => { started.resolve(ctx.signal); return tool.promise },
    })
    try {
      f.session.dispatch(input('first'), llm)
      await waitFor(() => f.calls.length === 1)
      f.calls[0].resolve({ content: null, toolCalls: [{ id: 'tool-1', name: 'fixture_wait', arguments: {} }] })
      const signal = await started.promise
      ;(f.session as any).turn.toolStartedAt = Date.now() - 21_000
      if (policy === 'interactive') {
        // Short tools follow the human heuristic without quickModel.
        ;(f.session as any).turn.toolStartedAt = Date.now()
      }
      f.session.dispatch(input('next', policy), llm)
      assert.equal(signal.aborted, false)
      tool.resolve('Tool done')
      await waitFor(() => f.calls.length === 2)
      const steered = policy === 'interactive' || policy === 'steering'
      assert.equal(f.calls[1].messages.some((m) => m.role === 'user' && m.name !== 'runtime-context' && JSON.stringify(m.content).includes('next')), steered)
      assert.equal(f.calls[1].messages.filter((m) => m.tool_call_id === 'tool-1').length, 1)
      f.calls[1].resolve(done())
      if (policy === 'queue') {
        await waitFor(() => f.calls.length === 3)
        f.calls[2].resolve(done())
        await waitFor(() => f.facts.length === 2)
      } else {
        await waitFor(() => f.facts.length === 1 && f.session.phase === 'idle')
        if (policy === 'silent') {
          await waitFor(() => f.session.history.some((m) => JSON.stringify(m.content).includes('next')))
        }
        assert.equal(f.calls.length, 2)
        assert.equal(f.facts.length, 1)
      }
    } finally {
      tool.resolve('cleanup')
      await f.close()
    }
  })
}

for (const staged of [false, true]) {
  test(`message context handoff resumes without human input (${staged ? 'silent parts then final request' : 'queued follow-up requests'})`, async () => {
    const f = await fixture()
    const tool = new MessageTool(f.bus, () => true, () => undefined, () => [], async (sessionId, message) => {
      f.session.dispatch(message, llm)
      return { status: 'accepted', sessionId, inputId: message.id }
    })
    const context: ExecutionContext = {
      sessionId: 'web:orchestrator', physicalSessionId: 'coordinator.0', channel: 'web', chatId: 'orchestrator',
      senderId: 'owner', messageId: 'handoff', signal: new AbortController().signal,
      tools: new SessionTools(f.tools, '.'),
    }
    const send = (content: string, silent = false) => tool.execute({
      sessionId: f.state.sessionId, content, intent: silent ? 'progress' : 'request', delivery: silent ? 'silent' : 'queue',
    }, context)
    try {
      await send('Implement issues')
      await waitFor(() => f.calls.length === 1)
      await send('Notify source', staged)
      await send('Agent and skill baseline', staged)
      if (staged) await send('All material supplied; finish implementation')
      assert.equal(f.calls.length, 1, 'Follow-ups do not start concurrent inference')
      assert.equal(f.calls[0].signal.aborted, false, 'Ordinary messaging never interrupts active work')
      assert.equal(f.calls[0].messages.some(message => JSON.stringify(message.content).includes('Notify source')), false)
      f.calls[0].resolve(done('Issues complete'))
      await waitFor(() => f.calls.length === 2)
      assert(f.calls[1].messages.some(message => JSON.stringify(message.content).includes('Notify source')))
      if (staged) {
        assert(f.calls[1].messages.some(message => JSON.stringify(message.content).includes('Agent and skill baseline')))
        assert(f.calls[1].messages.some(message => JSON.stringify(message.content).includes('All material supplied')))
      }
      f.calls[1].resolve(done('Notify complete'))
      if (!staged) {
        await waitFor(() => f.calls.length === 3)
        assert(f.calls[2].messages.some(message => JSON.stringify(message.content).includes('Agent and skill baseline')))
        f.calls[2].resolve(done('All complete'))
      }
      await waitFor(() => f.session.quiescent)
      assert.equal(f.facts.length, staged ? 2 : 3)
    } finally { await f.close() }
  })
}

for (const storage of ['jsonl', 'sqlite'] as const) {
  test(`QQ peer handoff produces a proactive final group notification (${storage})`, async t => {
    const address = { projectId: 'project', botInstanceId: 'qq-bot', platform: 'qq', conversationId: 'group:group' }
    const f = await fixture({ storage, state: {
      sessionId: channelSessionId(address), projectId: address.projectId, physicalIdVersion: 2,
    } })
    const channel = new QQChannel(f.bus, { appId: 'synthetic', secret: 'synthetic' })
    const sent: Array<{ path: string; body: unknown }> = []
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input)
      if (url.hostname === 'bots.qq.com') return Response.json({ access_token: 'synthetic-token', expires_in: 7200 })
      sent.push({ path: url.pathname, body: JSON.parse(String(init?.body)) })
      return Response.json({ id: 'proactive-result' })
    })
    try {
      f.session.dispatch({
        id: 'task-handoff', timestamp: new Date().toISOString(), kind: 'message', policy: 'queue',
        source: { kind: 'session', sessionId: 'web:worker', coordination: { intent: 'handoff' } },
        content: 'The task is complete. Notify the QQ group.',
      }, llm)
      await waitFor(() => f.calls.length === 1)
      assert.match(JSON.stringify(f.calls[0].messages), /The task is complete/)
      f.calls[0].resolve(done('The fix is ready for review.'))
      await waitFor(() => f.session.quiescent)
      const final = f.outboundMessages.find(message => message.event === 'response' && message.done)
      assert.ok(final)
      assert.deepEqual(final.channelAddress, address)
      assert.equal(final.replyTo, undefined)
      for (const message of f.outboundMessages) await channel.onMessage(message)
      assert.deepEqual(sent, [{
        path: '/v2/groups/group/messages',
        body: { msg_type: 2, markdown: { content: 'The fix is ready for review.' } },
      }])
      const records = await Array.fromAsync(f.store.readSessionLog(SessionManager.currentPhysicalId(f.state)))
      assert.match(JSON.stringify(records), /The fix is ready for review/)
    } finally { await channel.stop(); await f.close() }
  })

  test(`QQ sticker previews survive silent history and quoted reuse without model images (${storage})`, async t => {
    const f = await fixture({ storage, state: { sessionId: 'qq:group:group' } })
    const channel = new QQChannel(f.bus, { appId: 'synthetic', secret: 'synthetic', workspace: f.workspace })
    channel.setReceiver(async message => {
      f.session.dispatch(channelMessageInput(message), llm)
      return { status: 'accepted', sessionId: f.state.sessionId, inputId: message.messageId }
    })
    const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
    t.mock.method(globalThis, 'fetch', async () => new Response(gif, { headers: { 'content-type': 'image/gif' } }))
    const base = { group_openid: 'group', author: { member_openid: 'sender' }, timestamp: new Date().toISOString() }
    const face = '<faceType=6,faceId="0",ext="eyJ0ZXh0IjoiIn0=">'
    try {
      await channel['handleDispatch']('GROUP_MESSAGE_CREATE', {
        ...base, id: 'sticker', content: `${face} Keep my words`,
        message_scene: { ext: ['msg_idx=sticker-index'] },
        attachments: [{ filename: 'face.jpg', content_type: 'image/gif', url: 'https://multimedia.nt.qq.com.cn/face' }],
      })
      await waitFor(() => f.session.history.length === 1 && f.session.quiescent)
      assert.equal(f.calls.length, 0)
      const saved = await Array.fromAsync(f.store.readSessionLog(SessionManager.currentPhysicalId(f.state)))
      assert.match(JSON.stringify(saved), /image_url/)
      assert.match(JSON.stringify(saved), /"displayOnly":true/)
      await channel['handleDispatch']('GROUP_AT_MESSAGE_CREATE', {
        ...base, id: 'quote', content: 'Explain the real image', message_type: 103,
        message_scene: { ext: ['ref_msg_idx=sticker-index'] },
        attachments: [{ filename: 'normal.gif', content_type: 'image/gif', url: 'https://multimedia.nt.qq.com.cn/normal' }],
      })
      await waitFor(() => f.calls.length === 1)
      const images = f.calls[0].messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(part => part.type === 'image_url') : [])
      assert.equal(images.length, 1, 'only the normal GIF reaches inference, not either copy of the sticker')
      assert.match(JSON.stringify(f.calls[0].messages), /Keep my words|Explain the real image/)
      assert.doesNotMatch(JSON.stringify(f.calls[0].messages), /displayOnly/)
      assert.equal(f.session.history.flatMap(message => Array.isArray(message.content) ? message.content.filter(part => part.type === 'image_url') : []).length, 3)
      f.calls[0].resolve(done())
      await waitFor(() => f.session.quiescent)
    } finally { await channel.stop(); await f.close() }
  })

  test(`QQ documented rich message content persists and reaches the provider (${storage})`, async t => {
    const f = await fixture({ storage, state: { sessionId: 'qq:group:group' } })
    const channel = new QQChannel(f.bus, { appId: 'synthetic', secret: 'synthetic', workspace: f.workspace })
    channel.setReceiver(async message => {
      assert.equal(message.admin, false)
      assert.equal(message.senderName, 'Example sender')
      f.session.dispatch(channelMessageInput(message), llm)
      return { status: 'accepted', sessionId: f.state.sessionId, inputId: message.messageId }
    })
    t.mock.method(globalThis, 'fetch', async () => new Response('voice bytes'))
    try {
      await channel['handleDispatch']('GROUP_AT_MESSAGE_CREATE', {
        id: 'rich-input', group_openid: 'group',
        author: { member_openid: 'sender', username: 'Example sender', member_role: 'owner' },
        timestamp: new Date().toISOString(), content: '', message_type: 101,
        message_scene: { source: 'default', ext: ['msg_idx=rich-index', 'auth_token=private-secret'] },
        msg_elements: [
          { message_type: 3, ark_data: { ark_type: 'feed', fields: { title: 'Report', desc: 'Quarterly results' } } },
          { attachments: [{ content_type: 'voice', voice_wav_url: 'https://multimedia.nt.qq.com.cn/voice',
            asr_refer_text: 'Summarize the report' }] },
        ],
      })
      await waitFor(() => f.calls.length === 1)
      const providerText = JSON.stringify(f.calls[0].messages)
      assert.match(providerText, /Quarterly results/)
      assert.match(providerText, /Summarize the report/)
      assert.match(providerText, /voice\.wav/)
      assert.doesNotMatch(providerText, /private-secret/)
      f.calls[0].resolve(done('Summary'))
      await waitFor(() => f.session.quiescent)
      const records = await Array.fromAsync(f.store.readSessionLog(SessionManager.currentPhysicalId(f.state)))
      assert.match(JSON.stringify(records), /Quarterly results/)
      assert.match(JSON.stringify(records), /voice\.wav/)
      assert.doesNotMatch(JSON.stringify(records), /private-secret/)
    } finally { await channel.stop(); await f.close() }
  })

  test(`QQ file-only non-mention survives storage and reaches the next full-mode mention (${storage})`, async t => {
    const f = await fixture({ storage, state: { sessionId: 'qq:group:group' } })
    const channel = new QQChannel(f.bus, { appId: 'synthetic', secret: 'synthetic', workspace: f.workspace })
    channel.setReceiver(async message => {
      f.session.dispatch(channelMessageInput(message), llm)
      return { status: 'accepted', sessionId: f.state.sessionId, inputId: message.messageId }
    })
    t.mock.method(globalThis, 'fetch', async () => new Response('synthetic zip bytes'))
    const data = { group_openid: 'group', author: { member_openid: 'sender' }, timestamp: new Date().toISOString() }
    try {
      await channel['handleDispatch']('GROUP_MESSAGE_CREATE', {
        ...data, id: 'file', content: '', attachments: [{
          filename: 'report (16).zip', content_type: 'file', url: 'https://multimedia.nt.qq.com.cn/download',
        }],
      })
      await waitFor(() => f.session.history.length === 1 && f.session.quiescent)
      assert.equal(f.calls.length, 0)
      const records = await Array.fromAsync(f.store.readSessionLog(SessionManager.currentPhysicalId(f.state)))
      assert.match(JSON.stringify(records), /report__16_\.zip/)
      await channel['handleDispatch']('GROUP_MESSAGE_CREATE', {
        ...data, id: 'mention', content: '<@group-bot-openid> Can you read the file I just sent?',
        author: { member_openid: 'sender', username: 'Alice', member_role: 'owner' },
        mentions: [{ id: 'group-bot-openid', username: 'Report Bot', is_you: true }],
      })
      await waitFor(() => f.calls.length === 1)
      const providerInput = JSON.stringify(f.calls[0].messages)
      assert.match(providerInput, /platform-role=\\\"owner\\\"/)
      assert.match(providerInput, /@Report Bot Can you read the file/)
      assert.doesNotMatch(providerInput, /QQ display metadata|QQ attachment metadata|<@group-bot-openid>/)
      const path = providerInput.match(/uploads\/qq_[\da-f-]+_report__16_\.zip/)?.[0]
      assert.ok(path, 'next provider request includes the earlier file attachment')
      assert.equal(await readFile(join(sessionWorkspacePath(f.workspace, f.state.sessionId), path), 'utf8'), 'synthetic zip bytes')
      f.calls[0].resolve(done('The attached report is available.'))
      await waitFor(() => f.session.quiescent)
      const saved = await Array.fromAsync(f.store.readSessionLog(SessionManager.currentPhysicalId(f.state)))
      assert.doesNotMatch(JSON.stringify(saved), /QQ display metadata|QQ attachment metadata|<@group-bot-openid>/)
      assert.match(JSON.stringify(saved), /platform-role=\\\"owner\\\"/)
    } finally { await channel.stop(); await f.close() }
  })

  test(`QQ non-mention messages persist without calls and feed the next mention (${storage})`, async () => {
    const f = await fixture({ storage, state: { sessionId: 'qq:group:group' } })
    const channel = new QQChannel(f.bus, { appId: 'synthetic', secret: 'synthetic' })
    channel.setReceiver(async message => {
      f.session.dispatch(channelMessageInput(message), llm)
      return { status: 'accepted', sessionId: f.state.sessionId, inputId: message.messageId }
    })
    const incoming = (id: string, content: string, mentioned = false) => channel['handleDispatch'](
      mentioned ? 'GROUP_AT_MESSAGE_CREATE' : 'GROUP_MESSAGE_CREATE',
      { id, content, group_openid: 'group', author: { member_openid: 'sender' }, timestamp: new Date().toISOString() },
    )
    try {
      await incoming('background', 'The launch date is October 20.')
      await waitFor(() => f.session.history.length === 1 && f.session.phase === 'idle')
      assert.equal(f.calls.length, 0)
      assert.equal(f.facts.length, 0)
      assert.equal(f.outboundMessages.length, 0)
      const records = await Array.fromAsync(f.store.readSessionLog(SessionManager.currentPhysicalId(f.state)))
      assert.match(JSON.stringify(records), /The launch date is October 20/)
      await incoming('mention', 'What is the launch date?', true)
      await waitFor(() => f.calls.length === 1)
      assert.match(JSON.stringify(f.calls[0].messages), /The launch date is October 20/)
      assert.match(JSON.stringify(f.calls[0].messages), /What is the launch date/)
      await incoming('during-call', 'The venue is the main hall.')
      assert.equal(f.calls[0].signal.aborted, false)
      f.calls[0].resolve(done('October 20'))
      await waitFor(() => f.session.quiescent)
      assert.equal(f.calls.length, 1)
      assert.equal(f.facts.length, 1)
      assert.match(JSON.stringify(f.session.history), /The venue is the main hall/)
      await incoming('next-mention', 'Where is the launch?', true)
      await waitFor(() => f.calls.length === 2)
      assert.match(JSON.stringify(f.calls[1].messages), /The venue is the main hall/)
      f.calls[1].resolve(done('The main hall'))
      await waitFor(() => f.session.quiescent)
      assert.equal(f.facts.length, 2)
    } finally { await channel.stop(); await f.close() }
  })
}

test('silent records have no model turn; retry reuses the original prompt', async () => {
  const f = await fixture()
  try {
    f.session.dispatch(input('silent', 'silent'), llm)
    await waitFor(() => f.session.history.length === 1 && f.session.phase === 'idle')
    assert.equal(f.facts.length, 0)
    assert.equal(f.calls.length, 0)
    f.session.dispatch(input('request'), llm)
    await waitFor(() => f.calls.length === 1)
    f.calls[0].reject(new Error('Fixture provider failure'))
    await waitFor(() => f.facts.length === 1)
    assert.equal(f.facts[0].status, 'failed')
    assert.equal(f.facts[0].error, 'Fixture provider failure')
    assert.match(f.outbound[0], /Request failed/)
    f.session.dispatch(control('retry', 'retry'), llm)
    await waitFor(() => f.calls.length === 2)
    assert.equal(f.calls[1].messages.filter((m) => m.role === 'user' && m.name !== 'runtime-context').length, 2)
    f.calls[1].resolve(done())
    await waitFor(() => f.facts.length === 2)
    assert.equal(f.facts[1].inputId, 'retry')
  } finally { await f.close() }
})

test('retry aborts the active provider and replays history without another prompt', async () => {
  const f = await fixture()
  try {
    f.session.dispatch(input('original'), llm)
    await waitFor(() => f.calls.length === 1)
    f.session.dispatch({
      ...input('retry'), kind: 'control',
      command: { type: 'retry', fallbackContent: 'Must not append this fallback' },
    }, llm)
    assert.equal(f.calls[0].signal.aborted, true)
    await waitFor(() => f.calls.length === 2)
    assert.equal(f.facts[0].status, 'cancelled')
    assert.equal(f.calls[1].messages.filter((message) => message.role === 'user' && message.name !== 'runtime-context').length, 1)
    assert.match(JSON.stringify(f.calls[1].messages.find(message => message.role === 'user')?.content), /original/)
    assert(!JSON.stringify(f.calls[1].messages).includes('Must not append this fallback'))
    f.calls[1].resolve(done())
    await waitFor(() => f.facts.length === 2)
    assert.equal(f.facts[1].inputId, 'retry')
    assert.equal(f.facts[1].status, 'completed')
  } finally { await f.close() }
})

test('retry during a tool waits for paired results rather than becoming a steerable prompt', async () => {
  const f = await fixture({ quickModel: 'quick' })
  const tool = Promise.withResolvers<string>()
  f.tools.register({
    name: 'fixture_wait', description: '', parameters: { type: 'object', properties: {} },
    execute: async () => tool.promise,
  })
  try {
    f.session.dispatch(input('original'), llm)
    await waitFor(() => f.calls.length === 1)
    f.calls[0].resolve({ content: null, toolCalls: [{ id: 'wait', name: 'fixture_wait', arguments: {} }] })
    await waitFor(() => f.session.phase === 'tool')
    ;(f.session as any).turn.toolStartedAt = Date.now() - 21_000
    f.session.dispatch(control('retry', 'retry'), llm)
    assert.equal(f.calls[0].signal.aborted, false)
    assert.equal((f.session as any).turn.steerQueue.length, 0)
    assert.equal(f.calls.length, 1)
    tool.resolve('tool completed')
    await waitFor(() => f.calls.length === 2)
    assert.equal(f.calls[1].messages.filter(message => message.role === 'tool').at(-1)?.tool_call_id, 'wait')
    f.calls[1].resolve(done())
    await waitFor(() => f.calls.length === 3)
    assert.equal(f.calls[2].messages.filter((message) => message.role === 'user' && message.name !== 'runtime-context').length, 1)
    f.calls[2].resolve(done())
    await waitFor(() => f.facts.length === 2)
    assert.equal(f.facts[1].inputId, 'retry')
  } finally { tool.resolve('cleanup'); await f.close() }
})

test('cancel aborts only the active turn and queued input survives', async () => {
  const f = await fixture()
  try {
    f.session.dispatch(input('first'), llm)
    await waitFor(() => f.calls.length === 1)
    f.session.dispatch(input('queued'), llm)
    f.session.dispatch(control('cancel', 'cancel'), llm)
    assert.equal(f.calls[0].signal.aborted, true)
    await waitFor(() => f.calls.length === 2)
    assert.equal(f.facts[0].status, 'cancelled')
    f.calls[1].resolve(done())
    await waitFor(() => f.facts.length === 2)
    assert.equal(f.facts[1].inputId, 'queued')
  } finally { await f.close() }
})

test('stopped history sleeps without model-driven compaction or losing explicit recovery', async () => {
  let compactions = 0
  const f = await fixture({
    sleepInactivityMs: 5,
    handoff: {
      shouldHandoff: () => true,
      create: async () => { compactions++; return { timestamp: new Date().toISOString(), prompt: 'Unexpected compaction' } },
    } as unknown as HandoffManager,
  })
  try {
    f.session.dispatch(input('first'), llm)
    await waitFor(() => f.calls.length === 1)
    f.session.cancel()
    await waitFor(() => !f.session.accepting)
    await f.session.completion
    assert.equal(compactions, 0)
    assert.equal(f.calls.length, 1)
    assert.equal((await f.store.getState(f.state.sessionId))?.recovery?.reason, 'stopped')
  } finally { await f.close() }
})

for (const phase of ['provider', 'tool'] as const) {
  test(`HTTP cancellation aborts the current ${phase} signal, retaining queued inputs and unrelated sessions`, async () => {
    const f = await fixture()
    const tool = Promise.withResolvers<string>()
    let toolSignal: AbortSignal | undefined
    let unrelatedCancellations = 0
    f.tools.register({
      name: 'fixture_cancel', description: '', parameters: { type: 'object', properties: {} },
      execute: async (_args, ctx) => { toolSignal = ctx.signal; return tool.promise },
    })
    const app = new Hono()
    sessionsApiPlugin({
      getSessionState: (id: string) => id === f.state.sessionId ? f.state : undefined,
      listSessions: async () => [f.state],
      yields: { get: () => null },
      getActiveSession: (id: string) => id === f.state.sessionId ? f.session : { cancel: () => { unrelatedCancellations++ } },
    } as unknown as SessionManager)(app)
    try {
      f.session.dispatch({ ...input('first'), replyTo: { channel: 'web', chatId: 'fixture', platformMessageId: 'request-first' } }, llm)
      await waitFor(() => f.calls.length === 1)
      if (phase === 'tool') {
        f.calls[0].resolve({ content: null, toolCalls: [{ id: 'cancel-tool', name: 'fixture_cancel', arguments: {} }] })
        await waitFor(() => !!toolSignal)
      }
      f.session.dispatch(input('queued'), llm)
      const activity = await (await app.request('/api/sessions/stages')).json()
      const restoredRequestId = activity.activeRequestIds[f.state.sessionId]
      assert.equal(restoredRequestId, 'request-first')
      const response = await app.request(`/api/sessions/${encodeURIComponent(f.state.sessionId)}/cancel`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: restoredRequestId }),
      })
      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), { sessionId: f.state.sessionId, status: 'requested' })
      assert.equal((phase === 'tool' ? toolSignal! : f.calls[0].signal).aborted, true)
      if (phase === 'tool') {
        // Acknowledgement does not pretend that a non-cooperative tool stopped.
        assert.equal(f.session.phase, 'tool')
        assert.equal(f.calls.length, 1)
        tool.resolve('Tool cleanup complete')
      }
      await waitFor(() => f.calls.length === 2)
      assert.equal(f.facts[0].status, 'cancelled')
      assert.equal(f.calls[1].signal.aborted, false)
      const stale = await app.request(`/api/sessions/${encodeURIComponent(f.state.sessionId)}/cancel`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: restoredRequestId }),
      })
      assert.equal(stale.status, 409)
      assert.equal(f.calls[1].signal.aborted, false)
      const successor = await (await app.request('/api/sessions/stages')).json()
      assert.equal(successor.activeRequestIds[f.state.sessionId], 'queued')
      f.calls[1].resolve(done())
      await waitFor(() => f.facts.length === 2)
      assert.equal(f.facts[1].inputId, 'queued')
      assert.equal(unrelatedCancellations, 0)
    } finally { tool.resolve('cleanup'); await f.close() }
  })
}

test('stop aborts active provider and classifier; inbox listeners are released', async () => {
  const f = await fixture({ quickModel: 'quick' })
  const tool = Promise.withResolvers<string>()
  f.tools.register({
    name: 'fixture_wait', description: '', parameters: { type: 'object', properties: {} },
    execute: async () => tool.promise,
  })
  try {
    f.session.dispatch(input('first'), llm)
    await waitFor(() => f.calls.length === 1)
    f.calls[0].resolve({ content: null, toolCalls: [{ id: 'tool-1', name: 'fixture_wait', arguments: {} }] })
    await waitFor(() => f.session.phase === 'tool')
    ;(f.session as any).turn.toolStartedAt = Date.now() - 21_000
    f.session.dispatch(input('interactive', 'interactive'), llm)
    await waitFor(() => f.calls.length === 2)
    assert.equal(f.calls[1].model, 'quick')
    f.session.stop()
    assert.equal(f.calls[0].signal.aborted, true)
    assert.equal(f.calls[1].signal.aborted, true)
    tool.resolve('Stopped')
    await f.session.completion
    assert.equal(f.facts.length, 1)
    assert.equal(f.facts[0].status, 'cancelled')
    assert.equal(f.calls.length, 2)
    assert.equal(getEventListeners((f.session as any).stopController.signal, 'abort').length, 0)
  } finally { tool.resolve('cleanup'); await f.close() }
})

test('idle inbox does not accumulate abort listeners', async () => {
  const f = await fixture()
  try {
    for (let i = 0; i < 15; i++) {
      f.session.dispatch(input(`silent-${i}`, 'silent'), llm)
      await waitFor(() => f.session.history.length === i + 1 && f.session.phase === 'idle')
      assert.equal(getEventListeners((f.session as any).stopController.signal, 'abort').length, 1)
    }
    f.session.stop()
    await f.session.completion
    assert.equal(getEventListeners((f.session as any).stopController.signal, 'abort').length, 0)
  } finally { await f.close() }
})

for (const ephemeral of [false]) {
  test(`${ephemeral ? 'ephemeral' : 'persistent'} concurrent admission is ordered, nonblocking, and shares one session`, async () => {
    const f = await fixture({ manager: true, ephemeral })
    try {
      const receipts = await Promise.all([
        f.manager.deliver(f.state.sessionId, input('first')),
        f.manager.deliver(f.state.sessionId, input('second')),
        f.manager.deliver(f.state.sessionId, input('third')),
      ])
      assert.deepEqual(receipts.map((r) => r.inputId), ['first', 'second', 'third'])
      assert.deepEqual(f.accepted, ['first', 'second', 'third'])
      assert.equal(f.preparations(), 1)
      assert.equal(f.ended.length, 0)
      for (let i = 0; i < 3; i++) {
        await waitFor(() => f.calls.length === i + 1)
        assert.equal(f.calls[i].model, 'fixture')
        assert.match(JSON.stringify(f.calls[i].messages.filter(message => message.name !== 'runtime-context').at(-1)?.content), new RegExp(receipts[i].inputId))
        f.calls[i].resolve(done())
        await waitFor(() => f.facts.length === i + 1)
      }
      if (ephemeral) await waitFor(() => f.ended.length === 1)
      else assert.equal(f.ended.length, 0)
      assert.deepEqual(f.facts.map((fact) => fact.inputId), ['first', 'second', 'third'])
    } finally { await f.close() }
  })
}

test('task interactive follow-up is rejected without aborting the initial execution', async () => {
  const f = await fixture({ manager: true, ephemeral: true })
  try {
    await f.manager.deliver(f.state.sessionId, input('first'))
    await waitFor(() => f.calls.length === 1)
    await assert.rejects(f.manager.deliver(f.state.sessionId, input('second', 'interactive')), /does not accept subsequent inputs/)
    assert.equal(f.calls[0].signal.aborted, false)
    f.calls[0].resolve(done())
    await waitFor(() => f.ended.length === 1)
    assert.equal(f.facts.length, 1)
  } finally { await f.close() }
})

test('coordinator queues session-origin input instead of steering an authorized owner tool turn', async () => {
  const f = await fixture({ state: { sessionId: 'web:orchestrator' } })
  const gate = Promise.withResolvers<string>()
  const started = Promise.withResolvers<void>()
  const sources: Array<string | undefined> = []
  f.tools.register({
    name: 'fixture_wait', description: '', parameters: { type: 'object', properties: {} },
    execute: async (_args, context) => {
      sources.push(context.inputSource)
      started.resolve()
      return gate.promise
    },
  })
  try {
    f.session.dispatch({
      ...input('owner', 'interactive'),
      source: { kind: 'user', sender: { channel: 'web', chatId: 'orchestrator', senderId: 'owner', messageId: 'owner', admin: true } },
    }, llm)
    await waitFor(() => f.calls.length === 1)
    f.calls[0].resolve({ content: null, toolCalls: [{ id: 'owner-tool', name: 'fixture_wait', arguments: {} }] })
    await started.promise
    f.session.dispatch({
      ...input('external-request', 'interactive'),
      source: { kind: 'session', sessionId: 'web:worker' },
    }, llm)
    gate.resolve('Owner operation finished')
    await waitFor(() => f.calls.length === 2)
    assert(!JSON.stringify(f.calls[1].messages).includes('external-request'))
    f.calls[1].resolve(done())
    await waitFor(() => f.calls.length === 3)
    assert(JSON.stringify(f.calls[2].messages).includes('external-request'))
    f.calls[2].resolve({ content: null, toolCalls: [{ id: 'worker-tool', name: 'fixture_wait', arguments: {} }] })
    await waitFor(() => f.calls.length === 4)
    assert.deepEqual(sources, ['user', 'session'])
    f.calls[3].resolve(done())
    await waitFor(() => f.facts.length === 2)
  } finally {
    gate.resolve('cleanup')
    await f.close()
  }
})

test('report_to observes domain facts once, not outbound done, and reports failures', async () => {
  const f = await fixture({ manager: true, state: { reportTo: 'parent', agentType: 'fixture' } })
  try {
    f.bus.emit('message.outbound', { channel: 'test', chatId: 'queue', content: 'Not a completion', done: true, event: 'response' })
    assert.equal(f.reports.length, 0)
    await f.manager.deliver(f.state.sessionId, input('first'))
    await waitFor(() => f.calls.length === 1)
    f.calls[0].resolve(done('Actual completion'))
    await waitFor(() => f.reports.length === 1)
    assert.equal(f.reports[0].type, 'subagent-complete')
    assert.equal(f.reports[0].content, 'Actual completion')
    assert.equal(f.reports[0].targetSessionId, 'parent')
    assert.deepEqual(f.reports[0].meta, { kind: 'subagent', sourceSessionId: 'test:queue', agentType: 'fixture' })
    assert.deepEqual(f.reports[0].origin, {
      sessionId: 'test:queue', inputId: 'first',
      source: { kind: 'session', sessionId: 'test:queue' },
    })
    await f.manager.deliver(f.state.sessionId, input('failure'))
    await waitFor(() => f.calls.length === 2)
    f.calls[1].reject(new Error('Failed operation'))
    await waitFor(() => f.reports.length === 2)
    assert.equal(f.reports[1].type, 'subagent-failed')
    assert.equal(f.reports[1].content, 'Failed operation')
    assert.equal(f.reports[1].origin.inputId, 'failure')
    await f.manager.deliver(f.state.sessionId, input('empty'))
    await waitFor(() => f.calls.length === 3)
    f.calls[2].resolve(done(''))
    await waitFor(() => f.facts.length === 3)
    assert.equal(f.reports.length, 2)
    f.state.reportTo = f.state.sessionId
    f.manager.getSessionState(f.state.sessionId)!.reportTo = f.state.sessionId
    await f.manager.deliver(f.state.sessionId, input('self'))
    await waitFor(() => f.calls.length === 4)
    f.calls[3].resolve(done())
    await waitFor(() => f.facts.length === 4)
    assert.equal(f.reports.length, 2)
  } finally { await f.close() }
})

test('unavailable workdir fails before provider and still emits a failed domain fact', async () => {
  const f = await fixture({
    state: { workdir: { version: 1, nodeId: 'missing', capabilityId: 'missing' } },
  })
  try {
    f.session.dispatch(input('unavailable'), llm)
    await waitFor(() => f.facts.length === 1)
    assert.equal(f.calls.length, 0)
    assert.equal(f.facts[0].status, 'failed')
    assert.match(f.facts[0].error!, /workdir unavailable/)
    assert.match(f.outbound[0], /Request failed/)
  } finally { await f.close() }
})

test('ephemeral unsupported compaction rejects admission without aborting accepted work', async () => {
  const f = await fixture({ manager: true, ephemeral: true })
  try {
    await assert.rejects(
      f.manager.deliver(f.state.sessionId, control('unsupported', 'compact')),
      /Compaction is not supported for ephemeral session/,
    )
    assert.equal(f.accepted.length, 0)
    assert.equal(f.calls.length, 0)
    assert.equal(f.facts.length, 0)
    assert.equal(f.manager.getActiveSession(f.state.sessionId), undefined)
    await f.manager.deliver(f.state.sessionId, input('task'))
    await waitFor(() => f.calls.length === 1)
    const active = f.manager.getActiveSession(f.state.sessionId)!
    assert.throws(() => active.requestCompact(llm), /Compaction is not supported/)
    assert.equal(f.manager.requestCompact(f.state.sessionId, llm), false)
    await assert.rejects(
      f.manager.deliver(f.state.sessionId, control('unsupported-again', 'compact')),
      /does not accept subsequent inputs/,
    )
    assert.equal(f.calls[0].signal.aborted, false)
    assert.deepEqual(f.accepted, ['task'])
    f.calls[0].resolve(done())
    await waitFor(() => f.facts.length === 1)
  } finally { await f.close() }
})

test('ephemeral pre-provider failure emits accepted before finished and ended', async () => {
  const f = await fixture({
    manager: true,
    ephemeral: true,
    state: { workdir: { version: 1, nodeId: 'missing', capabilityId: 'missing' } },
  })
  const order: string[] = []
  f.bus.on('session.input.accepted', () => { order.push('accepted') })
  f.bus.on('session.turn.finished', () => { order.push('finished') })
  f.bus.on('session.ended', () => { order.push('ended') })
  try {
    await f.manager.deliver(f.state.sessionId, input('unavailable'))
    await waitFor(() => order.length === 3)
    assert.deepEqual(order, ['accepted', 'finished', 'ended'])
    assert.equal(f.facts[0].status, 'failed')
    assert.equal(f.calls.length, 0)
  } finally { await f.close() }
})

for (const outcome of ['content', 'empty', 'null', 'failure', 'cancel'] as const) {
  test(`${outcome}: terminal outbound cleanup occurs once without changing the turn fact`, async () => {
    const f = await fixture()
    try {
      f.session.dispatch({
        ...input('request'),
        replyTo: { channel: 'test', chatId: 'queue', platformMessageId: 'request-1' },
      }, llm)
      await waitFor(() => f.calls.length === 1)
      if (outcome === 'failure') f.calls[0].reject(new Error('Provider failed'))
      else if (outcome === 'cancel') f.session.dispatch(control('cancel', 'cancel'), llm)
      else f.calls[0].resolve({
        content: outcome === 'null' ? null : outcome === 'empty' ? '' : 'Real result',
        toolCalls: [],
      })
      await waitFor(() => f.facts.length === 1)
      const terminal = f.outboundMessages.filter((message) => message.done)
      assert.equal(terminal.length, 1)
      assert.equal(terminal[0].replyTo, 'request-1')
      assert.equal(terminal[0].event, 'response')
      assert.equal(f.facts[0].status,
        outcome === 'cancel' ? 'cancelled' : outcome === 'failure' ? 'failed' : 'completed')
      if (outcome === 'failure') assert.match(terminal[0].content, /Request failed: Provider failed/)
      else assert.equal(terminal[0].content, outcome === 'content' ? 'Real result' : '')
      if (outcome !== 'content') assert.equal(f.facts[0].content, '')
    } finally { await f.close() }
  })
}

test('task executions reject message-tool admissions and subsequent direct events', async () => {
  const f = await fixture({ manager: true, ephemeral: true, state: { agentType: 'fixture' } })
  try {
    assert.equal(f.manager.canReceiveSessionMessage(f.state.sessionId), false)
    const receipt = f.manager.deliver(f.state.sessionId, input('initial-task'))
    assert.equal(f.manager.canReceiveSessionMessage(f.state.sessionId), false)
    await receipt
    await waitFor(() => f.calls.length === 1)
    assert.equal(f.manager.canReceiveSessionMessage(f.state.sessionId), false)
    f.calls[0].resolve(done())
    await waitFor(() => f.ended.length === 1)
    assert.equal(f.manager.canReceiveSessionMessage(f.state.sessionId), false)
    await assert.rejects(f.manager.deliver(f.state.sessionId, input('direct-event')), /does not accept subsequent inputs/)
    assert.equal(f.manager.canReceiveSessionMessage('test:ordinary'), true)
  } finally { await f.close() }
})

for (const storage of ['jsonl', 'sqlite'] as const) {
  for (const responseKind of ['final', 'tool']) test(`${storage}: parent correction during ${responseKind} task inference is applied without restarting or admitting a second assignment`, async () => {
    const f = await fixture({ manager: true, ephemeral: true, storage,
      state: { agentType: 'fixture', parentSessionId: 'test:parent' } })
    try {
      await f.manager.buildSession('test:parent', undefined, { mode: 'session', agentType: 'fixture' })
      await f.manager.deliver(f.state.sessionId, input('initial-task'))
      await waitFor(() => f.calls.length === 1)
      const correction: SessionMessageInput = { ...input('correction', 'next-step'),
        source: { kind: 'session', sessionId: 'test:parent' }, content: 'Use the corrected API contract.' }
      assert.equal(f.manager.canReceiveSessionMessage(f.state.sessionId, 'test:parent'), true)
      assert.equal(f.manager.canReceiveSessionMessage(f.state.sessionId, 'test:other'), false)
      await assert.rejects(f.manager.deliver(f.state.sessionId, { ...correction, source: { kind: 'session', sessionId: 'test:other' } }), /does not accept/)
      await assert.rejects(f.manager.deliver(f.state.sessionId, { ...correction, policy: 'queue' }), /does not accept/)
      const receipt = await f.manager.deliver(f.state.sessionId, correction)
      assert.equal(receipt.delivery, 'next-step')
      assert.equal(f.calls[0].signal.aborted, false)
      f.calls[0].resolve(responseKind === 'final' ? done('Obsolete draft') : {
        content: '', toolCalls: [{ id: 'obsolete-tool', name: 'obsolete-write', arguments: {} }],
      })
      await waitFor(() => f.calls.length === 2)
      assert.equal(f.facts.length, 0)
      assert.match(JSON.stringify(f.calls[1].messages), /corrected API contract/)
      if (responseKind === 'tool') assert.match(String(f.calls[1].messages.find(message => message.tool_call_id === 'obsolete-tool')?.content), /Not executed/)
      f.calls[1].resolve(done('Corrected result'))
      await waitFor(() => f.facts.length === 1)
      assert.equal(f.facts[0].content, 'Corrected result')
      await assert.rejects(f.manager.deliver(f.state.sessionId, correction), /does not accept/)
      const records = []
      for await (const record of f.store.readSessionLog(SessionManager.currentPhysicalId(f.manager.getSessionState(f.state.sessionId)!))) records.push(record)
      assert(records.some(record => (record.execution_correction as { status?: string } | undefined)?.status === 'pending'))
      assert(records.some(record => (record.execution_correction as { status?: string } | undefined)?.status === 'applied'))
    } finally { await f.close() }
  })
}

const correctionTrace = JSON.parse(await readFile(new URL('./fixtures/task-correction-trace.json', import.meta.url), 'utf8')) as {
  source: { sessionId: string; inputId: string; toolCallId: string }
  tool: string
  args: { sessionId: string; content: string; intent: string; silent: boolean }
  observed: { result: string; statusAfterFailure: string; ownerSessionId: string }
}

for (const storage of ['jsonl', 'sqlite'] as const) {
  for (const responseKind of ['final', 'tool'] as const) test(`${storage}: inspect trace eval applies the original silent:false correction during ${responseKind} inference`, async () => {
    const { source, args, observed } = correctionTrace
    assert.match(observed.result, /does not accept subsequent inputs/)
    assert.equal(observed.statusAfterFailure, 'running')
    assert.equal(observed.ownerSessionId, source.sessionId)
    const f = await fixture({ manager: true, ephemeral: true, storage,
      state: { sessionId: args.sessionId, agentType: 'fixture', parentSessionId: source.sessionId } })
    try {
      await f.manager.buildSession(source.sessionId, undefined, { mode: 'session', agentType: 'fixture' })
      f.tools.register(new MessageTool(f.bus,
        (id, sender) => f.manager.canReceiveSessionMessage(id, sender),
        id => f.manager.getSessionState(id)?.parent,
        () => [args.sessionId], (id, input) => f.manager.deliver(id, input),
        (sender, id) => f.manager.canSendSessionMessage(sender, id)))
      let obsoleteEffects = 0
      f.tools.register({ name: 'obsolete-write', description: 'Must not run after correction',
        parameters: { type: 'object', properties: {} }, execute: async () => { obsoleteEffects++; return 'unexpected effect' } })
      await f.manager.deliver(args.sessionId, input('initial-readonly-inspection'))
      await waitFor(() => f.calls.length === 1)
      const context: ExecutionContext = {
        sessionId: source.sessionId, physicalSessionId: 'fixture-parent',
        channel: 'web', chatId: source.sessionId.slice(4), senderId: 'fixture',
        messageId: source.inputId, signal: new AbortController().signal,
        tools: new SessionTools(f.tools, f.workspace),
      }
      // Exact captured arguments through the real registry, tool and manager, not
      // a synthetic successful message receipt or a hand-constructed next-step input.
      const receipt = await f.tools.execute(correctionTrace.tool, structuredClone(args), context)
      assert.equal(typeof receipt, 'string')
      assert.match(receipt as string, /Message sent.*delivery=next-step.*not yet applied/)
      assert.equal(f.calls[0].signal.aborted, false)
      assert.equal(f.facts.length, 0)
      f.calls[0].resolve(responseKind === 'final' ? done('Obsolete broad audit') : {
        content: '', toolCalls: [{ id: 'obsolete-tool', name: 'obsolete-write', arguments: {} }],
      })
      await waitFor(() => f.calls.length === 2)
      assert.match(JSON.stringify(f.calls[1].messages), /重点返回 Worker对应源码路径和当前dirty计数即可/)
      assert.equal(obsoleteEffects, 0)
      assert.equal(f.facts.length, 0)
      f.calls[1].resolve(done('Focused source paths and dirty counts'))
      await waitFor(() => f.facts.length === 1)
      assert.equal(f.facts[0].content, 'Focused source paths and dirty counts')
      assert.equal(f.facts[0].status, 'completed')
      const records = []
      for await (const record of f.store.readSessionLog(SessionManager.currentPhysicalId(f.manager.getSessionState(args.sessionId)!))) records.push(record)
      const corrections = records.flatMap(record => record.execution_correction ? [record.execution_correction as { inputId: string; status: string }] : [])
      assert.deepEqual(corrections.map(c => c.status), ['pending', 'applied'])
      assert.equal(corrections[0].inputId, corrections[1].inputId)
      assert((receipt as string).includes(`inputId=${corrections[0].inputId}`))
      const afterCompletion = await f.tools.execute(correctionTrace.tool, structuredClone(args), context)
      assert.match(afterCompletion as string, /^Error:/)
      assert.equal(f.calls.length, 2, 'terminal tasks must not restart')
    } finally { await f.close() }
  })

  test(`${storage}: inspect trace negative controls preserve ownership, explicit queue and terminal boundaries`, async () => {
    const { source, args } = correctionTrace
    const f = await fixture({ manager: true, ephemeral: true, storage,
      state: { sessionId: args.sessionId, agentType: 'fixture', parentSessionId: source.sessionId } })
    try {
      await f.manager.buildSession(source.sessionId, undefined, { mode: 'session', agentType: 'fixture' })
      await f.manager.deliver(args.sessionId, input('initial-task'))
      await waitFor(() => f.calls.length === 1)
      const message = new MessageTool(f.bus,
        (id, sender) => f.manager.canReceiveSessionMessage(id, sender),
        () => undefined, () => [args.sessionId], (id, value) => f.manager.deliver(id, value),
        (sender, id) => f.manager.canSendSessionMessage(sender, id))
      const context: ExecutionContext = { sessionId: source.sessionId, physicalSessionId: 'fixture-parent',
        channel: 'web', chatId: 'parent', senderId: 'fixture', messageId: source.inputId,
        signal: new AbortController().signal, tools: new SessionTools(f.tools, f.workspace) }
      const { silent: _legacy, ...explicit } = args
      await assert.rejects(message.execute({ ...explicit, delivery: 'queue' }, context), /\[delivery_not_supported\].*Resolved delivery=queue.*delivery="next-step"/)
      await assert.rejects(message.execute({ ...explicit, delivery: 'silent' }, context), /\[delivery_not_supported\].*Resolved delivery=silent/)
      const wrongOwner = await message.execute(args, { ...context, sessionId: 'test:other' })
      assert.match(wrongOwner, /Only the actual parent/)
      assert.equal(f.calls[0].signal.aborted, false)
      assert.deepEqual(f.accepted, ['initial-task'], 'rejections must not admit a second assignment')
      assert.equal(f.outboundMessages.filter(m => m.sessionMessage).length, 0, 'no sent projection after rejection')
      const correction: SessionMessageInput = { ...input('control', 'next-step'), content: args.content,
        source: { kind: 'session', sessionId: 'test:other' } }
      await assert.rejects(f.manager.deliver(args.sessionId, correction), /\[not_owner\]/)
      f.calls[0].resolve(done('Original task result'))
      await waitFor(() => f.facts.length === 1)
      await assert.rejects(f.manager.deliver(args.sessionId, { ...correction,
        source: { kind: 'session', sessionId: source.sessionId } }), /\[execution_closed\]/)
      assert.equal(f.calls.length, 1)
    } finally { await f.close() }
  })
}

test('failed ephemeral preparation releases the initial-task reservation', async () => {
  const f = await fixture({ manager: true, ephemeral: true, state: { agentType: 'fixture' } })
  try {
    ;(f.manager as any).deps.getLlmRuntimeConfig = undefined
    const delivery = f.manager.deliver(f.state.sessionId, input('unaccepted'))
    assert.equal(f.manager.canReceiveSessionMessage(f.state.sessionId), false)
    await assert.rejects(delivery, /requires LLM runtime configuration/)
    assert.equal(f.manager.canReceiveSessionMessage(f.state.sessionId), false)
    assert.equal(f.accepted.length, 0)
  } finally { await f.close() }
})

test('recovered ephemeral use is recognized from activity or legacy local history without migration', async () => {
  const f = await fixture({ manager: true, ephemeral: true, state: { agentType: 'fixture' } })
  let restored: SessionManager | undefined
  try {
    await f.manager.buildSession('test:used', undefined, { agentType: 'fixture' })
    const used = f.manager.getSessionState('test:used')!
    used.lastActivityAt = new Date().toISOString()
    await f.store.saveState(used.sessionId, used)
    await f.manager.buildSession('test:fresh', undefined, { agentType: 'fixture' })
    await f.store.appendMessages('test_queue-0', [{
      role: 'user', content: 'Legacy initial task', timestamp: new Date().toISOString(),
    }])
    restored = new SessionManager((f.manager as any).deps)
    await restored.start()
    assert.equal(restored.canReceiveSessionMessage('test:used'), false)
    assert.equal(restored.canReceiveSessionMessage(f.state.sessionId), false)
    assert.equal(restored.canReceiveSessionMessage('test:fresh'), false)
  } finally { await restored?.stop(); await f.close() }
})

for (const ephemeral of [false, true]) {
  test(`${ephemeral ? 'ephemeral' : 'persistent'} manager shutdown aborts immediately and awaits final projections`, async () => {
    const f = await fixture({ manager: true, ephemeral })
    const tool = Promise.withResolvers<string>()
    f.tools.register({
      name: 'fixture_wait', description: '', parameters: { type: 'object', properties: {} },
      execute: async () => tool.promise,
    })
    try {
      await f.manager.deliver(f.state.sessionId, input('first'))
      await waitFor(() => f.calls.length === 1)
      f.calls[0].resolve({ content: null, toolCalls: [{ id: 'wait', name: 'fixture_wait', arguments: {} }] })
      await waitFor(() => f.manager.getActiveSession(f.state.sessionId)?.phase === 'tool')
      if (ephemeral) await assert.rejects(f.manager.deliver(f.state.sessionId, input('queued')), /does not accept subsequent inputs/)
      else await f.manager.deliver(f.state.sessionId, input('queued'))
      const stopping = f.manager.stop()
      assert.equal(f.calls[0].signal.aborted, true)
      assert.equal(f.manager.stop(), stopping)
      let stopped = false
      void stopping.then(() => { stopped = true })
      await Promise.resolve()
      assert.equal(stopped, false)
      await assert.rejects(f.manager.deliver(f.state.sessionId, input('rejected')), /Session manager stopped/)
      tool.resolve('Tool completed during shutdown')
      await stopping
      assert.equal(f.facts.length, 1)
      assert.equal(f.facts[0].status, 'cancelled')
      assert.equal(f.outboundMessages.filter((message) => message.done).length, 1)
      assert.equal(f.calls.length, 1)
      assert.equal(f.ended.length, 1)
      assert.equal(f.manager.listActiveSessions().length, 0)
      assert.equal((f.manager as any).preparations.size, 0)
    } finally { tool.resolve('cleanup'); await f.close() }
  })
}

test('manager shutdown awaits pending preparation and refuses standalone starts without writing prototypes', async () => {
  const f = await fixture({ manager: true })
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<string>()
  ;(f.manager as any).deps.context.buildSystemPrompt = async () => {
    entered.resolve()
    return release.promise
  }
  try {
    const admission = f.manager.deliver(f.state.sessionId, input('preparing'))
    const rejected = assert.rejects(admission, /Session manager stopped/)
    await entered.promise
    const stopping = f.manager.stop()
    let stopped = false
    void stopping.then(() => { stopped = true })
    await Promise.resolve()
    assert.equal(stopped, false)
    release.resolve('Prepared after shutdown')
    await rejected
    await stopping
    assert.equal(f.calls.length, 0)
    assert.equal(f.accepted.length, 0)
    assert.equal(f.manager.listActiveSessions().length, 0)
    assert.equal((f.manager as any).preparations.size, 0)
    await assert.rejects(f.manager.startSession({
      agentType: 'fixture', task: 'Never admitted', chatId: 'never',
    }), /Session manager stopped/)
    assert.equal(f.manager.getSessionState('heartbeat:never'), null)
  } finally { release.resolve('cleanup'); await f.close() }
})

test('manager shutdown propagates lifecycle cleanup errors after stopping active work', async () => {
  const f = await fixture({ manager: true })
  try {
    ;(f.manager as any).deps.onSessionStopped = () => { throw new Error('Cleanup failed') }
    await f.manager.deliver(f.state.sessionId, input('first'))
    await waitFor(() => f.calls.length === 1)
    await assert.rejects(f.manager.stop(), (error: unknown) => {
      assert(error instanceof AggregateError)
      assert.equal(error.errors.length, 1)
      assert.match(String(error.errors[0]), /Cleanup failed/)
      return true
    })
    assert.equal(f.facts[0].status, 'cancelled')
    assert.equal(f.manager.listActiveSessions().length, 0)
  } finally {
    await assert.rejects(f.close(), /Session shutdown failed/)
  }
})

describe('session lifecycle edge cases', () => {
  for (const intent of ['abort', 'steer'] as const) {
    test(`long-running tool: quickModel ${intent} preserves interactive routing`, async () => {
      const f = await fixture({ quickModel: 'quick' })
      const tool = Promise.withResolvers<string>()
      f.tools.register({
        name: 'fixture_wait', description: '', parameters: { type: 'object', properties: {} },
        execute: async () => tool.promise,
      })
      try {
        f.session.dispatch(input('first'), llm)
        await waitFor(() => f.calls.length === 1)
        f.calls[0].resolve({ content: null, toolCalls: [{ id: 'wait', name: 'fixture_wait', arguments: {} }] })
        await waitFor(() => f.session.phase === 'tool')
        ;(f.session as any).turn.toolStartedAt = Date.now() - 21_000
        f.session.dispatch(input('next', 'interactive'), llm)
        await waitFor(() => f.calls.length === 2)
        assert.equal(f.calls[1].model, 'quick')
        f.calls[1].resolve(done(intent))
        await waitFor(() => intent === 'abort'
          ? f.calls[0].signal.aborted
          : (f.session as any).turn.steerQueue.length === 1)
        assert.equal(f.calls[0].signal.aborted, intent === 'abort')
        tool.resolve('tool finished')
        await waitFor(() => f.calls.length === 3)
        assert(JSON.stringify(f.calls[2].messages.filter(message => message.name !== 'runtime-context').at(-1)?.content).includes('next'))
        f.calls[2].resolve(done())
        await waitFor(() => f.facts.length === (intent === 'abort' ? 2 : 1))
        assert.deepEqual(f.facts.map((fact) => fact.status),
          intent === 'abort' ? ['cancelled', 'completed'] : ['completed'])
      } finally { tool.resolve('cleanup'); await f.close() }
    })
  }

  test('silent input bypasses automatic hot compaction; compact control never becomes a prompt', async () => {
    let compactions = 0
    const f = await fixture({
      handoff: {
        shouldHandoff: () => true,
        create: async () => {
          compactions++
          return { timestamp: new Date().toISOString(), prompt: 'Compacted' }
        },
      } as unknown as HandoffManager,
    })
    try {
      ;(f.session as any).usage = { promptTokens: 100, completionTokens: 0, totalTokens: 100 }
      f.session.dispatch(input('silent', 'silent'), llm)
      await waitFor(() => f.session.history.length === 1 && f.session.phase === 'idle')
      assert.equal(compactions, 0)
      assert.equal(f.calls.length, 0)
      assert.equal(f.facts.length, 0)
      f.session.dispatch(control('compact', 'compact'), llm)
      await waitFor(() => f.session.getState().segmentIndex === 1)
      assert.equal(compactions, 1)
      assert.equal(f.calls.length, 0)
      assert.equal(f.facts.length, 0)
      assert.equal(f.session.history.length, 1)
      assert.equal(f.session.history[0].content, 'Compacted')
    } finally { await f.close() }
  })

  test('retry with no history reports failure or appends fallback once without duplicating prompts', async () => {
    const f = await fixture()
    try {
      f.session.dispatch(control('empty-retry', 'retry'), llm)
      await waitFor(() => f.facts.length === 1 && f.session.phase === 'idle')
      assert.equal(f.calls.length, 0)
      assert.equal(f.facts[0].status, 'failed')
      assert.match(f.facts[0].error!, /Nothing to retry/)
      assert.equal(f.outboundMessages.filter((message) => message.done).length, 1)
      assert.match(f.outbound[0], /Nothing to retry/)
      f.session.dispatch({
        ...input('retry'), kind: 'control',
        command: { type: 'retry', fallbackContent: 'Recovered original prompt' },
      }, llm)
      await waitFor(() => f.calls.length === 1)
      assert.equal(f.calls[0].messages.filter(message => message.role !== 'system' && message.name !== 'runtime-context').length, 1)
      assert.match(JSON.stringify(f.calls[0].messages.find(message => message.role === 'user')?.content), /Recovered original prompt/)
      f.calls[0].resolve(done())
      await waitFor(() => f.facts.length === 2)
    } finally { await f.close() }
  })

  test('standalone start delivers a queue event but recovery only marks history for explicit continuation', async () => {
    const f = await fixture({ manager: true })
    let inbound = 0
    f.bus.on('message.inbound', () => { inbound++ })
    const accepted: SessionInput[] = []
    f.bus.on('session.input.accepted', ({ input }) => { accepted.push(input) })
    try {
      const sessionId = await f.manager.startSession({ agentType: 'fixture', task: 'Standalone', chatId: 'started' })
      assert.equal(sessionId, 'heartbeat:started')
      assert.equal(accepted[0].source.kind, 'event')
      assert(accepted[0].source.kind === 'event')
      assert.deepEqual(accepted[0].source.origin, {
        sessionId,
        inputId: accepted[0].id,
        source: { kind: 'session', sessionId },
      })
      assert(accepted[0].kind === 'message' && accepted[0].policy === 'queue')
      assert.equal(inbound, 0)
      await waitFor(() => f.calls.length === 1)
      f.calls[0].resolve(done())
      await waitFor(() => f.facts.length === 1)
      f.manager.getSessionState(f.state.sessionId)!.lastActivityAt = new Date().toISOString()
      await f.store.appendMessages('test_queue-0', [{
        role: 'user', content: 'Interrupted request', timestamp: new Date().toISOString(),
      }])
      await f.manager.recoverIncompleteSessions()
      assert.equal(f.reports.length, 0)
      assert.equal(f.calls.length, 1)
      assert.equal(f.manager.getSessionRecovery(f.state.sessionId)?.reason, 'interrupted')
      const records = await Array.fromAsync(f.store.readSessionLog('test_queue-0'))
      assert.equal(records.at(-1)?.role, 'user')
      assert.equal(inbound, 0)
      const active = f.manager.getActiveSession(sessionId!)!
      active.stop()
      await active.completion
    } finally { await f.close() }
  })

  test('stop before a resumed inbox waiter runs cannot start another model turn', async () => {
    const f = await fixture()
    try {
      f.session.dispatch(input('not-started'), llm)
      f.session.stop()
      await f.session.completion
      assert.equal(f.calls.length, 0)
      assert.equal(f.facts.length, 0)
      assert.equal(getEventListeners((f.session as any).stopController.signal, 'abort').length, 0)
    } finally { await f.close() }
  })

  test('cancel on an idle session preserves the sleep lifecycle', async () => {
    const f = await fixture({ sleepInactivityMs: 5 })
    try {
      f.session.dispatch(control('idle-cancel', 'cancel'), llm)
      await waitFor(() => !f.session.accepting)
      await f.session.completion
      assert.equal(f.calls.length, 0)
      assert.equal(f.facts.length, 0)
    } finally { await f.close() }
  })

  test('cancel during a sequential tool group pairs skipped results before queued input runs', async () => {
    const f = await fixture()
    const tool = Promise.withResolvers<string>()
    let executions = 0
    f.tools.register({
      name: 'fixture_wait', description: '', parameters: { type: 'object', properties: {} },
      execute: async () => { executions++; return tool.promise },
    })
    f.tools.register({
      name: 'fixture_read', description: '', parameters: { type: 'object', properties: {} }, readonly: true,
      execute: async () => { executions++; return 'Should not execute' },
    })
    try {
      f.session.dispatch(input('first'), llm)
      await waitFor(() => f.calls.length === 1)
      f.calls[0].resolve({
        content: null,
        toolCalls: [
          { id: 'wait-1', name: 'fixture_wait', arguments: {} },
          { id: 'wait-2', name: 'fixture_read', arguments: {} },
        ],
      })
      await waitFor(() => executions > 0)
      f.session.dispatch(input('next'), llm)
      f.session.dispatch(control('cancel', 'cancel'), llm)
      tool.resolve('finished first tool')
      await waitFor(() => f.calls.length === 2)
      assert.equal(f.facts[0].status, 'cancelled')
      const results = f.calls[1].messages.filter((m) => m.role === 'tool')
      assert.deepEqual(results.map((m) => m.tool_call_id), ['wait-1', 'wait-2'])
      assert.equal(executions, 1)
      assert.equal(results[1].content, 'Tool execution cancelled.')
      f.calls[1].resolve(done())
      await waitFor(() => f.facts.length === 2)
    } finally { tool.resolve('cleanup'); await f.close() }
  })
  test('input admitted during sleep compaction is processed before lifetime ends', async () => {
    const compacting = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const f = await fixture({
      sleepInactivityMs: 5,
      state: { lastKnownTokens: 100 },
      handoff: {
        shouldHandoff: (_usage: unknown, hot: boolean) => !hot,
        create: async () => {
          compacting.resolve()
          await release.promise
          return { timestamp: new Date().toISOString(), prompt: 'Compacted fixture' }
        },
      } as unknown as HandoffManager,
    })
    try {
      f.session.dispatch(input('first'), llm)
      await waitFor(() => f.calls.length === 1)
      f.calls[0].resolve(done())
      await compacting.promise
      f.session.dispatch(input('wake'), llm)
      release.resolve()
      await waitFor(() => f.calls.length === 2)
      assert.equal(f.session.accepting, true)
      assert.match(JSON.stringify(f.calls[1].messages.filter(message => message.name !== 'runtime-context').at(-1)?.content), /wake/)
      f.calls[1].resolve(done())
      await waitFor(() => f.facts.length === 2)
      assert.equal(f.facts[1].inputId, 'wake')
    } finally { release.resolve(); await f.close() }
  })
})

for (const storage of ['jsonl', 'sqlite'] as const) {
  test(`${storage}: mixed response text is emitted before either ordered tool finishes`, async () => {
    const f = await fixture({ storage })
    const held = Promise.withResolvers<string>()
    const started: number[] = []
    f.tools.register({
      name: 'fixture_ordered', description: '', parameters: { type: 'object', properties: {} },
      execute: async args => { started.push(Number(args.index)); return args.index === 1 ? held.promise : 'second result' },
    })
    try {
      f.session.dispatch(input('mixed'), llm)
      await waitFor(() => f.calls.length === 1)
      f.calls[0].resolve({ content: 'Third output text', toolCalls: [
        { id: 'first', name: 'fixture_ordered', arguments: { index: 1 } },
        { id: 'second', name: 'fixture_ordered', arguments: { index: 2 } },
      ], providerState: { provider: 'copilot', model: 'fixture', reasoning: [], outputItems: [
        { type: 'function_call', call_id: 'first', name: 'fixture_ordered', arguments: '{"index":1}' },
        { type: 'function_call', call_id: 'second', name: 'fixture_ordered', arguments: '{"index":2}' },
        { type: 'message', id: 'text-third', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Third output text', annotations: [] }] },
      ] } })
      await waitFor(() => started.length === 1)
      assert.equal(f.outboundMessages[0].event, 'response')
      assert.equal(f.outboundMessages[0].content, 'Third output text')
      assert.equal(f.outboundMessages[0].done, false)
      assert.equal(f.outboundMessages.some(message => message.event === 'tool_result'), false)
      assert.deepEqual(started, [1], 'side-effecting tools stay ordered')
      held.resolve('first result')
      await waitFor(() => f.calls.length === 2)
      assert.deepEqual(started, [1, 2])
      assert.deepEqual(f.outboundMessages.filter(message => message.event === 'tool_result').map(message => message.toolCallId), ['first', 'second'])
      const history = await Array.fromAsync(f.store.readSessionLog(f.session.physicalSessionId))
      assert.deepEqual(history.filter(message => message.role === 'tool').map(message => message.tool_call_id), ['first', 'second'])
      assert.equal((history.find(message => message.role === 'assistant')?.provider_state as ChatMessage['provider_state'])?.outputItems?.[2].type, 'message')
      f.calls[1].resolve(done())
      await waitFor(() => f.facts.length === 1)
    } finally { held.resolve('cleanup'); await f.close() }
  })
}

test('automatic rate-limit waiting stays in the same turn, rejects duplicate Continue and cancels promptly', async () => {
  const f = await fixture()
  let calls = 0
  const waits: Array<RateLimitWait | undefined> = []
  f.bus.on('session.provider.waiting', ({ wait }) => waits.push(wait))
  f.provider.chat = async (_messages, _tools, options) => withProviderRetry(async () => {
    calls++
    throw new ProviderHttpError(429, 'rate limited', '', { rejectedRequest: true, retryAfter: '30' })
  }, options.signal, { provider: 'agnes', model: options.model })
  try {
    f.session.dispatch(userInput('rate-limited-input'), llm)
    await waitFor(() => !!f.session.rateLimitWait)
    assert.equal(f.session.phase, 'llm')
    assert.equal(f.session.activeRequestId, 'rate-limited-input')
    assert.throws(() => f.session.dispatch(control('duplicate', 'retry'), llm), /automatically waiting/)
    assert.equal(calls, 1)
    f.session.dispatch(control('stop', 'cancel'), llm)
    await waitFor(() => f.facts.length === 1)
    assert.equal(f.facts[0].status, 'cancelled')
    assert.equal(calls, 1)
    assert.equal(f.session.rateLimitWait, undefined)
    assert.equal(waits[0]?.status, 429)
    assert.equal(waits.at(-1), undefined)
  } finally { await f.close() }
})
