import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Hono } from 'hono'
import { Bus } from '../bus/bus.ts'
import { ContextBuilder } from '../agent/context/builder.ts'
import { IdentityManager } from '../agent/identity.ts'
import { BackgroundTaskManager } from '../agent/background-task.ts'
import { AgentTypesManager } from '../agent/types/manager.ts'
import { EventService } from '../events/service.ts'
import { InitiativeStore } from '../initiatives/store.ts'
import { WorkTool } from '../tools/work.ts'
import { YieldTool } from '../tools/yield.ts'
import { Tools } from '../tools/registry.ts'
import { decisionBrief } from '../testing/decision.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import type { ChatMessage, LLMProvider, LLMResponse } from '../providers/provider.ts'
import { HandoffManager } from './handoff/manager.ts'
import { SessionManager } from './session-manager.ts'
import { JsonlSessionStore } from './session-store-jsonl.ts'
import { SqliteSessionStore } from './session-store-sqlite.ts'
import { physicalSessionId } from './session-identity.ts'
import type { SessionStore } from './session-store.ts'
import { WorkAlignment } from './work-alignment.ts'
import { sessionsApiPlugin } from './routes.ts'

const id = 'web:worker', key = 'topic:web:worker'
const llm = { model: 'fixture', contextWindow: 128_000, temperature: 0 }
const definition = { objective: 'Deliver both outcomes, not just smoke', acceptance: ['Two complete results'], boundaries: ['No publication'], evidence: [] }
const adoption = { understanding: 'Two outcomes; smoke is my first phase', stop: ['Smoke-only scope'], retain: ['Inputs'], next: ['Bounded initial run'] }
const inventory = { completed: ['Inspected inputs'], artifacts: ['new-evidence.json'], inFlight: [], unknown: [], retired: ['OLD_UNRELATED_CONTEXT'] }
const done = (): LLMResponse => ({ content: 'Finished', toolCalls: [] })
const call = (name: string, args: Record<string, unknown>, toolId: string = crypto.randomUUID()): LLMResponse =>
  ({ content: '', toolCalls: [{ id: toolId, name, arguments: args }] })
async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 5000
  while (!predicate()) { assert(Date.now() < deadline, 'Work integration timed out'); await delay(2) }
}

async function fixture(workspace: string, store: SessionStore) {
  const calls: { messages: ChatMessage[]; resolve: (value: LLMResponse) => void }[] = []
  const provider: LLMProvider = {
    name: 'fixture', listModels: () => ['fixture'],
    async chat(messages, _tools, options) {
      const pending = Promise.withResolvers<LLMResponse>()
      const signal = options!.signal!
      const abort = () => pending.reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      calls.push({ messages: structuredClone(messages), resolve: pending.resolve })
      try { signal.throwIfAborted(); return await pending.promise }
      finally { signal.removeEventListener('abort', abort) }
    },
  }
  const bus = new Bus(), tools = new Tools(workspace), context = new ContextBuilder(workspace)
  const agentTypes = new AgentTypesManager(workspace)
  await agentTypes.load()
  context.register({ name: 'fixture', getPromptSection: ctx => `Test session ${ctx.sessionId}` })
  context.register({ name: 'history', getPromptSection: () => '# Historical reference\n> Old planning notes' })
  const events = new EventService(workspace, bus, (target, input) => sessions.deliver(target, input))
  const backgroundTasks = new BackgroundTaskManager(bus, events)
  const sessions: SessionManager = new SessionManager({
    workspace, projectId: '11111111-1111-4111-8111-111111111111', store, bus, provider, agentTypes, context, tools, events, backgroundTasks,
    identity: new IdentityManager(workspace, '11111111-1111-4111-8111-111111111111'),
    handoffManager: new HandoffManager(provider, llm.contextWindow, { autoHandoff: false }, workspace, store),
    getLlmRuntimeConfig: () => llm, getYieldPolicy: () => ({ timeoutMs: null }),
  })
  await sessions.start()
  const initiatives = new InitiativeStore(workspace, { isSessionKnown: sessionId => !!sessions.getSessionState(sessionId) })
  const alignment = new WorkAlignment(initiatives, {
    state: target => sessions.getSessionState(target), evidence: source => sessions.validateWorkEvidence(source),
    changed: async () => {}, fresh: (target, record) => sessions.requestWorkContext(target, record),
    successor: async () => { throw new Error('Successor is not used by this fixture.') },
  })
  sessions.alignment = alignment
  tools.setWorkGuard(alignment)
  tools.register(new WorkTool(alignment))
  tools.register(new YieldTool(sessions.yields))
  let writes = 0
  tools.register({ name: 'fixture_write', description: '', parameters: { type: 'object', properties: {} },
    async execute() { writes++; return 'saved' } })
  const app = new Hono()
  sessionsApiPlugin(sessions)(app)
  const post = (body: unknown, path = 'work') => app.request(`/api/sessions/web%3Aworker/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  const revise = (expectedRevision: number, objective = definition.objective) => post({
    action: 'update', data: { subject: { kind: 'topic', sessionId: id }, expectedRevision,
      change: 'understanding', reason: 'Correct the work model', paused: false, definition: { ...definition, objective } },
  })
  const send = (content: string) => sessions.dispatch({
    channel: 'web', chatId: 'worker', senderId: 'owner', admin: true,
    messageId: crypto.randomUUID(), timestamp: new Date().toISOString(), content,
  }, llm)
  const quiet = () => {
    const active = sessions.getActiveSession(id)
    return !!active && 'quiescent' in active && active.quiescent
  }
  async function close() {
    await sessions.stop(); await backgroundTasks.stop(); await events.stop(); initiatives.close()
  }
  return { sessions, alignment, initiatives, calls, app, post, revise, send, quiet, close, writes: () => writes }
}

for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  test(`${Store.name}: an obsolete final answer cannot finish the revised assignment`, async () => withTempWorkspace(async workspace => {
    const store: SessionStore = new Store(join(workspace, 'sessions'))
    await store.init()
    const f = await fixture(workspace, store)
    try {
      await f.sessions.prepareCommandSession(id)
      await f.revise(0)
      await f.alignment.execute({ kind: 'session', sessionId: id }, 'adopt', key, 1, adoption)
      await f.send('Complete the assignment')
      await waitFor(() => f.calls.length === 1)
      assert.equal((await f.revise(1, 'A corrected outcome')).status, 200)
      f.calls[0].resolve(done())
      await waitFor(() => f.calls.length === 2)
      assert.equal(f.quiet(), false)
      assert.match(JSON.stringify(f.calls[1].messages), /Historical response from a superseded work agreement/)
      assert.match(String(f.calls[1].messages[0].content), /A corrected outcome/)
      for (const call of f.calls) {
        const prompt = String(call.messages[0].content)
        const current = prompt.indexOf('# Current work contracts')
        assert(current > prompt.indexOf(`Test session ${id}`))
        assert(current < prompt.indexOf('# Historical reference'))
        assert.equal(prompt.match(/# Current work contracts/g)?.length, 1)
      }
      assert.doesNotMatch(String(f.calls[1].messages[0].content), /Deliver both outcomes, not just smoke/)
      f.calls[1].resolve(done())
      await waitFor(f.quiet)
    } finally { await f.close(); store.close?.() }
  }))

  test(`${Store.name}: HTTP revision fences inference and a safe fresh segment preserves history without replaying old plans`, { timeout: 15000 }, async () => withTempWorkspace(async workspace => {
    const store: SessionStore = new Store(join(workspace, 'sessions'))
    await store.init()
    const f = await fixture(workspace, store)
    try {
      await f.sessions.prepareCommandSession(id)
      assert.equal((await f.revise(0)).status, 200)
      await f.alignment.execute({ kind: 'session', sessionId: id }, 'adopt', key, 1, adoption)
      await f.send('OLD_UNRELATED_CONTEXT from the previous plan')
      await waitFor(() => f.calls.length === 1)
      assert.equal((await f.revise(1, 'Two independent accepted outcomes')).status, 200)
      f.calls[0].resolve(call('fixture_write', {}, 'stale-write'))
      await waitFor(() => f.calls.length === 2)
      assert.equal(f.writes(), 0)
      assert.match(JSON.stringify(f.calls[1].messages), /basis changed|not adopted/)
      assert.match(String(f.calls[1].messages[0].content), /Two independent accepted outcomes/)
      f.calls[1].resolve(call('work', { action: 'adopt', key, revision: 2, data: adoption }))
      await waitFor(() => f.calls.length === 3)
      f.calls[2].resolve(call('fixture_write', {}, 'new-write'))
      await waitFor(() => f.calls.length === 4)
      assert.equal(f.writes(), 1)
      f.calls[3].resolve(done())
      await waitFor(f.quiet)
      const previous = physicalSessionId(f.sessions.getSessionState(id)!)
      await f.alignment.execute({ kind: 'session', sessionId: id }, 'checkpoint', key, 2, inventory)
      assert.equal((await f.post({ action: 'transition', key, revision: 2, data: { strategy: 'fresh' } })).status, 200)
      await waitFor(() => f.calls.length === 5)
      assert.equal(f.sessions.getSessionState(id)!.segmentIndex, 1)
      assert.equal(f.alignment.get(key).transition?.status, 'applied')
      assert.match(JSON.stringify(f.calls[4].messages), /new-evidence.json/)
      assert.doesNotMatch(JSON.stringify(f.calls[4].messages), /OLD_UNRELATED_CONTEXT from the previous plan/)
      assert.match(JSON.stringify(f.calls[4].messages), /retired.*OLD_UNRELATED_CONTEXT/)
      assert.equal(f.writes(), 1)
      f.calls[4].resolve(call('work', { action: 'adopt', key, revision: 2, data: adoption }))
      await waitFor(() => f.calls.length === 6)
      f.calls[5].resolve(done())
      await waitFor(f.quiet)
      const history: Record<string, unknown>[] = []
      for await (const event of store.readSessionLog(previous)) history.push(event)
      assert.match(JSON.stringify(history), /OLD_UNRELATED_CONTEXT from the previous plan/)
      const first = await store.readFirstRecord(physicalSessionId(f.sessions.getSessionState(id)!))
      assert.equal(first?.previous_physical_id, previous)
      assert.equal(typeof first?.work_transition_id, 'string')
      assert.equal((await f.revise(1)).status, 409)
      assert.equal((await f.post({ action: 'adopt', key, revision: 2, data: adoption })).status, 400, 'UI cannot impersonate executor adoption')
    } finally { await f.close(); store.close?.() }
  }))

  test(`${Store.name}: decisions bind to work revisions and custom text requires explicit reinterpretation`, { timeout: 15000 }, async () => withTempWorkspace(async workspace => {
    const store: SessionStore = new Store(join(workspace, 'sessions'))
    await store.init()
    const f = await fixture(workspace, store)
    try {
      await f.sessions.prepareCommandSession(id)
      await f.revise(0)
      await f.alignment.execute({ kind: 'session', sessionId: id }, 'adopt', key, 1, adoption)
      await f.send('Decide the final outcome')
      await waitFor(() => f.calls.length === 1)
      f.calls[0].resolve(call('yield', { action: 'ask', question: 'Only smoke?', options: ['Yes', 'No'], default_option: 'No', brief: decisionBrief }))
      await waitFor(() => !!f.sessions.yields.get(id)?.origin)
      const request = f.sessions.yields.get(id)!
      assert.equal(request.workStamps?.[0].revision, 1)
      assert.equal((await f.post({ requestId: request.id, customText: 'Both outcomes; smoke is not my requirement.' }, 'yield')).status, 200)
      await waitFor(() => f.calls.length === 2)
      assert.equal(f.alignment.get(key).adoption, undefined)
      const receipt = f.calls[1].messages.findLast(message => message.role === 'tool')
      assert.equal(JSON.parse(String(receipt?.content)).custom, true, 'Alignment must not corrupt structured yield receipts')
      assert.match(String(f.calls[1].messages[0].content), /Both outcomes/)
      f.calls[1].resolve(call('fixture_write', {}))
      await waitFor(() => f.calls.length === 3)
      assert.equal(f.writes(), 0)
      f.calls[2].resolve(done())
      await waitFor(f.quiet)
      const evidence = await f.sessions.decisionContext(id)
      assert(evidence.userInputs.some(input => input.id === `yield:${request.id}`))
      assert.equal((await f.revise(1, 'Both outcomes with explicit acceptance')).status, 200)
      const records = await f.sessions.getYieldRecords(id)
      assert.equal(records[0].answer?.custom, true)
      assert.match(records[0].invalidated?.reason ?? '', /task agreement changed/)
    } finally { await f.close(); store.close?.() }
  }))

  test(`${Store.name}: restart retains agreements and refuses replay of unstamped pending writes`, { timeout: 15000 }, async () => withTempWorkspace(async workspace => {
    const store: SessionStore = new Store(join(workspace, 'sessions'))
    await store.init()
    const f = await fixture(workspace, store)
    try {
      await f.sessions.prepareCommandSession(id)
      await f.revise(0)
      await f.alignment.execute({ kind: 'session', sessionId: id }, 'adopt', key, 1, adoption)
      const state = f.sessions.getSessionState(id)!
      await store.appendRawEvents(physicalSessionId(state), [
        { role: 'user', content: 'Interrupted old turn' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'pending-old-write', type: 'function',
          function: { name: 'fixture_write', arguments: '{}' } }] },
      ])
      await f.sessions.stop()
      await f.sessions.start()
      const recovery = f.sessions.getSessionRecovery(id)
      assert.ok(recovery)
      assert.equal(f.calls.length, 0, 'Startup does not run the provider or replay tools')
      await f.sessions.resumeSession(id, recovery.id)
      await waitFor(() => f.calls.length === 1)
      assert.equal(f.writes(), 0)
      assert.match(JSON.stringify(f.calls[0].messages), /not adopted|basis changed/)
      assert.equal(f.alignment.get(key).adoption?.revision, 1)
      f.calls[0].resolve(done())
      await waitFor(f.quiet)
    } finally { await f.close(); store.close?.() }
  }))
}
