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
import { projectWorkPlugin } from '../projects/work-routes.ts'
import { projectWorkOverviewSchema } from '../projects/work-overview.ts'
import { createGitHubFixture } from '../testing/github.ts'
import { GitHubService } from '../projects/github/service.ts'
import { GitHubStore } from '../projects/github/store.ts'
import { VirtualFs } from '../vfs/virtual-fs.ts'
import { ReadTool } from '../tools/read.ts'
import { WriteTool } from '../tools/filesystem.ts'
import { acceptanceWorkApproval } from '../../scripts/microapp-a2a.ts'
import { BrowserSetupTool } from '../tools/browser-setup.ts'
import { InvokeTool } from '../tools/invoke-tool.ts'
import { ImportTool } from '../tools/load-tool.ts'
import type { SessionInput } from './input.ts'
import { ExecTool } from '../tools/shell.ts'
import { ProcessManager } from '../execution/processes/manager.ts'
import { CommandHandlerManager } from '../tools/shell-commands/command-handler.ts'
import { defaultManagedShell } from '../execution/processes/shells.ts'
import { mkdir, writeFile } from 'node:fs/promises'
import { MicroApps } from '../microapps/service.ts'
import { TopicService } from './topics.ts'
import { FolderRegistry } from '../folders/registry.ts'

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

async function fixture(workspace: string, store: SessionStore, managed = true) {
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
    setPolicy: (target, policy, validate) => sessions.setWorkPolicy(target, policy, validate),
    resolveEvidence: (target, sources, signal) => sessions.resolveToolEvidence(target, sources, signal),
    changed: async (record, previous) => {
      const executor = initiatives.workAuthority(record.subject).executor
      if (managed && executor && sessions.getSessionState(executor)?.workPolicy?.mode === 'optional') {
        await sessions.setWorkPolicy(executor, { mode: 'required', keys: [record.key], controllerSessionId: executor }, () => {})
      }
      if (notifications) await sessions.notifyWorkChange(record, previous)
    },
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
  projectWorkPlugin(sessions, request => request.headers.get('x-work-fixture') === 'human')(app)
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
  return { sessions, alignment, initiatives, conventions, events, backgroundTasks, tools, calls, app, post, revise, send, quiet, close, writes: () => writes,
    enableNotifications: () => { notifications = true } }
}

for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  test(`${Store.name}: ordinary file requests need no Work while optional tracking stays available`, async () => withTempWorkspace(async workspace => {
    const store: SessionStore = new Store(join(workspace, 'sessions'))
    const f = await fixture(workspace, store, false)
    f.tools.register(new WriteTool(workspace))
    f.tools.register(new ReadTool(workspace))
    try {
      await f.send('Save a short introduction to profile.md and read it back.')
      await waitFor(() => f.calls.length === 1)
      assert.equal(f.sessions.getSessionState(id)?.workPolicy?.mode, 'optional')
      assert.match(String(f.calls[0].messages[0].content), /Work mode: optional/)
      assert.doesNotMatch(String(f.calls[0].messages[0].content), /Current work contracts|Recent tool receipt IDs|Before exec/)
      f.calls[0].resolve(call('write', { path: 'profile.md', content: '# Profile\nAn ordinary introduction.\n' }))
      await waitFor(() => f.calls.length === 2)
      f.calls[1].resolve(call('read', { path: 'profile.md' }))
      await waitFor(() => f.calls.length === 3)
      assert.match(String(f.calls[2].messages.at(-1)?.content), /An ordinary introduction/)
      f.calls[2].resolve(done())
      await waitFor(f.quiet)
      assert.deepEqual(f.initiatives.workRecords(), [])
      assert.deepEqual(f.initiatives.workEffects(), [])
      assert.equal((await store.getState(id))?.workPolicy?.mode, 'optional')
      const policyResponse = await f.post({ action: 'policy', data: { mode: 'optional' } })
      assert.equal(policyResponse.status, 200)
      assert.equal((await policyResponse.json()).policy.mode, 'optional')
    } finally { await f.close(); store.close?.() }
  }))

  test(`${Store.name}: interrupted managed creation stays bound and never admits its kickoff`, async () => withTempWorkspace(async workspace => {
    const store: SessionStore = new Store(join(workspace, 'sessions'))
    const f = await fixture(workspace, store, false)
    const folders = new FolderRegistry(workspace)
    await folders.init()
    try {
      await f.sessions.prepareCommandSession(id)
      const root = await f.alignment.execute({ kind: 'session', sessionId: id }, 'create', undefined, undefined,
        { title: 'Paused during admission', assignee: null, definition, reason: 'Fixture' }) as WorkRecord
      const build = f.sessions.buildSession.bind(f.sessions)
      f.sessions.buildSession = async (...args) => {
        await build(...args)
        await f.alignment.execute({ kind: 'session', sessionId: id }, 'update', root.key, 1,
          { definition: root.definition, change: 'pause', reason: 'Concurrent controller stop', paused: true })
      }
      const topics = new TopicService({
        projectId: '11111111-1111-4111-8111-111111111111', sessions: f.sessions, folders,
        listStates: async () => Object.values(await store.listAllStates()),
        resolveAgent: () => ({ defaultMode: 'session' }), changed: () => {},
      })
      const request = { requestId: crypto.randomUUID(), title: 'Never start', work: { key: root.key, revision: 1 },
        initialMessage: 'Must not run under a stale binding.' }
      await assert.rejects(topics.create(request, id), /revision changed|paused/)
      const target = `web:chat-${request.requestId}`
      assert.equal((await store.getState(target))?.workPolicy?.mode, 'required')
      assert.equal(f.alignment.get(root.key).workflow?.assignee, null)
      assert.equal(f.calls.length, 0)
      await assert.rejects(topics.create(request, id), /incomplete/)
      assert.equal(f.calls.length, 0, 'A retry must not silently admit the failed kickoff')
    } finally { await f.close(); store.close?.() }
  }))

  test(`${Store.name}: peer binding precedes kickoff, keeps its coordinator optional and propagates to tasks`, async () => withTempWorkspace(async workspace => {
    const store: SessionStore = new Store(join(workspace, 'sessions'))
    const f = await fixture(workspace, store, false)
    const folders = new FolderRegistry(workspace)
    await folders.init()
    try {
      await f.sessions.prepareCommandSession(id)
      const root = await f.alignment.execute({ kind: 'session', sessionId: id }, 'create', undefined, undefined,
        { title: 'Managed document', assignee: null, definition, reason: 'Explicit delegation' }) as WorkRecord
      const topics = new TopicService({
        projectId: '11111111-1111-4111-8111-111111111111', sessions: f.sessions, folders,
        listStates: async () => Object.values(await store.listAllStates()),
        resolveAgent: () => ({ defaultMode: 'session' }), changed: () => {},
      })
      f.enableNotifications()
      const request = { requestId: crypto.randomUUID(), title: 'Document worker', work: { key: root.key, revision: 1 },
        initialMessage: 'Write the assigned document.' }
      const peer = await topics.create(request, id)
      await waitFor(() => f.calls.length === 1)
      assert.equal(f.alignment.required(id), false)
      assert.equal(f.alignment.required(peer.sessionId), true)
      assert.equal(f.alignment.get(root.key).workflow?.assignee, peer.sessionId)
      assert.match(String(f.calls[0].messages[0].content), /Current work contracts/)
      assert.equal((await store.getState(peer.sessionId))?.workPolicy?.mode, 'required')
      const retry = await topics.create(request, id)
      assert.equal(retry.initialMessageStatus, 'not_replayed')
      assert.equal(f.calls.length, 1, 'Assignment notifications must not start a second turn before kickoff')
      f.calls[0].resolve(call('fixture_write', {}))
      await waitFor(() => f.calls.length === 2)
      assert.equal(f.writes(), 0)
      assert.match(JSON.stringify(f.calls[1].messages), /not adopted|basis changed/)
      f.calls[1].resolve(call('work', { action: 'adopt', key: root.key, revision: 1, data: adoption }))
      await waitFor(() => f.calls.length === 3)
      f.calls[2].resolve(call('fixture_write', {}))
      await waitFor(() => f.calls.length === 4)
      assert.equal(f.writes(), 1)
      f.calls[3].resolve(done())
      const active = f.sessions.getActiveSession(peer.sessionId)
      await waitFor(() => !!active && 'quiescent' in active && active.quiescent)
      await assert.rejects(f.alignment.execute({ kind: 'session', sessionId: peer.sessionId }, 'policy', undefined, undefined,
        { mode: 'optional' }), /controller/)
      await assert.rejects(topics.create({ title: 'Escaping peer', initialMessage: 'Do work' }, peer.sessionId), /descendant Work/)
      await f.sessions.buildSession('virtual:managed-task', { id: peer.sessionId }, {
        mode: 'task', parentSessionId: peer.sessionId, agentType: 'general',
      })
      assert.equal(f.alignment.required('virtual:managed-task'), true)
      assert.deepEqual((await store.getState('virtual:managed-task'))?.workPolicy, f.sessions.getSessionState(peer.sessionId)?.workPolicy)
      await assert.rejects(f.sessions.buildSession('virtual:escaped-task', { id: peer.sessionId }, {
        mode: 'task', parentSessionId: peer.sessionId, workPolicy: { mode: 'optional' },
      }), /cannot remove inherited/)
      await assert.rejects(f.sessions.buildSession('web:escaped-fork', { id: peer.sessionId, index: 0 }), /cannot escape/)
      await f.send('Do a separate small task directly.')
      await waitFor(() => f.calls.length === 5)
      assert.match(String(f.calls[4].messages[0].content), /Work mode: optional/)
      f.calls[4].resolve(call('fixture_write', {}))
      await waitFor(() => f.calls.length === 6)
      assert.equal(f.writes(), 2)
      f.calls[5].resolve(done())
      await waitFor(f.quiet)
    } finally { await f.close(); store.close?.() }
  }))

  test(`${Store.name}: Work completes from an actual file read without looking up physical IDs`, async () => withTempWorkspace(async workspace => {
    const store: SessionStore = new Store(join(workspace, 'sessions'))
    await store.init()
    const f = await fixture(workspace, store)
    f.tools.register(new WriteTool(workspace))
    f.tools.register(new ReadTool(workspace))
    try {
      await f.sessions.prepareCommandSession(id)
      const actor = { kind: 'session' as const, sessionId: id }
      const work = await f.alignment.execute(actor, 'create', undefined, undefined,
        { title: 'Short document', definition, reason: 'Synthetic file request' }) as WorkRecord
      await f.alignment.execute(actor, 'adopt', work.key, work.revision, adoption)
      const sequence = f.alignment.get(work.key).sequence
      await f.send('Write a concise introduction to profile.md, read it back, and finish.')
      await waitFor(() => f.calls.length === 1)
      f.calls[0].resolve(call('write', { path: 'profile.md', content: '# Profile\nA concise introduction.\n' }, 'write-profile'))
      await waitFor(() => f.calls.length === 2)
      assert.match(String(f.calls[1].messages.find(message => message.tool_call_id === 'write-profile')?.content), /Success: write/)
      f.calls[1].resolve(call('read', { path: 'profile.md' }, 'read-profile'))
      await waitFor(() => f.calls.length === 3)
      const prompt = String(f.calls[2].messages.find(message => message.role === 'system')?.content)
      assert.match(prompt, /# Recent tool receipt IDs/)
      assert(prompt.includes('{"id":"read-profile","tool":"read"}'))
      assert.equal(f.calls[2].messages.find(message => message.tool_call_id === 'read-profile')?.content,
        '# Profile\nA concise introduction.\n', 'The model-visible index does not rewrite native tool output')
      f.calls[2].resolve(call('work', { action: 'progress', key: work.key, revision: work.revision,
        data: { expectedSequence: sequence, status: 'done',
          result: { summary: 'The document was saved and read back.', sources: [{ id: 'read-profile', quote: 'A concise introduction.' }] } },
      }, 'complete-profile'))
      await waitFor(() => f.calls.length === 4)
      const receipt = JSON.parse(String(f.calls[3].messages.find(message => message.tool_call_id === 'complete-profile')?.content))
      const evidence = [{ sessionId: id, physicalId: physicalSessionId(f.sessions.getSessionState(id)!),
        kind: 'tool', id: 'read-profile', quote: 'A concise introduction.' }]
      assert.equal(receipt.workflow.status, 'done')
      assert.equal(receipt.sequence, sequence + 1)
      assert.deepEqual(receipt.workflow.result.evidence, evidence)
      assert.equal(Object.hasOwn(receipt.workflow.result, 'sources'), false)
      assert.deepEqual(f.initiatives.workEffects(), [])
      f.calls[3].resolve(done())
      await waitFor(f.quiet)
      const stored = []
      for await (const event of store.readSessionLog(physicalSessionId(f.sessions.getSessionState(id)!))) stored.push(event)
      assert.equal(stored.find(event => event.role === 'tool' && event.tool_call_id === 'read-profile')?.content,
        '# Profile\nA concise introduction.\n', 'Persisted evidence quotes remain unchanged')
      const reopened = new InitiativeStore(workspace)
      try {
        const restored = reopened.workRecords().find(record => record.key === work.key)!
        assert.deepEqual(restored.workflow?.result, receipt.workflow.result)
        assert.equal(restored.workflow?.status, 'done')
      } finally { reopened.close() }
      for (const source of evidence) await f.sessions.validateWorkEvidence({ ...source, kind: 'tool' })
    } finally { await f.close(); store.close?.() }
  }))

  test(`${Store.name}: Work rejects invalid short sources atomically and preserves full evidence support`, async () => withTempWorkspace(async workspace => {
    const store: SessionStore = new Store(join(workspace, 'sessions'))
    await store.init()
    const f = await fixture(workspace, store)
    try {
      await f.sessions.prepareCommandSession(id)
      await f.sessions.prepareCommandSession('web:peer')
      const physicalId = physicalSessionId(f.sessions.getSessionState(id)!)
      await store.appendRawEvents(physicalId, [
        { role: 'tool', tool_call_id: 'own-read', content: 'Read back the saved document.' },
        { role: 'assistant', tool_call_id: 'not-a-receipt', content: 'Invented success' },
      ])
      await store.appendRawEvents(physicalSessionId(f.sessions.getSessionState('web:peer')!),
        [{ role: 'tool', tool_call_id: 'peer-read', content: 'Private peer receipt' }])
      const actor = { kind: 'session' as const, sessionId: id }
      const work = await f.alignment.execute(actor, 'create', undefined, undefined,
        { title: 'Evidence validation', definition, reason: 'Synthetic request' }) as WorkRecord
      await f.alignment.execute(actor, 'adopt', work.key, 1, adoption)
      const before = f.alignment.get(work.key)
      const source = { id: 'own-read', quote: 'saved document' }
      const full = { sessionId: id, physicalId, kind: 'tool' as const, ...source }
      const progress = (result: object, signal?: AbortSignal) => f.alignment.execute(actor, 'progress', work.key, 1,
        { expectedSequence: before.sequence, status: 'done', result: { summary: 'Verified', ...result } }, signal)
      for (const [result, pattern] of [
        [{ evidence: [] }, /result.sources/],
        [{ sources: [] }, /at least 1/],
        [{ sources: [{ id: 'missing', quote: 'saved' }] }, /No tool receipt/],
        [{ sources: [{ id: 'functions.read', quote: 'saved' }] }, /No tool receipt/],
        [{ sources: [{ id: 'peer-read', quote: 'Private peer receipt' }] }, /own segments/],
        [{ sources: [{ id: 'not-a-receipt', quote: 'Invented success' }] }, /No tool receipt/],
        [{ sources: [{ ...source, quote: 'Fabricated success' }] }, /Excerpt does not match/],
        [{ sources: [{ ...source, sessionId: 'web:peer' }] }, /Unrecognized key/],
        [{ sources: Array(9).fill(source) }, /at most 8/],
        [{ sources: Array(8).fill(source), evidence: [full] }, /at most 8 combined/],
        [{ sources: [source], evidence: [{ ...full, physicalId: 'guessed-chat-id' }] }, /segment does not belong/],
      ] as const) {
        await assert.rejects(progress(result), pattern)
        assert.deepEqual(f.alignment.get(work.key), before, 'Failed completion must not mutate Work')
      }
      await assert.rejects(progress({ sources: [source] }, AbortSignal.abort()), { name: 'AbortError' })
      await assert.rejects(f.alignment.execute({ kind: 'user' }, 'progress', work.key, 1,
        { expectedSequence: before.sequence, status: 'done', result: { summary: 'Reviewed', sources: [source] } }), /humans must supply full/)
      await assert.rejects(f.alignment.execute({ kind: 'session', sessionId: 'web:peer' }, 'progress', work.key, 1,
        { expectedSequence: before.sequence, status: 'done', result: { summary: 'Reviewed', sources: [source] } }), /assigned executor/)
      assert.deepEqual(f.alignment.get(work.key), before)
      const completed = await progress({ evidence: [full], sources: [{ ...source, quote: 'Read back' }] }) as WorkRecord
      assert.deepEqual(completed.workflow?.result?.evidence, [full, { ...full, quote: 'Read back' }])
      assert.equal(completed.workflow?.status, 'done')
    } finally { await f.close(); store.close?.() }
  }))

  test(`${Store.name}: caller refinements version acceptance and reach publication without owner impersonation`, async () => withTempWorkspace(async workspace => {
    const store: SessionStore = new Store(join(workspace, 'sessions'))
    await store.init()
    const f = await fixture(workspace, store)
    const service = new MicroApps('fixture', workspace, () => { throw new Error('No app model expected') }, () => 'fixture', {
      ownerSession: sessionId => sessionId, ask: async () => { throw new Error('No approval expected') },
      notify: async () => { throw new Error('No author handoff expected') }, evidence: async () => {},
      work: (sessionId, stamps) => {
        f.alignment.assertCurrent(stamps, sessionId)
        return stamps.map(stamp => {
          const record = f.alignment.get(stamp.key)
          return { key: record.key, revision: record.revision, acceptance: record.definition.acceptance }
        })
      },
    })
    try {
      await service.init()
      await f.sessions.prepareCommandSession(id)
      const actor = { kind: 'session' as const, sessionId: id }
      const work = await f.alignment.execute(actor, 'create', undefined, undefined,
        { title: 'App', definition, reason: 'Interpret incoming task' }) as WorkRecord
      await f.alignment.execute(actor, 'adopt', work.key, 1, adoption)
      f.enableNotifications()
      await f.sessions.deliver(id, { kind: 'message', id: 'caller-refinement', timestamp: new Date().toISOString(), policy: 'queue',
        content: 'Keep incoming input while translation is busy.', replyTo: { channel: 'a2a', chatId: 'fixture' },
        source: { kind: 'user', sender: { channel: 'a2a', chatId: 'fixture', senderId: 'remote', messageId: 'caller-refinement', admin: false } } })
      await waitFor(() => f.calls.length === 1)
      assert.match(JSON.stringify(f.calls[0].messages), /requestQuote is unavailable/)
      f.calls[0].resolve({ content: '', toolCalls: [
        { id: 'refine-and-adopt', name: 'work', arguments: { action: 'adopt', key: work.key, revision: 1,
          data: { ...adoption, acceptance: ['Incoming input remains queued while translation is busy'] } } },
        { id: 'old-basis', name: 'fixture_write', arguments: {} },
      ] })
      await waitFor(() => f.calls.length === 2)
      assert.equal(f.writes(), 0)
      const revised = f.alignment.get(work.key)
      assert.equal(revised.revision, 2)
      assert.equal(revised.adoption?.revision, 2)
      assert.equal(revised.requestSource, undefined)
      assert.match(String(f.calls[1].messages.find(message => message.tool_call_id === 'old-basis')?.content), /basis changed/)
      f.calls[1].resolve(call('fixture_write', {}))
      await waitFor(() => f.calls.length === 3)
      assert.equal(f.writes(), 1)
      f.calls[2].resolve(done())
      await waitFor(f.quiet)
      const directory = join(workspace, 'fixture-app')
      await mkdir(directory)
      await writeFile(join(directory, 'index.html'), '<title>Fixture</title>')
      const app = await service.publish(directory,
        { version: 1, name: 'Fixture', description: 'Fixture only', entry: 'index.html', files: ['index.html'], llm: { maxCalls: 1, maxOutputTokens: 32 } },
        id, AbortSignal.timeout(5000), undefined, undefined, f.alignment.snapshot(id))
      assert.deepEqual(app.work, [{ key: work.key, revision: 2, acceptance: revised.definition.acceptance }])
      assert.equal(app.approval, undefined)
      const history: unknown[] = []
      for await (const row of store.readSessionLog(physicalSessionId(f.sessions.getSessionState(id)!))) history.push(row)
      assert.match(JSON.stringify(history), /Incoming input remains queued/)
      assert.doesNotMatch(JSON.stringify(history), /work-realignment/, 'Atomic adoption does not ask its executor to adopt twice')
    } finally { await service.shutdown(); await f.close(); store.close?.() }
  }))

  test(`${Store.name}: a real normal command failure stays recorded and the author can repair without settle`, async () => withTempWorkspace(async workspace => {
    const store: SessionStore = new Store(join(workspace, 'sessions'))
    await store.init()
    const f = await fixture(workspace, store), manager = new ProcessManager()
    f.tools.register(new ExecTool(workspace, 5000, new CommandHandlerManager(), manager, defaultManagedShell(), f.backgroundTasks))
    try {
      await f.sessions.prepareCommandSession(id)
      const work = await f.alignment.execute({ kind: 'user' }, 'create', undefined, undefined,
        { title: 'Native failure repair', assignee: id, definition, reason: 'Synthetic integration request' }) as WorkRecord
      await f.alignment.execute({ kind: 'session', sessionId: id }, 'adopt', work.key, 1, adoption)
      await f.send('Run the failing check, inspect the result, then repair the fixture.')
      await waitFor(() => f.calls.length === 1)
      f.calls[0].resolve(call('exec', { script: 'exit 7', shell: defaultManagedShell(), cwd: workspace }, 'normal-failure'))
      await waitFor(() => f.calls.length === 2)
      assert.match(JSON.stringify(f.calls[1].messages), /command exited with code 7/)
      const diagnostics = JSON.stringify([
        `Shell: ${defaultManagedShell()}`,
        `Cwd: ${workspace}`,
        '[stdout]', '(empty)',
        '[stderr]', '(empty)',
      ].join('\n')).slice(1, -1)
      assert(JSON.stringify(f.calls[1].messages).includes(diagnostics))
      assert.equal(f.initiatives.workEffects().length, 0)
      f.calls[1].resolve(call('fixture_write', {}, 'repair'))
      await waitFor(() => f.calls.length === 3)
      assert.equal(f.writes(), 1)
      f.calls[2].resolve(done())
      await waitFor(f.quiet)
      const history: unknown[] = []
      for await (const record of store.readSessionLog(physicalSessionId(f.sessions.getSessionState(id)!))) history.push(record)
      assert.match(JSON.stringify(history), /command exited with code 7/)
      assert(JSON.stringify(history).includes(diagnostics))
      assert.ok(f.initiatives.workHistory(work.key).some(event => event.kind === 'tool_result'
        && (event.data as { outcome: string }).outcome === 'returned_error'))
    } finally {
      await f.close()
      for (const managed of manager.list()) await manager.terminate(managed)
      store.close?.()
    }
  }))

  test(`${Store.name}: an authenticated follow-up continues a step-waiting Work without a second approval`, async () => withTempWorkspace(async workspace => {
    const store: SessionStore = new Store(join(workspace, 'sessions'))
    await store.init()
    const f = await fixture(workspace, store)
    const notebook = { objective: 'Deliver a reusable notebook', acceptance: ['Saved text survives reopening'],
      boundaries: ['Publication requires owner approval', 'No device access'], evidence: [] }
    const request = 'Add a Clear button with confirmation; Cancel must keep the saved text.'
    try {
      await f.sessions.prepareCommandSession(id)
      const actor = { kind: 'session' as const, sessionId: id }
      const work = await f.alignment.execute({ kind: 'user' }, 'create', undefined, undefined,
        { title: 'Notebook', assignee: id, definition: notebook, reason: 'Owner request' }) as WorkRecord
      await f.alignment.execute(actor, 'adopt', work.key, 1, adoption)
      await f.alignment.execute(actor, 'progress', work.key, 1,
        { expectedSequence: f.alignment.get(work.key).sequence, status: 'blocked', blockedReason: 'Publication approval pending' })
      await f.send(request)
      await waitFor(() => f.calls.length === 1)
      f.calls[0].resolve({ content: '', toolCalls: [
        { id: 'append-owner-request', name: 'work', arguments: { action: 'update', key: work.key, revision: 1,
          data: { change: 'goal', reason: 'Owner follow-up', requestQuote: request,
            definition: { ...notebook, acceptance: [...notebook.acceptance, 'Clear requires confirmation; Cancel preserves saved text'] } } } },
        { id: 'stale-same-batch-write', name: 'fixture_write', arguments: {} },
      ] })
      await waitFor(() => f.calls.length === 2)
      const changed = f.alignment.get(work.key)
      assert.equal(changed.revision, 2)
      assert.equal(changed.origin, 'agent_interpretation')
      assert.equal(changed.workflow?.status, 'blocked')
      assert.equal(changed.workflow?.blockedScope, 'step')
      assert.equal(changed.proposals?.length ?? 0, 0)
      assert.equal(changed.adoption, undefined)
      assert(changed.requestSource)
      assert.equal(changed.requestSource.quote, request)
      await f.sessions.validateWorkEvidence(changed.requestSource)
      assert.equal(f.writes(), 0)
      assert.match(String(f.calls[1].messages.find(message => message.tool_call_id === 'stale-same-batch-write')?.content),
        /basis changed|not adopted/)
      f.calls[1].resolve(call('work', { action: 'adopt', key: work.key, revision: 2, data: adoption }))
      await waitFor(() => f.calls.length === 3)
      f.calls[2].resolve(call('fixture_write', {}))
      await waitFor(() => f.calls.length === 4)
      assert.equal(f.writes(), 1)
      f.calls[3].resolve(done())
      await waitFor(f.quiet)

      await f.sessions.prepareCommandSession('web:peer')
      const sender = { channel: 'web', chatId: 'worker', messageId: 'fixture', senderId: 'owner', admin: true }
      const inputs: SessionInput[] = [
        { kind: 'message', id: 'a2a-followup', timestamp: new Date().toISOString(), policy: 'queue', content: request,
          source: { kind: 'user', sender: { ...sender, channel: 'a2a', admin: false } } },
        { kind: 'message', id: 'peer-followup', timestamp: new Date().toISOString(), policy: 'queue', content: request,
          source: { kind: 'session', sessionId: 'web:peer' } },
        { kind: 'message', id: 'event-followup', timestamp: new Date().toISOString(), policy: 'queue', content: request,
          source: { kind: 'event', eventId: 'untrusted-event', type: 'fixture', source: 'external' } },
        { kind: 'control', id: 'owner-retry', timestamp: new Date().toISOString(), command: { type: 'retry' },
          source: { kind: 'user', sender } },
      ]
      for (const input of inputs) {
        const index = f.calls.length
        await f.sessions.deliver(id, input, llm)
        await waitFor(() => f.calls.length === index + 1)
        f.calls[index].resolve(call('work', { action: 'update', key: work.key, revision: 2,
          data: { change: 'goal', reason: 'Attempt to reuse earlier owner text', requestQuote: request,
            definition: { ...changed.definition, acceptance: [...changed.definition.acceptance, 'Unrequested extra feature'] } } }))
        await waitFor(() => f.calls.length === index + 2)
        const result = f.calls[index + 1].messages.filter(message => message.role === 'tool').at(-1)
        assert.match(String(result?.content), /current authenticated owner input/, input.id)
        assert.equal(f.alignment.get(work.key).revision, 2)
        f.calls[index + 1].resolve(done())
        await waitFor(f.quiet)
      }
      const reopened = new InitiativeStore(workspace)
      try {
        const restored = reopened.workRecords().find(record => record.key === work.key)!
        assert.deepEqual(restored.requestSource, changed.requestSource)
        assert.equal(restored.workflow?.blockedScope, 'step')
        assert.equal(restored.adoption?.revision, 2)
      } finally { reopened.close() }
    } finally { await f.close(); store.close?.() }
  }))

  test(`${Store.name}: a Work-blocking batch still completes and records browser cleanup`, async () => withTempWorkspace(async workspace => {
    const store: SessionStore = new Store(join(workspace, 'sessions'))
    await store.init()
    const f = await fixture(workspace, store)
    const closed: string[] = []
    const browser = new BrowserSetupTool(async request => {
      assert.equal(request.action, 'close')
      assert.equal(f.alignment.context(id).records[0].workflow?.status, 'blocked')
      if (request.action !== 'close') throw new Error('Only closing the existing fixture instance is expected')
      closed.push(request.instance)
      return JSON.stringify({ instance: request.instance, closed: true })
    })
    f.tools.register(new InvokeTool(new ImportTool(new Map([['browser_setup', browser]]), workspace)))
    try {
      await f.sessions.prepareCommandSession(id)
      const actor = { kind: 'session' as const, sessionId: id }
      const work = await f.alignment.execute(actor, 'create', undefined, undefined,
        { title: 'Cleanup after review gate', definition, reason: 'Synthetic request' }) as WorkRecord
      await f.alignment.execute(actor, 'adopt', work.key, work.revision, adoption)
      const sequence = f.alignment.get(work.key).sequence
      await f.send('Report the approval blocker and release the preview browser')
      await waitFor(() => f.calls.length === 1)
      f.calls[0].resolve({ content: '', toolCalls: [
        { id: 'block-work', name: 'work', arguments: { action: 'progress', key: work.key, revision: work.revision,
          data: { expectedSequence: sequence, status: 'blocked', blockedReason: 'Waiting for owner review', blockedScope: 'work' } } },
        { id: 'close-preview', name: 'invoke_tool', arguments: { name: 'browser_setup', args: { action: 'close', instance: 'owned-fixture' } } },
      ] })
      await waitFor(() => f.calls.length === 2)
      assert.match(String(f.calls[1].messages.find(message => message.role === 'tool' && message.tool_call_id === 'close-preview')?.content), /"closed":true/)
      assert.deepEqual(closed, ['owned-fixture'])
      assert.equal(f.alignment.get(work.key).workflow?.status, 'blocked')
      assert.deepEqual(f.initiatives.workEffects(), [])
      f.calls[1].resolve(done())
      await waitFor(f.quiet)
      await f.sessions.validateWorkEvidence({
        sessionId: id, physicalId: physicalSessionId(f.sessions.getSessionState(id)!),
        kind: 'tool', id: 'close-preview', quote: '"closed":true',
      })
    } finally { await f.close(); store.close?.() }
  }))

  test(`${Store.name}: failed Work effects expose persisted, verifiable tool-result references`, async () => withTempWorkspace(async workspace => {
    const store: SessionStore = new Store(join(workspace, 'sessions'))
    await store.init()
    const f = await fixture(workspace, store)
    const failure = 'Error: fixture failure after partial work'
    f.tools.register({ name: 'fixture_failure', description: '', parameters: { type: 'object', properties: {} },
      async execute() { return failure } })
    try {
      await f.sessions.prepareCommandSession(id)
      const actor = { kind: 'session' as const, sessionId: id }
      const work = await f.alignment.execute(actor, 'create', undefined, undefined,
        { title: 'Failure recovery', definition, reason: 'Synthetic request' }) as WorkRecord
      await f.alignment.execute(actor, 'adopt', work.key, work.revision, adoption)
      await f.send('Attempt the bounded operation')
      await waitFor(() => f.calls.length === 1)
      f.calls[0].resolve(call('fixture_failure', {}, 'failure-call'))
      await waitFor(() => f.calls.length === 2)
      const effect = f.alignment.context(id).effects[0]
      assert.equal(effect.status, 'unknown')
      const currentPrompt = String(f.calls[1].messages[0].content)
      assert.match(currentPrompt, /Unresolved Work effects \(1; showing 1\)/)
      assert.ok(currentPrompt.includes(effect.id), 'Next inference sees the live effect before attempting another write')
      assert.match(currentPrompt, /failure-call/)
      assert.deepEqual(effect.resultSource, {
        sessionId: id, physicalId: physicalSessionId(f.sessions.getSessionState(id)!), kind: 'tool', id: 'failure-call',
      })
      assert(effect.resultSource)
      const evidence = { ...effect.resultSource, quote: failure }
      await f.sessions.validateWorkEvidence(evidence)
      assert.deepEqual(await f.sessions.resolveToolEvidence(id, [{ id: evidence.id, quote: failure }], AbortSignal.timeout(5000)), [evidence])
      await assert.rejects(f.sessions.validateWorkEvidence({ ...evidence, quote: 'Invented successful output' }), /quote|source|excerpt/i)
      const reopened = new InitiativeStore(workspace)
      try {
        const recovered = new WorkAlignment(reopened, {
          state: target => f.sessions.getSessionState(target),
          evidence: source => f.sessions.validateWorkEvidence(source),
          changed: async () => {}, fresh: async () => {}, successor: async () => undefined,
        })
        assert.deepEqual(recovered.context(id).effects[0].resultSource, effect.resultSource)
        assert.equal(recovered.context(id).effects[0].status, 'unknown', 'Reading a source reference does not settle an effect')
      } finally { reopened.close() }
      await f.alignment.execute(actor, 'settle', work.key, work.revision, { effectId: effect.id, evidence })
      assert.equal(f.alignment.context(id).effects.length, 0)
      assert.doesNotMatch(f.alignment.prompt(id), /# Unresolved Work effects/)
      f.calls[1].resolve(done())
      await waitFor(f.quiet)
    } finally { await f.close(); store.close?.() }
  }))

  test(`${Store.name}: GitHub follow-up uses real silent/queue admission and cached tool evidence without approving Work`, async () => withTempWorkspace(async workspace => {
    const store: SessionStore = new Store(join(workspace, 'sessions'))
    await store.init()
    const f = await fixture(workspace, store), remote = await createGitHubFixture(join(workspace, 'github-fixture'))
    const github = new GitHubService(new GitHubStore(workspace), remote.client, {
      alignment: f.alignment, durableSession: target => f.sessions.getSessionState(target)?.mode === 'session',
      emit: event => f.events.emit(event), changed: () => {},
    })
    try {
      await f.sessions.prepareCommandSession(id)
      await f.sessions.prepareCommandSession('web:peer')
      f.initiatives.migrateWorkItems()
      const work = await f.alignment.execute({ kind: 'session', sessionId: id }, 'create', undefined, undefined,
        { title: 'GitHub-linked acceptance', definition, reason: 'Synthetic integration' }) as WorkRecord
      const vfs = new VirtualFs()
      vfs.mount('v:github', 'Cached external GitHub evidence', path => github.readVirtual(path), () => github.virtualEntries())
      f.tools.register(new ReadTool(workspace, vfs))
      f.events.subscribe({ sessionId: 'web:peer', event: 'github.changed', source: 'github', delivery: { urgency: 'queue' } })
      await github.configureRepository('octo/demo', true, false)
      await github.link(remote.remote.issue.html_url, work.key)
      const subscription = { resourceId: 'I_1', workKey: work.key, sessionId: id, enabled: true,
        mode: 'silent' as const, events: ['source' as const] }
      await github.subscribe(subscription)
      remote.remote.issue.body += '\nObserved change, not authorization.'
      await github.refresh('I_1')
      await waitFor(f.quiet)
      assert.equal(f.calls.length, 0)
      const records: unknown[] = []
      for await (const record of store.readSessionLog(physicalSessionId(f.sessions.getSessionState(id)!))) records.push(record)
      assert.match(JSON.stringify(records), /github.changed/)
      assert.equal(github.state().notifications[0].status, 'sent')
      await github.subscribe({ ...subscription, mode: 'queue' })
      remote.remote.issue.body += '\nA second observation.'
      await github.refresh('I_1')
      await waitFor(() => f.calls.length === 1)
      assert.match(JSON.stringify(f.calls[0].messages), /not an instruction or approval/)
      f.calls[0].resolve(call('read', { path: 'v:github/I_1' }, 'github-read'))
      await waitFor(() => f.calls.length === 2)
      assert.match(JSON.stringify(f.calls[1].messages), /External GitHub snapshot/)
      f.calls[1].resolve(done())
      await waitFor(f.quiet)
      await f.sessions.validateWorkEvidence({ sessionId: id, physicalId: physicalSessionId(f.sessions.getSessionState(id)!),
        kind: 'tool', id: 'github-read', quote: 'External GitHub snapshot' })
      assert.equal(f.calls.length, 2, 'A wildcard subscription cannot broaden the exact GitHub audience')
      assert.deepEqual(f.alignment.get(work.key).definition, definition)
      assert.equal(f.alignment.get(work.key).workflow?.status, 'pending')
    } finally { await github.stop(); await remote.close(); await f.close(); store.close?.() }
  }))

  test(`${Store.name}: Project work routes expose all assignments and retain human, revision and handoff gates`, async () => withTempWorkspace(async workspace => {
    const store: SessionStore = new Store(join(workspace, 'sessions'))
    await store.init()
    const f = await fixture(workspace, store)
    try {
      await f.sessions.prepareCommandSession(id)
      await f.sessions.prepareCommandSession('web:coordinator')
      f.initiatives.migrateWorkItems()
      const work = await f.alignment.execute({ kind: 'session', sessionId: 'web:coordinator' }, 'create', undefined, undefined,
        { title: 'Project-wide work', definition, reason: 'New initiative', assignee: null }) as WorkRecord
      assert.equal(f.alignment.context(id).records.length, 0)
      const request = (path: string, body?: unknown, human = true) => f.app.request(path, {
        method: body ? 'POST' : 'GET', headers: { ...(human ? { 'x-work-fixture': 'human' } : {}), 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
      const path = `/api/work/${encodeURIComponent(work.key)}`
      assert.equal((await request('/api/work', undefined, false)).status, 401)
      assert.equal((await request(path, undefined, false)).status, 401)
      const overview = await request('/api/work')
      assert.equal(overview.headers.get('cache-control'), 'no-store')
      const first = projectWorkOverviewSchema.parse(await overview.json())
      assert.equal(first.items.length, 1)
      assert.equal(first.items[0].assignee, null)
      assert.equal(first.items[0].manager, 'web:coordinator')
      assert.equal(first.items[0].status, 'pending')
      assert.equal(f.calls.length, 0, 'Viewing the workbench never starts a coordinator turn')
      const action = { action: 'assign', key: work.key, revision: 1, data: { expectedSequence: 1, assignee: id } }
      assert.equal((await request(path, action, false)).status, 401)
      assert.equal((await request(path, { ...action, key: 'work:foreign' })).status, 400)
      assert.equal((await request('/api/work/work%3Aforeign')).status, 404)
      const assigned = await request(path, action)
      assert.equal(assigned.status, 200, await assigned.text())
      assert.equal((await request(path, action)).status, 409, 'Stale assignment sequence is rejected')
      const current = f.alignment.get(work.key)
      const steal = { ...action, data: { expectedSequence: current.sequence, assignee: 'web:coordinator' } }
      assert.equal((await request(path, steal)).status, 409, 'A board cannot steal an assignment')
      const effectId = crypto.randomUUID()
      f.initiatives.startWorkEffect(effectId, id, 'fixture_write', [{ key: work.key, revision: 1 }])
      f.initiatives.finishWorkEffect(effectId, true)
      const next = projectWorkOverviewSchema.parse(await (await request('/api/work')).json())
      assert.equal(next.items[0].assignee, id)
      assert.deepEqual(next.effects[0].workKeys, [work.key])
      assert.equal(next.effects[0].status, 'unknown')
      assert.equal((await request(path, { action: 'progress', key: work.key, revision: 1,
        data: { expectedSequence: current.sequence, status: 'done', result: { summary: 'Checked', evidence: [] } } })).status, 409)
      const settled = await request(path, { action: 'settle', key: work.key, revision: 1, data: { effectId } })
      assert.equal(settled.status, 200, await settled.text())
      const detail = await (await request(path)).json()
      assert.equal(detail.records[0].key, work.key)
      assert.ok(detail.records[0].history.length)
    } finally { await f.close(); store.close?.() }
  }))

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

  for (const surface of ['ask', 'work', 'project', 'acceptance-harness']) test(`${Store.name}: one ${surface} approval applies the exact work proposal and settles Ask`, async () => withTempWorkspace(async workspace => {
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
      const overview = projectWorkOverviewSchema.parse(await (await f.app.request('/api/work', { headers: { 'x-work-fixture': 'human' } })).json())
      assert.deepEqual(overview.requests.map(item => item.id), [request.id])
      assert.deepEqual(overview.requests[0].workKeys, [work.key])
      assert.equal(request.defaultOption, WORK_REJECT)
      assert.equal(request.workProposal?.definition.objective, 'Both outcomes with documentation')
      assert.throws(() => f.sessions.yields.reviseUser(id, request.id,
        { question: 'Different proposal?', options: ['Yes', 'No'], defaultOption: 'No', brief: decisionBrief }, 'Change goal', id), /cannot be rewritten/)
      await f.alignment.execute({ kind: 'session', sessionId: id }, 'propose', work.key, 1,
        { change: 'understanding', definition, reason: 'Alternative, not an applied change', paused: false })
      assert.equal(f.sessions.yields.get(id)?.id, request.id, 'A pending proposal must not invalidate another question')
      const projectPath = `/api/work/${encodeURIComponent(work.key)}`
      const approval = surface === 'acceptance-harness'
        ? acceptanceWorkApproval({ key: work.key, revision: 1, proposalId: proposed.proposalId },
          await (await f.app.request(projectPath, { headers: { 'x-work-fixture': 'human' } })).json())
        : { action: 'apply_proposal', key: work.key, revision: 1, data: { proposalId: proposed.proposalId } }
      if (surface === 'acceptance-harness') {
        await assert.rejects(f.alignment.execute({ kind: 'session', sessionId: id },
          approval.action, approval.key, approval.revision, approval.data), /authenticated human/)
        assert.equal((await f.app.request(projectPath, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(approval),
        })).status, 401)
        assert.equal(f.alignment.get(work.key).revision, 1)
      }
      const response = surface === 'ask' ? await f.post({ requestId: request.id, option: WORK_APPROVE }, 'ask')
        : surface === 'project' || surface === 'acceptance-harness' ? await f.app.request(projectPath, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-work-fixture': 'human' },
          body: JSON.stringify(approval),
        })
        : await f.post({ action: 'apply_proposal', key: work.key, revision: 1, data: { proposalId: proposed.proposalId } })
      assert.equal(response.status, 200, await response.text())
      await waitFor(() => f.calls.length === 2)
      assert.equal(projectWorkOverviewSchema.parse(await (await f.app.request('/api/work', { headers: { 'x-work-fixture': 'human' } })).json()).requests.length, 0)
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
