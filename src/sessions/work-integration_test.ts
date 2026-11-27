import { WORK_DISPATCH_ID, workDispatchConfigSchema } from '../cron/work-dispatch-contract.ts'
import { WorkflowRuntime } from '../workflows/runtime.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { Hono } from 'hono'
import { z } from 'zod'
import { Bus } from '../bus/bus.ts'
import { ContextBuilder } from '../agent/context/builder.ts'
import { IdentityManager } from '../agent/identity.ts'
import { BackgroundTaskManager } from '../agent/background-task.ts'
import { AgentTypesManager } from '../agent/types/manager.ts'
import { EventService } from '../events/service.ts'
import { InitiativeStore } from '../initiatives/store.ts'
import { workRecordSchema } from '../initiatives/work-contract.ts'
import { WorkTool } from '../tools/work.ts'
import { MessageTool } from '../tools/message.ts'
import { AskTool } from '../tools/ask.ts'
import { ReplyTool } from '../tools/reply.ts'
import { SqlTool } from '../tools/sql.ts'
import { ReadTool } from '../tools/read.ts'
import { WriteTool } from '../tools/filesystem.ts'
import { ExecTool } from '../tools/shell.ts'
import { MicroAppTool } from '../tools/micro-app.ts'
import { SessionTools, Tools } from '../tools/registry.ts'
import { requireToolText } from '../tools/tool.ts'
import type { ExecutionContext } from '../tools/context.ts'
import { CommandHandlerManager } from '../tools/shell-commands/command-handler.ts'
import { ProcessManager } from '../execution/processes/manager.ts'
import { defaultManagedShell } from '../execution/processes/shells.ts'
import { ProjectConventions } from '../projects/conventions.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import type { ChatMessage, LLMProvider, LLMResponse } from '../providers/provider.ts'
import { HandoffManager } from './handoff/manager.ts'
import { SessionManager } from './session-manager.ts'
import { JsonlSessionStore } from './session-store-jsonl.ts'
import { SqliteSessionStore } from './session-store-sqlite.ts'
import { physicalSessionId } from './session-identity.ts'
import type { SessionStore } from './session-store.ts'
import type { DeliveryReceipt, SessionInput } from './input.ts'
import { inputRequestSchema } from './input-request.ts'
import { WorkAlignment } from './work-alignment.ts'
import { sessionsApiPlugin } from './routes.ts'
import { projectWorkPlugin } from '../projects/work-routes.ts'
import { projectWorkOverviewSchema } from '../projects/work-overview.ts'
import { TopicService } from './topics.ts'
import { FolderRegistry } from '../folders/registry.ts'
import { MicroApps } from '../microapps/service.ts'
import { createGitHubFixture } from '../testing/github.ts'
import { GitHubService } from '../projects/github/service.ts'
import { GitHubStore } from '../projects/github/store.ts'
import { VirtualFs } from '../vfs/virtual-fs.ts'

const id = 'web:worker', coordinator = 'web:coordinator'
const projectId = '11111111-1111-4111-8111-111111111111'
const llm = { model: 'fixture', contextWindow: 128_000, temperature: 0 }
const definition = 'Measure release impact\n\n- Report token usage\n- No publication'
const actor = (sessionId = id) => ({ kind: 'session' as const, sessionId })
const done = (): LLMResponse => ({ content: 'Finished', toolCalls: [] })
const call = (name: string, args: Record<string, unknown>, toolId: string = crypto.randomUUID()): LLMResponse =>
  ({ content: '', toolCalls: [{ id: toolId, name, arguments: args }] })
async function waitFor(predicate: () => boolean, message = 'Work integration timed out') {
  const deadline = Date.now() + 5000
  while (!predicate()) { assert(Date.now() < deadline, message); await delay(2) }
}

async function fixture(workspace: string, store: SessionStore) {
  const calls: { messages: ChatMessage[]; resolved: boolean; resolve: (value: LLMResponse) => void }[] = []
  const provider: LLMProvider = {
    name: 'fixture', listModels: () => ['fixture'],
    async chat(messages, _tools, options) {
      const pending = Promise.withResolvers<LLMResponse>(), signal = options!.signal!
      const abort = () => pending.reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      const entry = { messages: structuredClone(messages), resolved: false,
        resolve(value: LLMResponse) { entry.resolved = true; pending.resolve(value) } }
      calls.push(entry)
      try { signal.throwIfAborted(); return await pending.promise }
      finally { signal.removeEventListener('abort', abort) }
    },
  }
  const bus = new Bus(), tools = new Tools(workspace), context = new ContextBuilder(workspace)
  const agentTypes = new AgentTypesManager(workspace)
  await agentTypes.load()
  context.register({ name: 'fixture', getPromptSection: ctx => `Test session ${ctx.sessionId}` })
  const events = new EventService(workspace, bus, (target, input) => sessions.deliver(target, input))
  const backgroundTasks = new BackgroundTaskManager(bus, events)
  const sessions: SessionManager = new SessionManager({
    workspace, projectId, store, bus, provider, agentTypes, context, tools, events, backgroundTasks,
    identity: new IdentityManager(workspace, projectId),
    handoffManager: new HandoffManager(provider, llm.contextWindow, { autoHandoff: false }, workspace, store),
    getLlmRuntimeConfig: () => llm, getYieldPolicy: () => ({ timeoutMs: null }),
  })
  await sessions.start()
  const initiatives = new InitiativeStore(workspace, { isSessionKnown: target => !!sessions.getSessionState(target) })
  let notifications = false
  const alignment = new WorkAlignment(initiatives, {
    projectId,
    wakeWorkNotifications: async () => { if (notifications) await sessions.recoverWorkNotifications() },
    state: target => sessions.getSessionState(target),
    changed: async (record, previous) => { if (notifications) await sessions.notifyWorkChange(record, previous) },
  })
  sessions.alignment = alignment
  tools.setWorkGuard(alignment)
  const ask = new AskTool(sessions.yields, sessions.inputs, () => alignment)
  tools.register(new WorkTool(alignment)); tools.register(ask); tools.register(new ReplyTool(sessions.yields, sessions.inputs))
  const conventions = new ProjectConventions(workspace, () => initiatives.workRecords())
  tools.register(new SqlTool(conventions, projectId,
    (source, ctx) => sessions.validateConventionSource(source, ctx), () => sessions.invalidateSystemPrompts()))
  context.register({ name: 'project-conventions', getPromptSection: () => conventions.prompt() })
  let writes = 0
  tools.register({ name: 'fixture_write', description: '', parameters: { type: 'object', properties: {} },
    async execute() { writes++; return 'saved' } })
  const app = new Hono()
  sessionsApiPlugin(sessions)(app)
  projectWorkPlugin(sessions, request => request.headers.get('x-work-fixture') === 'human')(app)
  const post = (body: unknown, path = 'work', sessionId = id) => app.request(`/api/sessions/${encodeURIComponent(sessionId)}/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  const project = (path = '', body?: unknown, human = true) => app.request(`/api/work${path}`, {
    method: body ? 'POST' : 'GET', headers: { ...(human ? { 'x-work-fixture': 'human' } : {}), 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const overview = async () => projectWorkOverviewSchema.parse(await (await project()).json())
  const send = (content: string) => sessions.dispatch({
    channel: 'web', chatId: 'worker', senderId: 'owner', admin: true,
    messageId: crypto.randomUUID(), timestamp: new Date().toISOString(), content,
  }, llm)
  const quiet = (target = id) => {
    const active = sessions.getActiveSession(target)
    return !!active && 'quiescent' in active && active.quiescent
  }
  const ctx = (sessionId = id): ExecutionContext => ({
    sessionId, physicalSessionId: physicalSessionId(sessions.getSessionState(sessionId)!),
    projectId, channel: 'web', chatId: 'worker', senderId: 'owner', signal: new AbortController().signal,
    tools: new SessionTools(tools, workspace), cwd: workspace, messageId: 'fixture-input',
    inputSource: sessionId.startsWith('web:') ? 'user' : 'session',
  })
  const note = async (data: Record<string, unknown> = {}, creator = id) => workRecordSchema.parse(
    await alignment.execute(actor(creator), 'create', undefined, undefined,
      { title: 'Release metrics', definition, kind: 'goal', ...data }))
  async function finish(target = id) {
    await waitFor(() => {
      for (const entry of calls) if (!entry.resolved) entry.resolve(done())
      return quiet(target)
    }, 'Fixture did not finish its admitted turns')
  }
  async function close() {
    await sessions.stop(); await backgroundTasks.stop(); await events.stop(); conventions.close(); initiatives.close()
  }
  return { sessions, alignment, initiatives, conventions, events, backgroundTasks, tools, ask, calls, post, project, overview,
    send, quiet, ctx, note, finish, close, writes: () => writes, enableNotifications: () => { notifications = true } }
}

for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  test(`${Store.name}: host tool discovery suppresses ask for both automatic Work phases only`, async () => withTempWorkspace(async workspace => {
    const store: SessionStore = new Store(join(workspace, 'sessions')), f = await fixture(workspace, store)
    try {
      for (const phase of ['bootstrap', 'implementation'] as const) {
        const sessionId = `work-executor:discovery-${phase}`
        await f.sessions.buildSession(sessionId, undefined, { agentType: 'general', automaticWork: {
          key: 'work:d4557ed7-e276-52d1-8beb-59d95f7d7e39', jobId: WORK_DISPATCH_ID, phase,
          limits: workDispatchConfigSchema.parse({ kind: 'work-dispatch' }),
        } })
        const definitions = f.sessions.getToolDefinitions(sessionId, undefined, 'web')
        assert(!definitions.some(tool => tool.name === 'ask'), `${phase} must not inherit channel ask from an incoming event`)
      }
      const ordinary = 'web:ordinary-discovery'
      await f.sessions.buildSession(ordinary, undefined, { agentType: 'general' })
      assert(f.sessions.getToolDefinitions(ordinary, undefined, 'web').some(tool => tool.name === 'ask'))
    } finally { await f.close() }
  }))
  test(`${Store.name}: explicit assignment receipts persist for new and reused ordinary peers`, async () => withTempWorkspace(async workspace => {
    const store: SessionStore = new Store(join(workspace, 'sessions')), f = await fixture(workspace, store)
    const folders = new FolderRegistry(workspace); await folders.init()
    try {
      await f.sessions.prepareCommandSession(id)
      const work = await f.note({ assignee: null, idempotencyKey: 'durable-kickoff' })
      const topics = new TopicService({ projectId, sessions: f.sessions, folders,
        listStates: async () => Object.values(await store.listAllStates()), resolveAgent: () => ({ defaultMode: 'session' }), changed: () => {} })
      const request = { requestId: crypto.randomUUID(), topic: 'Peer', work: { key: work.key }, initialMessage: 'First task' }
      const peer = await topics.create(request, id)
      await f.finish(peer.sessionId)
      const assigned = f.alignment.get(work.key)
      const first = f.initiatives.assignmentDelivery(work.key, assigned.assignmentRevision)!
      assert.equal(first.status, 'accepted')
      assert.equal((await topics.create(request, id)).initialMessageStatus, 'not_replayed')
      await f.alignment.editNote(actor(peer.sessionId), work.key, f.alignment.get(work.key).sequence, { status: 'done', summary: 'First task complete' })
      const next = await f.note({ assignee: peer.sessionId })
      const message = new MessageTool(new Bus(), (target, source) => f.sessions.canReceiveSessionMessage(target, source),
        () => undefined, () => [], (target, input) => f.sessions.deliver(target, input), undefined, undefined, undefined, undefined, f.alignment)
      const args = { sessionId: peer.sessionId, content: 'Second task', work: { key: next.key, assignmentRevision: next.assignmentRevision } }
      const receipt = await message.execute(args, f.ctx())
      await f.finish(peer.sessionId)
      const calls = f.calls.length
      assert.match(await message.execute(args, f.ctx()), /already accepted/)
      assert.equal(f.calls.length, calls)
      assert.match(receipt, /inputId=/)
      assert.equal(f.alignment.get(next.key).status, 'pending')
      const reopened = new InitiativeStore(workspace)
      const restored = new Store(join(workspace, 'sessions')); await restored.init()
      try {
        const restoredState = (await restored.getState(peer.sessionId))!
        assert.equal(restoredState.mode, 'session')
        const history = []
        for await (const row of restored.readSessionLog(physicalSessionId(restoredState))) history.push(row)
        assert.match(JSON.stringify(history), /assignment-revision/)
        assert(JSON.stringify(history).includes(first.inputId), 'Stored sender metadata retains the receipt input identity')
        assert.equal(reopened.assignmentDelivery(work.key, assigned.assignmentRevision)?.inputId, first.inputId)
        assert.equal(reopened.assignmentDelivery(next.key, next.assignmentRevision)?.status, 'accepted')
        const recoveredAlignment = new WorkAlignment(reopened, {
          state: target => f.sessions.getSessionState(target),changed: async () => {},
        })
        const recovered = await recoveredAlignment.deliverAssignment(id, peer.sessionId, args.work, {
          id: crypto.randomUUID(), kind: 'message', timestamp: new Date().toISOString(), source: { kind: 'session', sessionId: id },
          policy: 'next-step', content: args.content,
        }, async () => { throw new Error('A recovered receipt must not replay delivery') })
        assert.equal(recovered.inputId, reopened.assignmentDelivery(next.key, next.assignmentRevision)?.inputId)
      } finally { reopened.close(); restored.close?.() }
    } finally { await f.close(); store.close?.() }
  }))
  test(`${Store.name}: real file tools need neither Work nor adoption, even with blocked notes and old required metadata`, async () => withTempWorkspace(async workspace => {
    const store: SessionStore = new Store(join(workspace, 'sessions')), f = await fixture(workspace, store)
    f.tools.register(new WriteTool(workspace)); f.tools.register(new ReadTool(workspace))
    try {
      await f.send('Save an introduction and read it back.')
      await waitFor(() => f.calls.length === 1)
      assert.doesNotMatch(String(f.calls[0].messages[0].content), /Current work contracts|not adopted/)
      f.calls[0].resolve(call('write', { path: 'profile.md', content: 'An ordinary introduction.' }))
      await waitFor(() => f.calls.length === 2)
      f.calls[1].resolve(call('read', { path: 'profile.md' }, 'read-profile'))
      await waitFor(() => f.calls.length === 3)
      assert.equal(f.calls[2].messages.find(message => message.tool_call_id === 'read-profile')?.content, 'An ordinary introduction.')
      await f.finish()
      assert.deepEqual(f.initiatives.workRecords(), [])
      const note = await f.note()
      f.sessions.getSessionState(id)!.workPolicy = { mode: 'required', controllerSessionId: id, keys: [note.key] }
      await store.saveState(id, f.sessions.getSessionState(id)!)
      const blocked = await f.alignment.editNote(actor(), note.key, note.sequence, { status: 'blocked', blockedReason: 'An optional grader is unavailable' })
      await f.send('Continue independent authorized work, then update the current note.')
      await waitFor(() => f.calls.length === 4)
      f.calls[3].resolve(call('fixture_write', {}))
      await waitFor(() => f.calls.length === 5)
      assert.equal(f.writes(), 1)
      f.calls[4].resolve(call('work', { action: 'update', key: note.key, version: blocked.sequence,
        data: { status: 'done', summary: 'Token measurements collected' } }, 'note-result'))
      await waitFor(() => f.calls.length === 6)
      const receipt = JSON.parse(String(f.calls[5].messages.find(message => message.tool_call_id === 'note-result')?.content))
      assert.equal(receipt.status, 'done'); assert.equal(receipt.goalRevision, 1)
      assert.equal(receipt.schema, undefined); assert.equal(receipt.notes, undefined)
      await f.finish()
      assert.deepEqual(f.initiatives.workEffects(), [])
      assert.equal(f.initiatives.workHistory(note.key).some(event => event.kind === 'tool_result'), false)
      assert.equal('adoption' in f.alignment.get(note.key), false)
      assert.equal((await f.post({ action: 'policy', data: { mode: 'required' } })).status, 400)
      const restored = new InitiativeStore(workspace)
      try { assert.equal(restored.workRecords()[0].summary, 'Token measurements collected') }
      finally { restored.close() }
    } finally { await f.close(); store.close?.() }
  }))

  test(`${Store.name}: a stable peer link precedes one kickoff, while temporary focus survives ordinary note edits`, async () => withTempWorkspace(async workspace => {
    const store: SessionStore = new Store(join(workspace, 'sessions')), f = await fixture(workspace, store)
    const folders = new FolderRegistry(workspace); await folders.init()
    try {
      await f.sessions.prepareCommandSession(id)
      const work = await f.note({ assignee: null })
      const topics = new TopicService({
        projectId, sessions: f.sessions, folders, listStates: async () => Object.values(await store.listAllStates()),
        resolveAgent: () => ({ defaultMode: 'session' }), changed: () => {},
      })
      f.enableNotifications()
      const request = { requestId: crypto.randomUUID(), topic: 'Metrics worker', work: { key: work.key }, initialMessage: 'Collect the measurements.' }
      const peer = await topics.create(request, id)
      await waitFor(() => f.calls.length === 1)
      assert.equal(f.alignment.get(work.key).assignee, peer.sessionId)
      assert.equal(f.alignment.required(peer.sessionId), false)
      assert.equal((await store.getState(peer.sessionId))?.workPolicy?.mode, 'optional')
      assert.match(JSON.stringify(f.calls[0].messages), /Shared work notes/)
      assert.equal((await topics.create(request, id)).initialMessageStatus, 'not_replayed')
      assert.equal(f.calls.length, 1, 'Assignment must not admit a separate model turn before the explicit kickoff')
      f.calls[0].resolve(call('fixture_write', {}))
      await waitFor(() => f.calls.length === 2)
      assert.equal(f.writes(), 1)
      await f.finish(peer.sessionId)
      await f.sessions.buildSession('virtual:metrics-task', { id: peer.sessionId }, { mode: 'task', parentSessionId: peer.sessionId })
      f.alignment.linkExecution('virtual:metrics-task', peer.sessionId)
      await f.sessions.buildSession('virtual:metrics-call', { id: 'virtual:metrics-task' },
        { mode: 'call', parentSessionId: 'virtual:metrics-task' })
      f.alignment.linkExecution('virtual:metrics-call', 'virtual:metrics-task')
      const current = f.alignment.get(work.key)
      await f.alignment.editNote(actor('virtual:metrics-task'), work.key, current.sequence, { summary: 'Read the usage report' })
      assert.equal(f.alignment.decisionContext('virtual:metrics-call')?.originKey, work.key)
      assert.deepEqual(f.alignment.context('virtual:metrics-task').records.map(record => record.key), [work.key])
      assert.equal((await f.overview()).sessions.find(session => session.sessionId === 'virtual:metrics-task')?.activity, 'pending')
      const restored = new InitiativeStore(workspace)
      try { assert.equal(restored.executionBinding('virtual:metrics-call'), work.key) }
      finally { restored.close() }
    } finally { await f.close(); store.close?.() }
  }))

  test(`${Store.name}: an ancestor correction invalidates the grader question, not routine progress, and preserves its historical context`, async () => withTempWorkspace(async workspace => {
    const store: SessionStore = new Store(join(workspace, 'sessions')), f = await fixture(workspace, store)
    try {
      await f.sessions.prepareCommandSession(id)
      const goal = await f.note({ assignee: null })
      const approach = await f.note({ title: 'Evaluate release candidates', assignee: null, parentKey: goal.key,
        kind: 'approach', definition: 'Compare evaluation results' })
      const grader = await f.note({ title: 'Build a grader', parentKey: approach.key,
        kind: 'task',
        definition: 'Make the unavailable grader ready only if necessary. Scored evaluation is assumed to be necessary.' })
      f.enableNotifications()
      await f.send('Identify the decision needed for the release report.')
      await waitFor(() => f.calls.length === 1)
      f.calls[0].resolve(call('ask', { kind: 'decision', workKey: grader.key, decisionKey: goal.key,
        question: 'Should the release report wait for scored evaluation?', options: ['Wait for a grader', 'Report token metrics only'],
        default_option: 'Report token metrics only' }, 'grader-ask'))
      await waitFor(() => !!f.sessions.yields.get(id)?.origin)
      const request = f.sessions.yields.get(id)!
      assert.equal(request.brief, undefined)
      assert.equal(request.workContext?.decisionKey, goal.key)
      assert.deepEqual(request.workContext?.path.map(node => node.key), [goal.key, approach.key, grader.key])
      await f.alignment.editNote(actor(), grader.key, grader.sequence, { summary: 'Checked the available fixtures' })
      assert.equal(f.sessions.yields.get(id)?.id, request.id)
      const projected = (await f.overview()).requests[0]
      assert.deepEqual(projected.context, request.workContext)
      assert.equal(projected.recipient, 'user')
      const response = await f.project(`/${encodeURIComponent(goal.key)}`, { action: 'update', key: goal.key, version: goal.sequence,
        data: { definition: 'Report token metrics without a grader' } })
      assert.equal(response.status, 200, await response.text())
      assert.equal(f.sessions.yields.get(id), null)
      assert.equal((await f.post({ requestId: request.id, option: 'Wait for a grader' }, 'ask')).status, 404)
      await waitFor(() => f.calls.length >= 2)
      const outcome = JSON.parse(String(f.calls[1].messages.find(message => message.tool_call_id === 'grader-ask')?.content))
      assert.equal(outcome.disposition, 'invalidated')
      assert.equal(outcome.approved, false)
      assert.match(JSON.stringify(f.calls[1].messages), /Report token metrics without a grader/)
      assert((await f.overview()).items.filter(item => item.parentKey).every(item => item.contextChanged))
      const before = f.alignment.get(grader.key)
      await f.alignment.editNote(actor(), grader.key, before.sequence, { summary: 'Waiting on a review of the revised metrics goal.' })
      assert.equal(f.alignment.contextChanged(f.alignment.get(grader.key)), true, 'Writing progress must not pretend to reassess a changed premise')
      await f.alignment.reviewNote(actor(), grader.key, f.alignment.get(grader.key).sequence, 'A grader is no longer needed for token metrics')
      assert.equal(f.alignment.contextChanged(f.alignment.get(grader.key)), false)
      await f.finish()
      const records = await f.sessions.getYieldRecords(id)
      assert.equal(records[0].closed?.reason, 'invalidated')
      assert.deepEqual(records[0].request.workContext, request.workContext)
      assert.equal(records[0].request.workContext?.path[0].revision, 1)
      const fresh = f.ask.execute({ kind: 'decision', workKey: approach.key, decisionKey: goal.key,
        question: 'How should token measurements be grouped?', options: ['By model', 'By scenario'], default_option: 'By model' }, f.ctx())
      await waitFor(() => !!f.sessions.yields.get(id))
      const next = f.sessions.yields.get(id)!
      assert.equal(next.workContext?.path[0].revision, 2)
      assert.equal(next.workContext?.path.at(-1)?.contextNeedsReview, true,
        'A new question retains the unassessed premise instead of laundering it through a new revision')
      await f.sessions.yields.answerUserText(id, next.id, 'By model, with a per-scenario appendix')
      assert.equal(JSON.parse(requireToolText(await fresh)).custom, true)
      await f.sessions.stop(); await f.sessions.start()
      const restored = await f.sessions.getYieldRecords(id)
      assert.deepEqual(restored.find(record => record.request.id === next.id)?.request.workContext, next.workContext)
      assert.equal(restored.find(record => record.request.id === request.id)?.closed?.reason, 'invalidated')
      await assert.rejects(f.ask.execute({ kind: 'decision', question: 'Reuse the old premise?', options: ['Yes', 'No'], default_option: 'No',
        sources: [{ sessionId: id, physicalId: request.origin!.physicalId, requestId: request.id }] }, f.ctx()), /revalidation|invalidated/)
    } finally { await f.close(); store.close?.() }
  }))

  test(`${Store.name}: contextual plain input closes on a changed premise and never becomes approval`, async () => withTempWorkspace(async workspace => {
    const store: SessionStore = new Store(join(workspace, 'sessions')), f = await fixture(workspace, store)
    try {
      await f.sessions.prepareCommandSession(id)
      const goal = await f.note()
      f.enableNotifications()
      const waiting = f.ask.execute({ kind: 'input', question: 'Which usage report?', workKey: goal.key }, f.ctx())
      const rejected = assert.rejects(waiting, /goal path changed/)
      await waitFor(() => !!f.sessions.inputs.get(id))
      const request = f.sessions.inputs.get(id)!
      assert.equal(request.workContext?.originKey, goal.key)
      await f.alignment.editNote(actor(), goal.key, goal.sequence, { summary: 'Two reports are available' })
      assert.equal(f.sessions.inputs.get(id)?.id, request.id)
      await f.alignment.editNote(actor(), goal.key, f.alignment.get(goal.key).sequence, { definition: 'Measure only the latest release' })
      await rejected
      assert.equal(f.sessions.inputs.get(id), null)
      assert.throws(() => f.sessions.inputs.replyUser(id, request.id, 'old report'), /no longer pending/)
      const next = f.ask.execute({ kind: 'input', question: 'Which latest-release report?', workKey: goal.key }, f.ctx())
      await waitFor(() => !!f.sessions.inputs.get(id))
      await f.sessions.inputs.replyUser(id, f.sessions.inputs.get(id)!.id, 'latest-usage.json')
      const answer = JSON.parse(requireToolText(await next))
      assert.equal(answer.text, 'latest-usage.json'); assert.equal('approved' in answer, false)
      const events = []
      for await (const event of store.readSessionLog(request.origin.physicalId)) events.push(event)
      const saved = z.array(z.object({ request: inputRequestSchema, closed: z.object({ status: z.string() }).optional() }))
        .parse(events.flatMap(event => event.input_request ? [event.input_request] : []))
      assert(saved.some(record => inputRequestSchema.parse(record.request).workContext?.originKey === goal.key))
      assert(saved.some(record => record.request.id === request.id && record.closed?.status === 'failed'))
    } finally { await f.close(); store.close?.() }
  }))

  test(`${Store.name}: question context and reporting never change the real parent answer authority`, async t => withTempWorkspace(async workspace => {
    const store: SessionStore = new Store(join(workspace, 'sessions')), f = await fixture(workspace, store)
    try {
      await f.sessions.prepareCommandSession(id); await f.sessions.prepareCommandSession(coordinator)
      const work = await f.note({ assignee: id }, coordinator)
      await f.sessions.buildSession('virtual:child', { id }, { mode: 'task', parentSessionId: id, reportTo: coordinator })
      f.alignment.linkExecution('virtual:child', id, { key: work.key })
      t.mock.method(f.sessions, 'deliver', async (sessionId: string, input: SessionInput): Promise<DeliveryReceipt> =>
        ({ status: 'accepted', sessionId, inputId: input.id }))
      const waiting = f.ask.execute({ kind: 'decision', question: 'Change the collection format?',
        options: ['JSON', 'CSV'], default_option: 'JSON', decisionKey: work.key }, f.ctx('virtual:child'))
      await waitFor(() => !!f.sessions.yields.get('virtual:child'))
      const request = f.sessions.yields.get('virtual:child')!
      assert.deepEqual(request.recipient, { kind: 'parent', sessionId: id })
      assert.equal((await f.overview()).requests[0].recipient, 'parent')
      assert.equal((await f.post({ requestId: request.id, option: 'CSV' }, 'ask', 'virtual:child')).status, 403)
      assert.throws(() => f.sessions.yields.answerParent(coordinator, request.id, 'CSV'), /parent/)
      await f.sessions.yields.answerParent(id, request.id, 'JSON')
      assert.equal(JSON.parse(requireToolText(await waiting)).answeredBy, 'parent')
      await assert.rejects(f.ask.execute({ kind: 'decision', question: 'Forged path?', options: ['A', 'B'], default_option: 'B',
        workContext: request.workContext }, f.ctx()), /Use ask/)
      await assert.rejects(f.ask.execute({ kind: 'decision', proposal: { key: work.key, id: crypto.randomUUID() } }, f.ctx()), /Use ask/)
    } finally { await f.close(); store.close?.() }
  }))

  test(`${Store.name}: silent comments and coalesced link-only notices, even across reassignment`, async () => withTempWorkspace(async workspace => {
    const store: SessionStore = new Store(join(workspace, 'sessions')), f = await fixture(workspace, store)
    try {
      await f.sessions.prepareCommandSession(id); await f.sessions.prepareCommandSession(coordinator)
      await f.sessions.prepareCommandSession('web:replacement')
      let work = await f.note({ assignee: id }, coordinator)
      await f.sessions.deliver(coordinator, { kind: 'message', id: 'manager-user', timestamp: new Date().toISOString(), policy: 'interactive',
        source: { kind: 'user', sender: { channel: 'web', chatId: 'coordinator', senderId: 'owner', messageId: 'manager-user', admin: true } }, content: 'Continue existing coordination' }, llm)
      await waitFor(() => f.calls.length === 1)
      f.enableNotifications()
      work = await f.alignment.editNote(actor(), work.key, work.sequence, { status: 'blocked', blockedReason: 'Need scope' })
      const note = (body: string, notifyManager?: boolean) => f.alignment.createWorkNote(id, { workKey: work.key, body, notifyManager })
      const silent = await note('Silent comment payload')
      const first = await note('First private-to-the-comment-body payload', true)
      const second = await note('Second distinct payload', true)
      assert.equal(silent.notification, 'not_queued')
      assert.equal(first.notification, 'queued')
      assert.equal(second.notification, 'queued')
      assert.equal(f.calls.length, 1, 'next-step must not abort the current inference')
      f.calls[0].resolve(done())
      await waitFor(() => f.calls.length === 2)
      const notices = f.calls[1].messages.filter(message => message.name === '__work_notification__')
      assert.equal(notices.length, 1)
      const text = JSON.stringify(notices)
      assert.match(text, /Blocked: Need scope/)
      for (const receipt of [first, second]) assert(text.includes(`/comments/id/${receipt.note.id}`))
      for (const receipt of [silent, first, second]) assert(!text.includes(receipt.note.body))
      assert(!text.includes(silent.note.id))
      assert.equal(f.initiatives.pendingWorkNotifications().length, 0)
      assert.equal(f.alignment.get(work.key).sequence, work.sequence)
      await f.finish(coordinator)
      work = await f.alignment.assignNote(actor(coordinator), work.key, work.sequence, 'web:replacement')
      await f.finish(id) // Let the independent release notice finish first.
      const response = await f.alignment.createWorkNote(coordinator, { workKey: work.key, replyTo: first.note.id, body: 'Use existing scope' })
      await waitFor(() => f.calls.some(call => JSON.stringify(call.messages).includes(`/comments/id/${response.note.id}`)))
      const replyTurn = f.calls.find(call => JSON.stringify(call.messages).includes(`/comments/id/${response.note.id}`))!
      assert.match(JSON.stringify(replyTurn.messages), /Test session web:worker/)
      assert.doesNotMatch(JSON.stringify(replyTurn.messages), /Use existing scope/)
      await f.finish(id)
      assert.equal(f.alignment.get(work.key).status, 'blocked', 'comment and reply do not unblock')
      assert.equal(f.alignment.get(work.key).sequence, work.sequence)
      assert.equal(f.initiatives.pendingWorkNotifications().length, 0)
    } finally { await f.close(); store.close?.() }
  }))

  test(`${Store.name}: overlapping wakes during log scanning reserve one marker and drain later comments`, async t => withTempWorkspace(async workspace => {
    const store: SessionStore = new Store(join(workspace, 'sessions')), f = await fixture(workspace, store)
    const scanning = Promise.withResolvers<void>(), unblock = Promise.withResolvers<void>()
    try {
      await f.sessions.prepareCommandSession(id); await f.sessions.prepareCommandSession(coordinator)
      const work = await f.note({ assignee: id }, coordinator)
      const physical = physicalSessionId(f.sessions.getSessionState(coordinator)!)
      const readLog = store.readSessionLog.bind(store)
      const pending = f.initiatives.pendingWorkNotifications.bind(f.initiatives)
      let paused = false, preparingMarker = false
      t.mock.method(f.initiatives, 'pendingWorkNotifications', (target?: string) => {
        if (target === coordinator) preparingMarker = true
        return pending(target)
      })
      t.mock.method(store, 'readSessionLog', async function* (target: string, options?: { strict?: boolean }) {
        if (preparingMarker && !paused && target === physical) { paused = true; scanning.resolve(); await unblock.promise }
        yield* readLog(target, options)
      })
      const deliver = t.mock.method(f.sessions, 'deliver')
      f.enableNotifications()
      const post = (body: string) => f.alignment.createWorkNote(id, { workKey: work.key, body, notifyManager: true })
      const first = await post('First comment')
      await scanning.promise
      const second = await post('During scan')
      await Promise.all([f.sessions.recoverWorkNotifications(), f.sessions.recoverWorkNotifications()])
      assert.equal(deliver.mock.callCount(), 1)
      unblock.resolve()
      await waitFor(() => f.calls.length === 1)
      await f.finish(coordinator)
      await waitFor(() => f.initiatives.pendingWorkNotifications().length === 0)
      await f.finish(coordinator)
      const rows = await Array.fromAsync(readLog(physical))
      const notices = rows.filter(row => row.name === '__work_notification__')
      assert.equal(notices.length, 2)
      for (const { note } of [first, second]) assert.equal(notices.filter(row => JSON.stringify(row).includes(`/comments/id/${note.id}`)).length, 1)
    } finally { unblock.resolve(); await f.close(); store.close?.() }
  }))

  test(`${Store.name}: a manager change after marker preparation prevents the log append`, async t => withTempWorkspace(async workspace => {
    const store: SessionStore = new Store(join(workspace, 'sessions')), f = await fixture(workspace, store)
    try {
      await f.sessions.prepareCommandSession(id); await f.sessions.prepareCommandSession(coordinator)
      await f.sessions.prepareCommandSession('web:successor')
      const work = await f.note({ assignee: id }, coordinator)
      const prepare = f.initiatives.prepareWorkNotificationDelivery.bind(f.initiatives)
      let checkedAtAppend = false
      t.mock.method(f.initiatives, 'prepareWorkNotificationDelivery', (...args: Parameters<typeof prepare>) => {
        const result = prepare(...args)
        if (!args[3] && result.notices.length) {
          const changed = { ...work, manager: 'web:successor', sequence: work.sequence + 1 }
          f.initiatives.saveWork(changed, work.sequence, 'human', 'note')
          f.initiatives.saveWork({ ...changed, manager: coordinator, sequence: changed.sequence + 1 }, changed.sequence, 'human', 'note')
        } else if (args[3]) checkedAtAppend = true
        return result
      })
      f.enableNotifications()
      const { note } = await f.alignment.createWorkNote(id, { workKey: work.key, body: 'Must not reach stale recipient', notifyManager: true })
      await waitFor(() => checkedAtAppend && f.quiet(coordinator))
      assert.equal(f.calls.length, 0)
      assert.deepEqual(f.initiatives.pendingWorkNotifications(), [])
      const physical = physicalSessionId(f.sessions.getSessionState(coordinator)!)
      assert(!(await Array.fromAsync(store.readSessionLog(physical))).some(row => JSON.stringify(row).includes(note.id)))
      assert.equal(f.initiatives.workNote(work.key, note.id).author, id)
    } finally { await f.close(); store.close?.() }
  }))

  test(`${Store.name}: unavailable coordinator admission keeps facts durable and recovery retries once without creating review`, async t => withTempWorkspace(async workspace => {
    const store: SessionStore = new Store(join(workspace, 'sessions')), f = await fixture(workspace, store)
    try {
      await f.sessions.prepareCommandSession(id); await f.sessions.prepareCommandSession(coordinator)
      const work = await f.note({ assignee: id }, coordinator)
      let attempts = 0
      const mock = t.mock.method(f.sessions, 'deliver', async (): Promise<DeliveryReceipt> => { attempts++; throw new Error('Synthetic unavailable coordinator') })
      f.enableNotifications()
      await f.alignment.editNote(actor(), work.key, work.sequence, { status: 'done', summary: 'Completed' })
      assert.equal(attempts, 1)
      assert.equal(f.initiatives.pendingWorkNotifications().length, 1)
      assert.equal(f.alignment.get(work.key).contextAssessment, undefined)
      mock.mock.restore()
      await f.sessions.recoverWorkNotifications()
      await waitFor(() => f.calls.length === 1)
      assert.match(JSON.stringify(f.calls[0].messages), /Reported done: Completed/)
      await f.finish(coordinator)
      await f.sessions.recoverWorkNotifications()
      assert.equal(f.calls.length, 1)
    } finally { await f.close(); store.close?.() }
  }))

  test(`${Store.name}: admitted but unconsumed markers survive Session stop and restart in the same runtime`, async () => withTempWorkspace(async workspace => {
    const store: SessionStore = new Store(join(workspace, 'sessions')), f = await fixture(workspace, store)
    const managerInput = () => ({ kind: 'message' as const, id: crypto.randomUUID(), timestamp: new Date().toISOString(), policy: 'interactive' as const,
      source: { kind: 'user' as const, sender: { channel: 'web', chatId: 'coordinator', senderId: 'owner', messageId: crypto.randomUUID(), admin: true } }, content: 'Continue coordination' })
    try {
      await f.sessions.prepareCommandSession(id); await f.sessions.prepareCommandSession(coordinator)
      const work = await f.note({ assignee: id }, coordinator)
      await f.sessions.deliver(coordinator, managerInput(), llm)
      await waitFor(() => f.calls.length === 1)
      f.enableNotifications()
      const { note } = await f.alignment.createWorkNote(id, { workKey: work.key, body: 'Retained comment', notifyManager: true })
      const active = f.sessions.getActiveSession(coordinator)!
      active.stop(); await active.completion
      assert.equal(f.initiatives.pendingWorkNotifications().length, 1)
      await f.sessions.deliver(coordinator, managerInput(), llm)
      await waitFor(() => f.calls.length >= 2)
      await f.finish(coordinator)
      assert.equal(f.initiatives.pendingWorkNotifications().length, 0)
      const noticeMessages = f.calls.flatMap(entry => entry.messages.filter(message => message.name === '__work_notification__'))
      assert(noticeMessages.some(message => JSON.stringify(message).includes(`/comments/id/${note.id}`)))
    } finally { await f.close(); store.close?.() }
  }))

  test(`${Store.name}: a failed comment append stays pending and cannot start inference`, async t => withTempWorkspace(async workspace => {
    const store: SessionStore = new Store(join(workspace, 'sessions')), f = await fixture(workspace, store)
    try {
      await f.sessions.prepareCommandSession(id); await f.sessions.prepareCommandSession(coordinator)
      const work = await f.note({ assignee: id }, coordinator)
      const append = store.appendMessages.bind(store)
      let failed = false
      const persistence = t.mock.method(store, 'appendMessages', async (...args: Parameters<typeof append>) => {
        if (args[1].some(row => row.name === '__work_notification__')) { failed = true; throw new Error('Synthetic comment append failure') }
        await append(...args)
      })
      f.enableNotifications()
      const { note } = await f.alignment.createWorkNote(id, { workKey: work.key, body: 'Retry the notice, not the comment', notifyManager: true })
      await waitFor(() => failed && f.quiet(coordinator))
      const physical = physicalSessionId(f.sessions.getSessionState(coordinator)!)
      assert.deepEqual(f.initiatives.pendingWorkNotifications(coordinator).map(row => [row.id, row.deliveryPhysicalIds]), [[`note:${note.id}`, [physical]]])
      assert.equal(f.calls.length, 0)
      assert(!(await Array.fromAsync(store.readSessionLog(physical))).some(row => row.name === '__work_notification__'))
      persistence.mock.restore()
      await f.sessions.recoverWorkNotifications()
      await waitFor(() => f.calls.length === 1)
      await f.finish(coordinator)
      assert.deepEqual(f.initiatives.pendingWorkNotifications(coordinator), [])
      const rows = (await Array.fromAsync(store.readSessionLog(physical))).filter(row => row.name === '__work_notification__')
      assert.equal(rows.length, 1)
      assert(JSON.stringify(rows[0]).includes(`/comments/id/${note.id}`))
    } finally { await f.close(); store.close?.() }
  }))

  test(`${Store.name}: comment history receipt closes append/settle crash window across restart and segment reset`, async t => withTempWorkspace(async workspace => {
    const directory = join(workspace, 'sessions')
    let store: SessionStore = new Store(directory), f = await fixture(workspace, store)
    try {
      await f.sessions.prepareCommandSession(id); await f.sessions.prepareCommandSession(coordinator)
      const work = await f.note({ assignee: id }, coordinator)
      const settlement = t.mock.method(f.initiatives, 'settleWorkNotifications', () => {})
      f.enableNotifications()
      const { note } = await f.alignment.createWorkNote(id, { workKey: work.key, body: 'One durable comment', notifyManager: true })
      await waitFor(() => f.calls.length === 1)
      assert.match(JSON.stringify(f.calls[0].messages), new RegExp(`/comments/id/${note.id}`))
      await f.finish(coordinator)
      const pending = f.initiatives.pendingWorkNotifications()
      assert.equal(pending.length, 1)
      assert(pending[0].deliveryPhysicalIds?.length)
      settlement.mock.restore()
      assert.equal(await f.sessions.clearSessionContext(coordinator), 'cleared')
      await f.close(); store.close?.()
      store = new Store(directory); f = await fixture(workspace, store)
      assert.deepEqual(f.initiatives.pendingWorkNotifications(), pending)
      await f.sessions.recoverWorkNotifications()
      await waitFor(() => f.initiatives.pendingWorkNotifications().length === 0)
      await delay(20)
      assert.equal(f.calls.length, 0, 'already persisted handoff must not wake a new inference')
      assert.deepEqual(f.initiatives.workNote(work.key, note.id), note)
    } finally { await f.close(); store.close?.() }
  }))

  test(`${Store.name}: HTTP note updates preserve auth, CAS and Project boundaries without imposing adoption or history dumps`, async () => withTempWorkspace(async workspace => {
    const store: SessionStore = new Store(join(workspace, 'sessions')), f = await fixture(workspace, store)
    try {
      await f.sessions.prepareCommandSession(id); await f.sessions.prepareCommandSession(coordinator)
      const work = await f.note({ assignee: null }, coordinator)
      const path = `/${encodeURIComponent(work.key)}`
      assert.equal((await f.project('', undefined, false)).status, 401)
      assert.equal((await f.project(path, undefined, false)).status, 401)
      const first = await f.overview()
      assert.equal(first.items[0].assignee, null)
      assert.equal(first.sessions.find(session => session.sessionId === id)?.workKey, undefined)
      assert(first.sessions.some(session => session.sessionId === id), 'Untracked sessions remain visible')
      assert.equal(f.calls.length, 0)
      const assign = { action: 'assign', key: work.key, version: work.sequence, data: { assignee: id } }
      assert.equal((await f.project(path, assign, false)).status, 401)
      assert.equal((await f.project(path, { ...assign, key: 'work:5e546683-5364-53e9-b8ae-d5d5402b9671' })).status, 400)
      assert.equal((await f.project('/work%3A5e546683-5364-53e9-b8ae-d5d5402b9671')).status, 404)
      assert.equal((await f.project(path, assign)).status, 200)
      assert.equal((await f.project(path, assign)).status, 409)
      const current = f.alignment.get(work.key)
      const update = { action: 'update', key: work.key, version: current.sequence,
        data: { status: 'done', summary: 'Measurements collected; review remains separate' } }
      assert.equal((await f.project(path, update)).status, 200)
      assert.equal((await f.project(path, update)).status, 409)
      assert.equal((await f.project(path, { action: 'adopt', key: work.key, revision: 1, data: {} })).status, 400)
      const detail = await (await f.project(path)).json()
      assert.deepEqual(detail.records[0].history, [])
      assert.equal(detail.schema, undefined)
      assert((await (await f.project(`${path}?history=1`)).json()).records[0].history.length > 0)
      await assert.rejects(f.alignment.editNote(actor(), work.key, f.alignment.get(work.key).sequence,
        { definition: 'Replace the coordinator goal' }), /controller/)
      assert.equal(f.calls.length, 0)
    } finally { await f.close(); store.close?.() }
  }))

  test(`${Store.name}: rewriting a question preserves its original goal path and cannot make a stale path valid`, async () => withTempWorkspace(async workspace => {
    const store: SessionStore = new Store(join(workspace, 'sessions')), f = await fixture(workspace, store)
    try {
      await f.sessions.prepareCommandSession(id)
      const goal = await f.note()
      const waiting = f.ask.execute({ kind: 'decision', workKey: goal.key, question: 'Which report?',
        options: ['Summary', 'Detailed'], default_option: 'Summary' }, f.ctx())
      await waitFor(() => !!f.sessions.yields.get(id))
      const original = f.sessions.yields.get(id)!
      const next = await f.sessions.yields.reviseUser(id, original.id, {
        question: 'Which report meets the release goal?', options: ['Concise comparison', 'Full appendix'], defaultOption: 'Concise comparison',
      }, 'Explain the choice at the release-goal level', id)
      assert.deepEqual(next.workContext, original.workContext)
      assert.equal(f.sessions.yields.get(id)?.id, next.id)
      f.enableNotifications()
      await f.alignment.editNote(actor(), goal.key, goal.sequence, { definition: 'A corrected release goal' })
      assert.equal(JSON.parse(requireToolText(await waiting)).disposition, 'invalidated')
      const records = await f.sessions.getYieldRecords(id)
      assert.equal(records.find(record => record.request.id === original.id)?.closed?.reason, 'superseded')
      assert.equal(records.find(record => record.request.id === next.id)?.closed?.reason, 'invalidated')
    } finally { await f.close(); store.close?.() }
  }))

  test(`${Store.name}: a native failed command remains in session history and repairs need no Work settlement`, async () => withTempWorkspace(async workspace => {
    const store: SessionStore = new Store(join(workspace, 'sessions')), f = await fixture(workspace, store), manager = new ProcessManager()
    f.tools.register(new ExecTool(workspace, 5000, new CommandHandlerManager(), manager, defaultManagedShell(), f.backgroundTasks))
    try {
      await f.sessions.prepareCommandSession(id)
      const work = await f.note()
      const noteHistory = f.initiatives.workHistory(work.key)
      await f.send('Run the failing check, inspect it, then repair the fixture.')
      await waitFor(() => f.calls.length === 1)
      f.calls[0].resolve(call('exec', { script: 'exit 7', shell: defaultManagedShell(), cwd: workspace }, 'normal-failure'))
      await waitFor(() => f.calls.length === 2)
      assert.match(JSON.stringify(f.calls[1].messages), /command exited with code 7/)
      f.calls[1].resolve(call('fixture_write', {}))
      await waitFor(() => f.calls.length === 3)
      assert.equal(f.writes(), 1)
      await f.finish()
      const history = []
      for await (const record of store.readSessionLog(physicalSessionId(f.sessions.getSessionState(id)!))) history.push(record)
      assert.match(JSON.stringify(history), /command exited with code 7/)
      assert.deepEqual(f.initiatives.workEffects(), [])
      assert.deepEqual(f.initiatives.workHistory(work.key), noteHistory, 'Tool output is not copied into the notebook journal')
    } finally {
      await f.close()
      for (const process of manager.list()) await manager.terminate(process)
      store.close?.()
    }
  }))

  test(`${Store.name}: app publication retains selected goal criteria without Work gates or owner impersonation`, async () => withTempWorkspace(async workspace => {
    const store: SessionStore = new Store(join(workspace, 'sessions')), f = await fixture(workspace, store)
    const service = new MicroApps(projectId, workspace, () => { throw new Error('No model expected') }, () => 'fixture', {
      ownerSession: sessionId => sessionId, ask: async () => { throw new Error('No approval expected') },
      notify: async () => {}, evidence: async () => {},
      work: (sessionId, stamps) => {
        f.alignment.assertCurrent(stamps, sessionId)
        return stamps.map(stamp => {
          const record = f.alignment.get(stamp.key)
          return { key: record.key, revision: record.revision, definition: record.definition }
        })
      },
    })
    try {
      await service.init(); await f.sessions.prepareCommandSession(id)
      const work = await f.note()
      const tool = new MicroAppTool(service, sessionId => assert.equal(sessionId, id), undefined, sessionId => f.alignment.operationBasis(sessionId))
      const directory = join(workspace, 'fixture-app')
      await mkdir(directory)
      await writeFile(join(directory, 'index.html'), '<title>Metrics fixture</title>')
      await writeFile(join(directory, 'shadow-app.json'), JSON.stringify({ version: 1, name: 'Metrics', description: 'Synthetic fixture',
        entry: 'index.html', files: ['index.html'], llm: { maxCalls: 1, maxOutputTokens: 32 } }))
      assert.deepEqual(f.alignment.snapshot(id), [], 'Ordinary inference does not acquire execution fences')
      const receipt = JSON.parse(await tool.execute({ action: 'publish', directory: 'fixture-app' }, f.ctx()))
      const app = service.get(receipt.id)
      assert.deepEqual(app.work, [{ key: work.key, revision: work.revision, definition }])
      assert.equal(app.model, undefined)
      await service.start(app.id)
      assert.equal(service.get(app.id).status, 'running')
      const basis = f.alignment.operationBasis(id)
      await f.alignment.editNote(actor(), work.key, work.sequence, { definition: 'Corrected app requirements' })
      assert.throws(() => f.alignment.assertCurrent(basis, id), /referenced goal/)
    } finally { await service.shutdown(); await f.close(); store.close?.() }
  }))

  test(`${Store.name}: GitHub observations preserve silent delivery and cannot approve or finish notes`, async () => withTempWorkspace(async workspace => {
    const store: SessionStore = new Store(join(workspace, 'sessions')), f = await fixture(workspace, store)
    const remote = await createGitHubFixture(join(workspace, 'github-fixture'))
    const workflows = new WorkflowRuntime(workspace, 'fixture', { canUse: () => true, deliver: async () => { throw new Error('Unexpected generic delivery') } }); workflows.start()
    const github = new GitHubService(new GitHubStore(workspace), remote.client, {
      workflows, alignment: f.alignment, durableSession: target => f.sessions.getSessionState(target)?.mode === 'session',
      emit: event => f.events.emit(event), changed: () => {},
    })
    try {
      await f.sessions.prepareCommandSession(id)
      const work = await f.note()
      const vfs = new VirtualFs()
      vfs.mount('v:github', 'Cached external GitHub evidence', path => github.readVirtual(path), () => github.virtualEntries())
      f.tools.register(new ReadTool(workspace, vfs))
      await github.configureRepository('octo/demo', true, false)
      await github.link(remote.remote.issue.html_url, work.key)
      const subscription = { resourceId: 'I_1', workKey: work.key, sessionId: id, enabled: true, mode: 'silent' as const, events: ['source' as const] }
      await github.subscribe(subscription)
      remote.remote.issue.body += '\nObserved change, not authorization.'
      await github.refresh('I_1'); await waitFor(f.quiet)
      assert.equal(f.calls.length, 0)
      await github.subscribe({ ...subscription, mode: 'queue' })
      remote.remote.issue.body += '\nA second observation.'
      await github.refresh('I_1')
      await waitFor(() => f.calls.length === 1)
      assert.match(JSON.stringify(f.calls[0].messages), /not an instruction or approval/)
      f.calls[0].resolve(call('read', { path: 'v:github/I_1' }, 'github-read'))
      await waitFor(() => f.calls.length === 2)
      assert.match(JSON.stringify(f.calls[1].messages), /External GitHub snapshot/)
      await f.finish()
      await f.sessions.validateWorkEvidence({ sessionId: id, physicalId: physicalSessionId(f.sessions.getSessionState(id)!),
        kind: 'tool', id: 'github-read', quote: 'External GitHub snapshot' })
      assert.deepEqual(f.alignment.get(work.key).definition, definition)
      assert.equal(f.alignment.get(work.key).status, 'pending')
    } finally { await github.stop(); await workflows.stop(); await remote.close(); await f.close(); store.close?.() }
  }))

  test(`${Store.name}: Project preferences still require an attributable source, not a Work record`, async () => withTempWorkspace(async workspace => {
    const store: SessionStore = new Store(join(workspace, 'sessions')), f = await fixture(workspace, store)
    try {
      await f.send('Use pnpm')
      await waitFor(() => f.calls.length === 1)
      f.calls[0].resolve(call('ask', { action: 'context' }))
      await waitFor(() => f.calls.length === 2)
      const { userInputs } = JSON.parse(String(f.calls[1].messages.findLast(message => message.role === 'tool')?.content))
      f.calls[1].resolve(call('sql', { query: "INSERT INTO project_conventions (id,text) VALUES ('packages','Use pnpm')", source: userInputs[0] }))
      await waitFor(() => f.calls.length === 3)
      assert.match(f.conventions.prompt() ?? '', /Use pnpm/)
      assert.equal(f.initiatives.workRecords().length, 0)
      const approved = 'Update Project convention packages at revision 1: Use pnpm 12'
      f.calls[2].resolve(call('ask', { kind: 'decision', question: 'Pin the package manager version?',
        options: [approved, 'Keep the current rule'], default_option: 'Keep the current rule' }))
      await waitFor(() => !!f.sessions.yields.get(id)?.origin)
      const request = f.sessions.yields.get(id)!
      assert.equal(request.workContext, undefined)
      assert.equal((await f.post({ requestId: request.id, option: approved }, 'ask')).status, 200)
      await waitFor(() => f.calls.length === 4)
      f.calls[3].resolve(call('sql', { query: "UPDATE project_conventions SET text='Use pnpm 12' WHERE id='packages' AND revision=1",
        source: { kind: 'decision', sessionId: id, physicalId: request.origin!.physicalId, requestId: request.id } }))
      await waitFor(() => f.calls.length === 5)
      assert.match(JSON.stringify(f.calls[4].messages), /Use pnpm 12/)
      await f.finish()
    } finally { await f.close(); store.close?.() }
  }))
}
