import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { describe, test } from 'node:test'
import { Hono } from 'hono'
import { Bus } from '../bus/bus.ts'
import { channelSessionId, type OutboundMessage } from '../bus/events.ts'
import type { LLMProvider, LLMResponse, ChatMessage } from '../providers/provider.ts'
import type { HandoffManager } from '../handoff/manager.ts'
import { SessionTools, Tools } from '../tools/registry.ts'
import { JsonlSessionStore } from './session-store-jsonl.ts'
import type { SessionState } from './session-store.ts'
import type { SessionInput, SessionMessageInput, SessionTurnFact } from './input.ts'
import { SessionManager, type SessionManagerDeps } from './session-manager.ts'
import { Session } from './session.ts'
import { sessionsApiPlugin } from './routes.ts'

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
  ephemeral?: boolean
  manager?: boolean
  state?: Partial<SessionState>
  quickModel?: string
  sleepInactivityMs?: number
  handoff?: HandoffManager
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
  const store = new JsonlSessionStore(join(workspace, 'sessions'))
  await store.init()
  const state: SessionState = { sessionId: 'test:queue', segmentIndex: 0, mode: options.ephemeral ? 'task' : 'session', ...options.state }
  await store.saveState(state.sessionId, state)
  const reports: Array<Record<string, any>> = []
  let preparations = 0
  const handoff = options.handoff ?? { shouldHandoff: () => false } as unknown as HandoffManager
  const manager = options.manager ? new SessionManager({
    workspace, store, bus, provider, tools, handoffManager: handoff,
    getLlmRuntimeConfig: () => llm,
    quickModel: options.quickModel,
    events: { emit: async (event: Record<string, any>) => { reports.push(event) } },
    context: {
      buildSystemPrompt: async () => {
        preparations++
        return 'Fixture'
      },
    },
    agentTypes: {
      resolve: () => ({ name: 'fixture', description: '', prompt: '', defaultMode: options.ephemeral ? 'task' : 'session' }),
    },
  } as unknown as SessionManagerDeps) : undefined
  await manager?.start()
  const session = manager ? undefined : new Session(
    workspace, state.sessionId, state, [], provider, new SessionTools(tools, workspace), bus, store,
    handoff, () => {}, undefined, options.quickModel, options.sleepInactivityMs,
  )
  return {
    bus, facts, calls, tools, store, state, session: session!, manager: manager!,
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
        await rm(workspace, { recursive: true, force: true })
      }
    },
  }
}

for (const outcome of ['tools', 'failure', 'cancel'] as const) {
  test(`organization bot address reaches every ${outcome} outbound event`, async () => {
    const address = { organizationId: 'org-a', botInstanceId: 'bot-a', platform: 'qq', conversationId: 'shared-room' }
    const f = await fixture({ state: { sessionId: channelSessionId(address), organizationId: address.organizationId } })
    f.tools.register({
      name: 'fixture_address', description: '', parameters: { type: 'object', properties: {} },
      execute: async (_args, ctx) => {
        assert.equal(ctx.organizationId, address.organizationId)
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
      assert.equal(f.calls[1].messages.some((m) => JSON.stringify(m.content).includes('next')), steered)
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
    assert.equal(f.calls[1].messages.filter((m) => m.role === 'user').length, 2)
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
    assert.equal(f.calls[1].messages.filter((message) => message.role === 'user').length, 1)
    assert.match(JSON.stringify(f.calls[1].messages[0].content), /original/)
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
    assert.equal(f.calls[1].messages.at(-1)?.tool_call_id, 'wait')
    f.calls[1].resolve(done())
    await waitFor(() => f.calls.length === 3)
    assert.equal(f.calls[2].messages.filter((message) => message.role === 'user').length, 1)
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
        assert.match(JSON.stringify(f.calls[i].messages.at(-1)?.content), new RegExp(receipts[i].inputId))
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
        assert(JSON.stringify(f.calls[2].messages.at(-1)?.content).includes('next'))
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
      assert.equal(f.calls[0].messages.length, 1)
      assert.match(JSON.stringify(f.calls[0].messages[0].content), /Recovered original prompt/)
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
      assert.match(JSON.stringify(f.calls[1].messages.at(-1)?.content), /wake/)
      f.calls[1].resolve(done())
      await waitFor(() => f.facts.length === 2)
      assert.equal(f.facts[1].inputId, 'wake')
    } finally { release.resolve(); await f.close() }
  })
})
