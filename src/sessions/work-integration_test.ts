import { ReplyTool } from '../tools/reply.ts'
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
import { AskTool } from '../tools/ask.ts'
import { SqlTool } from '../tools/sql.ts'
import { ProjectConventions } from '../projects/conventions.ts'
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
import { YieldRecords } from './yield-records.ts'
import { WORK_APPROVE, WORK_REJECT, type WorkRecord } from '../initiatives/work-contract.ts'
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
  let notifications = false
  const alignment = new WorkAlignment(initiatives, {
    state: target => sessions.getSessionState(target), evidence: source => sessions.validateWorkEvidence(source),
    changed: async (record, previous) => { if (notifications) await sessions.notifyWorkChange(record, previous) },
    fresh: (target, record) => sessions.requestWorkContext(target, record),
    successor: async () => { throw new Error('Successor is not used by this fixture.') },
  })
  sessions.alignment = alignment
  tools.setWorkGuard(alignment)
  tools.register(new WorkTool(alignment))
  tools.register(new AskTool(sessions.yields, sessions.inputs, () => alignment))
  tools.register(new ReplyTool(sessions.yields, sessions.inputs))
  const conventions = new ProjectConventions(workspace, () => initiatives.workRecords())
  tools.register(new SqlTool(conventions, '11111111-1111-4111-8111-111111111111',
    (source, ctx) => sessions.validateConventionSource(source, ctx), () => sessions.invalidateSystemPrompts()))
  context.register({ name: 'project-conventions', getPromptSection: () => conventions.prompt() })
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
    await sessions.stop(); await backgroundTasks.stop(); await events.stop(); conventions.close(); initiatives.close()
  }
  return { sessions, alignment, initiatives, conventions, calls, app, post, revise, send, quiet, close, writes: () => writes,
    enableNotifications: () => { notifications = true } }
}

for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  test(`${Store.name}: Project SQL records direct preferences and exact decisions without creating Work`, async () => withTempWorkspace(async workspace => {
    const store: SessionStore = new Store(join(workspace, 'sessions'))
    await store.init()
    const f = await fixture(workspace, store)
    try {
      await f.send('Use pnpm')
      await waitFor(() => f.calls.length === 1)
      f.calls[0].resolve(call('ask', { action: 'context' }))
      await waitFor(() => f.calls.length === 2)
      const receipt = f.calls[1].messages.findLast(message => message.role === 'tool')!
      const { userInputs } = JSON.parse(String(receipt.content))
      assert.equal(userInputs[0].quote, 'Use pnpm')
      f.calls[1].resolve(call('sql', { query: "INSERT INTO project_conventions (id,text) VALUES ('packages','Use pnpm')", source: userInputs[0] }))
      await waitFor(() => f.calls.length === 3)
      assert.match(f.conventions.prompt() ?? '', /Use pnpm/, String(f.calls[2].messages.findLast(message => message.role === 'tool')?.content))
      assert.match(String(f.calls[2].messages[0].content), /Current Project conventions.*\n[\s\S]*Use pnpm/)
      assert.equal(f.initiatives.workRecords().length, 0, 'Saving a Project preference is not task execution')
      const approved = 'Update Project convention packages at revision 1: Use pnpm 12'
      f.calls[2].resolve(call('ask', { kind: 'decision', question: 'Pin the package manager version for this Project?',
        options: [approved, 'Keep the current rule'], default_option: 'Keep the current rule', brief: decisionBrief }))
      await waitFor(() => !!f.sessions.yields.get(id)?.origin)
      const request = f.sessions.yields.get(id)!
      const response = await f.post({ requestId: request.id, option: approved }, 'ask')
      assert.equal(response.status, 200, await response.text())
      await waitFor(() => f.calls.length === 4)
      f.calls[3].resolve(call('sql', { query: "UPDATE project_conventions SET text='Use pnpm 12' WHERE id='packages' AND revision=1",
        source: { kind: 'decision', sessionId: id, physicalId: request.origin!.physicalId, requestId: request.id } }))
      await waitFor(() => f.calls.length === 5)
      assert.match(String(f.calls[4].messages[0].content), /Use pnpm 12/)
      assert.equal(f.conventions.query('SELECT * FROM convention_history', id).results[0].rows.length, 2)
      f.calls[4].resolve(done())
      await waitFor(f.quiet)
    } finally { await f.close(); store.close?.() }
    const reopened = new ProjectConventions(workspace, () => [])
    try { assert.match(reopened.prompt()!, /Use pnpm 12/) }
    finally { reopened.close() }
  }))

  for (const surface of ['ask', 'work']) test(`${Store.name}: one ${surface} approval applies the exact work proposal and settles Ask`, async () => withTempWorkspace(async workspace => {
    const store: SessionStore = new Store(join(workspace, 'sessions'))
    await store.init()
    const f = await fixture(workspace, store)
    try {
      await f.sessions.prepareCommandSession(id)
      f.initiatives.migrateWorkItems()
      const work = await f.alignment.execute({ kind: 'session', sessionId: id }, 'create', undefined, undefined,
        { title: 'Both outcomes', definition, reason: 'User request' }) as WorkRecord
      await f.alignment.execute({ kind: 'session', sessionId: id }, 'adopt', work.key, 1, adoption)
      const proposed = await f.alignment.execute({ kind: 'session', sessionId: id }, 'propose', work.key, 1,
        { change: 'goal', definition: { ...definition, objective: 'Both outcomes with documentation' }, reason: 'Expanded acceptance', paused: false }) as { proposalId: string }
      f.enableNotifications()
      await f.send('Review the proposed change')
      await waitFor(() => f.calls.length === 1)
      f.calls[0].resolve(call('ask', { kind: 'decision', proposal: { key: work.key, id: proposed.proposalId }, brief: decisionBrief }))
      await waitFor(() => !!f.sessions.yields.get(id)?.origin)
      const request = f.sessions.yields.get(id)!
      assert.equal(request.defaultOption, WORK_REJECT)
      assert.equal(request.workProposal?.definition.objective, 'Both outcomes with documentation')
      assert.throws(() => f.sessions.yields.reviseUser(id, request.id,
        { question: 'Different proposal?', options: ['Yes', 'No'], defaultOption: 'No', brief: decisionBrief }, 'Change goal', id), /cannot be rewritten/)
      await f.alignment.execute({ kind: 'session', sessionId: id }, 'propose', work.key, 1,
        { change: 'understanding', definition, reason: 'Alternative, not an applied change', paused: false })
      assert.equal(f.sessions.yields.get(id)?.id, request.id, 'A pending proposal must not invalidate another question')
      const response = surface === 'ask' ? await f.post({ requestId: request.id, option: WORK_APPROVE }, 'ask')
        : await f.post({ action: 'apply_proposal', key: work.key, revision: 1, data: { proposalId: proposed.proposalId } })
      assert.equal(response.status, 200, await response.text())
      await waitFor(() => f.calls.length === 2)
      assert.equal(f.alignment.get(work.key).revision, 2)
      assert.equal(f.alignment.get(work.key).proposals?.[0].status, 'applied')
      f.calls[1].resolve(call('work', { action: 'adopt', key: work.key, revision: 2, data: adoption }))
      await waitFor(() => f.calls.length === 3)
      f.calls[2].resolve(done())
      await waitFor(f.quiet)
      const records = await f.sessions.getYieldRecords(id)
      assert.equal(records[0].answer?.answeredBy, 'user')
      assert.equal(records[0].invalidated, undefined, 'The approval remains valid for the exact revision it applied')
      await f.alignment.recoverDecisions(async reference => records.find(record => record.request.id === reference.requestId))
      assert.equal(f.alignment.get(work.key).revision, 2)
    } finally { await f.close(); store.close?.() }
  }))

  test(`${Store.name}: restart recovers a saved human answer before Work application exactly once`, async () => withTempWorkspace(async workspace => {
    const store: SessionStore = new Store(join(workspace, 'sessions'))
    await store.init()
    const f = await fixture(workspace, store)
    try {
      await f.sessions.prepareCommandSession(id)
      f.initiatives.migrateWorkItems()
      const work = await f.alignment.execute({ kind: 'session', sessionId: id }, 'create', undefined, undefined,
        { title: 'Recover approval', definition, reason: 'Requested outcome' }) as WorkRecord
      await f.sessions.buildSession('web:initiative-view', undefined, { mode: 'session', initiativeId: work.key })
      const proposed = await f.alignment.execute({ kind: 'session', sessionId: id }, 'propose', work.key, 1,
        { change: 'goal', definition: { ...definition, objective: 'Reviewed recovered outcome' }, reason: 'Exact change', paused: false }) as { proposalId: string }
      const journal = new YieldRecords(store, target => f.sessions.getSessionState(target))
      const binding = f.alignment.decision(work.key, proposed.proposalId)
      const request = await journal.open({
        id: crypto.randomUUID(), sessionId: id, createdAt: new Date().toISOString(), deadline: null,
        recipient: { kind: 'user', sessionId: id }, question: 'Apply this work proposal?',
        options: [WORK_APPROVE, WORK_REJECT], defaultOption: WORK_REJECT, brief: decisionBrief, workProposal: binding,
      })
      f.alignment.bindDecision(binding, { sessionId: id, physicalId: request.origin!.physicalId, requestId: request.id })
      await journal.write({ request, answer: { requestId: request.id, option: WORK_APPROVE,
        answeredBy: 'user', answeredAt: new Date().toISOString() } })
      assert.equal(f.alignment.get(work.key).revision, 1, 'Answer is durable while Work is still unapplied')
      await f.sessions.stop()
      await f.sessions.start()
      assert.equal(f.sessions.getSessionState('web:initiative-view')?.initiativeId, work.key)
      const read = async (reference: { sessionId: string; physicalId: string; requestId: string }) =>
        (await f.sessions.getYieldRecords(reference.sessionId, reference.physicalId)).find(record => record.request.id === reference.requestId)
      await f.alignment.recoverDecisions(read)
      await f.alignment.recoverDecisions(read)
      assert.equal(f.alignment.get(work.key).revision, 2)
      assert.equal(f.alignment.get(work.key).definition.objective, 'Reviewed recovered outcome')
      assert.equal(f.initiatives.workHistory(work.key).filter(event => event.kind === 'proposal_applied').length, 1)
      assert.equal(f.calls.length, 0, 'Recovery neither asks again nor runs a model')
    } finally { await f.close(); store.close?.() }
  }))

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
      f.calls[0].resolve(call('ask', { action: 'ask', kind: 'decision', question: 'Only smoke?', options: ['Yes', 'No'], default_option: 'No', brief: decisionBrief }))
      await waitFor(() => !!f.sessions.yields.get(id)?.origin)
      const request = f.sessions.yields.get(id)!
      assert.equal(request.workStamps?.[0].revision, 1)
      assert.equal((await f.post({ requestId: request.id, customText: 'Both outcomes; smoke is not my requirement.' }, 'ask')).status, 200)
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
