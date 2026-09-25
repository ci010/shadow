import { requireToolText } from '../tools/tool.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { Hono } from 'hono'
import { Bus } from '../bus/bus.ts'
import { SessionTools, Tools } from '../tools/registry.ts'
import { CronAddTool, CronListTool, registerCronTools } from '../tools/cron.ts'
import { ImportTool } from '../tools/load-tool.ts'
import { InvokeTool } from '../tools/invoke-tool.ts'
import { SearchTool } from '../tools/search.ts'
import { VirtualFs } from '../vfs/virtual-fs.ts'
import { LearningService } from '../agent/learning/service.ts'
import { createProjectScope } from '../projects/scope.ts'
import { createLearnCommand } from '../slash-commands/handlers/learn.ts'
import { learningTask, triggerReflectorFlush } from '../agent/learning/pipelines.ts'
import type { ExecutionContext } from '../tools/context.ts'
import type { ChatMessage, LLMProvider, LLMResponse } from '../providers/provider.ts'
import { SessionManager, type SessionManagerDeps } from '../sessions/session-manager.ts'
import type { SessionState, SessionStore } from '../sessions/session-store.ts'
import { JsonlSessionStore } from '../sessions/session-store-jsonl.ts'
import { SqliteSessionStore } from '../sessions/session-store-sqlite.ts'
import { sessionsApiPlugin } from '../sessions/routes.ts'
import type { SessionMessageInput } from '../sessions/input.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { CronService, cronContextMode } from './service.ts'
import { CronDispatcher } from './dispatch.ts'
import { registerAutomationRoutes } from './routes.ts'
import { LEARNING_AUTOMATIONS, resolveAutomationSession } from './contracts.ts'

const input = (content: string): SessionMessageInput => ({
  kind: 'message', id: crypto.randomUUID(), timestamp: new Date().toISOString(), content, policy: 'queue',
  source: { kind: 'event', eventId: crypto.randomUUID(), type: 'cron-tick', source: 'cron' },
})
const wait = () => new Promise<void>(resolve => setImmediate(resolve))
async function until(check: () => boolean) {
  const deadline = Date.now() + 5000
  while (!check()) { assert(Date.now() < deadline, 'fixture timed out'); await wait() }
}
function fixture(workspace: string, store: SessionStore, settings: { remoteOnline?: boolean } = {}) {
  const bus = new Bus()
  const requests: Array<{ sessionId: string; messages: ChatMessage[]; signal: AbortSignal }> = []
  const provider: LLMProvider = {
    name: 'fixture', listModels: () => ['fixture'],
    async chat(messages, _tools, options) {
      const request = { sessionId: JSON.parse(String(messages[0].content)).sessionId, messages: structuredClone(messages), signal: options!.signal! }
      requests.push(request)
      if (JSON.stringify(messages.at(-1)?.content).includes('hold')) {
        return await new Promise<LLMResponse>((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })
          if (request.signal.aborted) reject(request.signal.reason)
        })
      }
      return { content: `response-${requests.length}`, toolCalls: [] }
    },
  }
  const manager = new SessionManager({
    workspace, store, bus, provider, tools: new Tools(workspace),
    projectId: 'org-a', ownsFolder: (id: string) => id === 'folder-a',
    ownsWorkdir: (ref: { capabilityId: string }) => ref.capabilityId !== 'foreign',
    workdirCapabilityLookup: () => ({ node: settings.remoteOnline === false ? 'offline' : 'online', capability: { kind: 'workdir', online: true } }),
    remoteExecutor: { execute: () => { throw new Error('Unexpected remote tool execution') } },
    agentTypes: { resolve: (name: string) => ['general', 'reader', 'reflector', 'encapsulator', 'soul-reflector'].includes(name)
      ? { name, description: '', prompt: '', source: 'builtin', defaultMode: 'session',
        ...(name === 'reader' ? { allowedTools: ['read'] } : {}) } : undefined },
    handoffManager: { shouldHandoff: () => false },
    context: { buildSystemPrompt: async (ctx: unknown) => JSON.stringify(ctx) },
    getLlmRuntimeConfig: () => ({ model: 'fixture', contextWindow: 128000, temperature: 0 }),
  } as unknown as SessionManagerDeps)
  const events: string[] = []
  const invalidations: Array<string | undefined> = []
  const dispatcher = new CronDispatcher(manager, async (job, sessionId, signal) => {
    signal.throwIfAborted()
    events.push(sessionId)
    await manager.deliver(sessionId, input(job.task ?? 'tick'))
  }, id => invalidations.push(id))
  const cron = new CronService(workspace)
  cron.setHandler(async (job, signal) => { await dispatcher.dispatch(job, signal) })
  cron.setOnChanged(() => invalidations.push(undefined))
  const app = new Hono()
  registerAutomationRoutes(app, cron, manager, 'org-a')
  sessionsApiPlugin(manager)(app)
  return { manager, cron, dispatcher, app, requests, events, invalidations, bus }
}

for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  test(`${Store.name}: existing self/peer and fresh ticks preserve context and persist immutable run metadata`, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      const f = fixture(workspace, store)
      try {
        await f.manager.start()
        await f.cron.start()
        const workdir = { version: 1 as const, nodeId: 'remote-a', capabilityId: 'folder-a', displayPathSnapshot: 'Z:\\not-on-main' }
        await f.manager.buildSession('web:origin', undefined, { folderId: 'folder-a', initiativeId: 'work', workdir })
        await f.manager.deliver('web:origin', input('PARENT TRANSCRIPT SENTINEL'))
        await until(() => f.manager.getSessionState('web:origin')?.executionStatus === 'completed')
        await f.manager.buildSession('web:peer', undefined, { agentType: 'reader' })
        const tool = new CronAddTool(f.cron, f.manager, name => name === 'general')
        const ctx = { sessionId: 'web:origin', signal: new AbortController().signal } as ExecutionContext
        for (const options of [{}, { session: 'existing', targetSessionId: 'web:peer' }, { session: 'fresh' }]) {
          assert.match(await tool.execute({
            schedule: 'every 1h', task: `task-${options.session ?? 'existing'}`, name: 'Useful name', ...options,
          }, ctx), /Created job/)
        }
        const jobs = f.cron.listJobs()
        assert.deepEqual(jobs.map(cronContextMode), ['existing', 'existing', 'fresh'])
        assert(jobs.every(job => job.originSessionId === 'web:origin'))
        assert(jobs.every(job => !Object.hasOwn(job, 'isolated')))
        assert.match(await new CronListTool(f.cron).execute({}, ctx), /web:peer \(existing\)/)
        for (let run = 0; run < 2; run++) {
          for (const job of jobs) {
            await f.cron.runNow(job.id)
            if (job.session !== 'fresh') {
              const target = job.target!.sessionId
              await until(() => f.manager.getSessionState(target)?.executionStatus === 'completed')
            }
          }
        }
        assert.deepEqual(f.events, ['web:origin', 'web:peer', 'web:origin', 'web:peer'])
        const fresh = f.manager.listSessions().map(row => f.manager.getSessionState(row.sessionId)!).filter(s => s.automation)
        assert.equal(fresh.length, 2)
        assert.notEqual(fresh[0].automation!.runId, fresh[1].automation!.runId)
        for (const state of fresh) {
          assert.equal(state.sessionId, `cron:${state.automation!.runId}`)
          assert.equal(state.projectId, 'org-a')
          assert.equal(state.mode, 'task')
          assert.equal(state.executionStatus, 'completed')
          assert.equal(state.parent, undefined)
          assert.equal(state.parentSessionId, null)
          assert.equal(state.workspaceRoot, 'web:origin')
          assert.equal(state.folderId, 'folder-a')
          assert.deepEqual(state.workdir, workdir)
          assert.equal(state.automation!.config!.task, 'task-fresh')
          const request = f.requests.find(r => r.sessionId === state.sessionId)!
          assert.equal(JSON.stringify(request.messages).includes('PARENT TRANSCRIPT SENTINEL'), false)
          assert.deepEqual(JSON.parse(String(request.messages[0].content)).workdir, workdir)
          assert.deepEqual((await store.getState(state.sessionId))!.automation, state.automation)
        }
        const peerRequests = f.requests.filter(r => r.sessionId === 'web:peer')
        assert(peerRequests[1].messages.some(m => m.role === 'assistant'))
        assert.equal(JSON.stringify(peerRequests).includes('PARENT TRANSCRIPT SENTINEL'), false)
        const peerPrompt = JSON.parse(String(peerRequests[0].messages[0].content))
        assert.equal(peerPrompt.agent.name, 'reader')
        assert.deepEqual(peerPrompt.agent.allowedTools, ['read'])
        assert.equal(peerPrompt.workdir, undefined)
        assert.equal(f.manager.getSessionState('web:peer')!.automation, undefined)
        jobs[2].task = 'Mutated client copy'
        assert.equal(f.cron.listJobs()[2].task, 'task-fresh')
        const graph = await (await f.app.request('/api/sessions/graph')).json()
        assert.equal(graph.sessions.filter((s: SessionState) => s.automation).length, 2)
        assert.equal(f.invalidations.length >= 5, true)
        await f.cron.stop()
        await f.manager.stop()
        await f.manager.start()
        await f.cron.start()
        assert.deepEqual(f.manager.getSessionState(fresh[0].sessionId)!.automation, fresh[0].automation)
        assert.equal(f.cron.listJobs()[1].target!.sessionId, 'web:peer')
        assert.equal(f.cron.listJobs()[2].session, 'fresh')
        await f.cron.runNow(jobs[1].id)
        await until(() => f.manager.getSessionState('web:peer')?.executionStatus === 'completed')
        assert.equal(f.requests.filter(r => r.sessionId === 'web:peer').length, 3)
      } finally { await f.cron.stop(); await f.manager.stop(); store.close?.() }
    })
  })

  test(`${Store.name}: split cron tools are dynamically discoverable and validate only their own arguments`, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      const f = fixture(workspace, store)
      const base = new Tools(workspace)
      const importer = new ImportTool(new Map(), workspace)
      registerCronTools(importer, f.cron, f.manager, name => name === 'general')
      base.register(new InvokeTool(importer))
      const vfs = new VirtualFs()
      vfs.mount('v:tools', 'Tools', (path, ctx) => importer.readVirtual(path, ctx), (ctx, options) => importer.virtualEntries(ctx, options))
      base.register(new SearchTool(workspace, undefined, vfs))
      const tools = new SessionTools(base, workspace)
      const ctx = { tools, sessionId: 'web:source', projectId: 'org-a', signal: new AbortController().signal } as ExecutionContext
      const invoke = (name: string, args: Record<string, unknown>) => tools.execute('invoke_tool', { name, args }, ctx)
      try {
        await f.manager.start()
        await f.cron.start()
        await f.manager.buildSession('web:source')
        await f.manager.buildSession('web:target')
        const names = ['cron_add', 'cron_list', 'cron_remove']
        assert.deepEqual(tools.activeDynamicTools(), [])
        assert.equal(await invoke('cron_list', {}), 'No scheduled jobs.')
        for (const space of ['glob:v:tools', 'glob:v:tools/cron']) {
          const result = requireToolText(await tools.execute('search', { space, query: '**/cron_*' }, ctx))
          assert.doesNotMatch(result, /Warning:/)
          const paths = result.split('\n')
          const contracts = (await Promise.all(paths.map(async path => JSON.parse((await vfs.resolve(path, ctx))!))))
            .filter(tool => tool.parameters)
          assert.deepEqual([...new Set(contracts.map(tool => tool.name))].sort(), names)
          assert(contracts.every(tool => !Object.hasOwn(tool.parameters.properties, 'action')))
        }
        assert(!tools.getDefinitions().some(tool => tool.function.name.startsWith('cron')))
        assert.equal(f.cron.listJobs().length, 0)
        for (const [name, args] of [
          ['cron_add', {}],
          ['cron_add', { action: 'add', schedule: 'every 1h', task: 'tick' }],
          ['cron_add', { schedule: 'every 1h', task: 'tick', session: 'isolated' }],
          ['cron_list', { schedule: 'every 1h' }],
          ['cron_remove', {}],
          ['cron_remove', { id: 'any', task: 'tick' }],
        ] as const) assert.match(requireToolText(await invoke(name, args)), /invalid arguments/)
        assert.equal(f.cron.listJobs().length, 0)
        const args = { schedule: 'every 1h', task: 'tick', targetSessionId: 'web:target' }
        assert.match(requireToolText(await invoke('cron_add', args)), /Created job/)
        const job = f.cron.listJobs()[0]
        assert.match(requireToolText(await invoke('cron_list', {})), new RegExp(job.id))
        tools.resetDynamic()
        assert.equal(await invoke('cron_remove', { id: job.id }), `Removed job ${job.id}`)
        assert(f.manager.getSessionState('web:target'))
        assert.equal(await invoke('cron_list', {}), 'No scheduled jobs.')
        assert.match(requireToolText(await invoke('cron', { action: 'add', ...args })), /^Error:/)
        assert.equal(f.cron.listJobs().length, 0)

        assert.match(requireToolText(await invoke('cron_add', { ...args, once: true })), /Created job/)
        await f.cron.runNow(f.cron.listJobs()[0].id)
        await until(() => f.manager.getSessionState('web:target')?.executionStatus === 'completed')
        assert.equal(f.cron.listJobs().length, 0)
        assert(f.manager.getSessionState('web:target'))
        await f.cron.flush()
        assert.deepEqual(JSON.parse(await readFile(join(workspace, '.cron', 'jobs.json'), 'utf8')).jobs, [])
      } finally { tools.resetDynamic(); await f.cron.stop(); await f.manager.stop(); store.close?.() }
    })
  })

  test(`${Store.name}: existing targets are authorized before saving and rechecked before each tick`, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      const f = fixture(workspace, store)
      try {
        await f.manager.start()
        await f.cron.start()
        await f.manager.buildSession('web:source')
        await f.manager.buildSession('web:target')
        await f.manager.buildSession('web:reader', undefined, { agentType: 'reader' })
        await f.manager.buildSession('cron:task', undefined, { mode: 'task' })
        const tool = new CronAddTool(f.cron, f.manager, name => name === 'general')
        const ctx = { sessionId: 'web:source', projectId: 'org-a', signal: new AbortController().signal } as ExecutionContext
        const add = { schedule: 'every 1h', task: 'tick', targetSessionId: 'web:target' }
        await assert.rejects(tool.execute({ ...add, targetSessionId: 'web:missing' }, ctx), /must already exist/)
        assert.equal(f.manager.getSessionState('web:missing'), null)
        await assert.rejects(tool.execute({ ...add, targetSessionId: 'cron:task' }, ctx), /durable/)
        await assert.rejects(tool.execute(add, { ...ctx, sessionId: 'cron:task' }), /durable/)
        await assert.rejects(tool.execute(add, { ...ctx, sessionId: 'web:reader' }), /permission to message/)
        assert.match(await tool.execute(add, { ...ctx, projectId: 'other' }), /another Project/)
        const target = f.manager.getSessionState('web:target')!
        target.projectId = 'other'
        await assert.rejects(tool.execute(add, ctx), /this Project/)
        target.projectId = 'org-a'
        for (const args of [
          { urgency: 'invalid' }, { debounce_ms: 10 }, { urgency: 'debounce', debounce_ms: 0 },
          { urgency: 'debounce', debounce_ms: Infinity },
          { session: 'fresh', targetSessionId: undefined, urgency: 'silent' },
          { session: 'fresh', targetSessionId: undefined, debounce_ms: 10 },
        ]) assert.match(await tool.execute({ ...add, ...args }, ctx), /^Error:/)
        assert.equal(f.cron.listJobs().length, 0)

        for (const urgency of ['queue', 'steering', 'debounce', 'silent']) {
          assert.match(await tool.execute({ ...add, urgency, ...(urgency === 'debounce' ? { debounce_ms: 42 } : {}) }, ctx), /Created job/)
        }
        assert.deepEqual(f.cron.listJobs().map(job => job.event?.delivery), [
          { urgency: 'queue' }, { urgency: 'steering' }, { urgency: 'debounce', debounceMs: 42 }, { urgency: 'silent' },
        ])
        const job = f.cron.listJobs()[0]
        const source = f.manager.getSessionState('web:source')!
        source.agentType = 'reader'
        await assert.rejects(f.dispatcher.dispatch(job, ctx.signal), /permission to message/)
        source.agentType = 'general'
        target.projectId = 'other'
        await assert.rejects(f.dispatcher.dispatch(job, ctx.signal), /this Project/)
        target.projectId = 'org-a'
        target.mode = 'task'
        await assert.rejects(f.dispatcher.dispatch(job, ctx.signal), /durable/)
        target.mode = 'session'
        assert.deepEqual(f.events, [])
        await f.dispatcher.dispatch(job, ctx.signal)
        await until(() => target.executionStatus === 'completed')
        assert.deepEqual(f.events, ['web:target'])
        await f.manager.deleteSession('web:target')
        await assert.rejects(f.dispatcher.dispatch(job, ctx.signal), /must already exist/)
        assert.equal(f.manager.getSessionState('web:target'), null)
        await f.manager.buildSession('web:target')
        await f.manager.deleteSession('web:source')
        await assert.rejects(f.dispatcher.dispatch(job, ctx.signal), /must already exist/)
        assert.equal(f.events.length, 1)
      } finally { await f.cron.stop(); await f.manager.stop(); store.close?.() }
    })
  })

  test(`${Store.name}: scoped read-only automation API paginates historical runs and narrowly migrates legacy addresses`, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      const legacy = 'heartbeat:reflector-1750000000000'
      for (const job of Object.values(LEARNING_AUTOMATIONS)) {
        const sessionId = `heartbeat:${job.agentType}-1750000000000`
        await store.saveState(sessionId, { sessionId, segmentIndex: 0, agentType: job.agentType })
      }
      await store.saveState('web:not-legacy', { sessionId: 'web:not-legacy', segmentIndex: 0, agentType: 'reflector', description: 'Self reflection' })
      const f = fixture(workspace, store)
      try {
        await f.manager.start()
        await f.cron.start()
        const migrated = await store.getState(legacy)
        assert.equal(migrated!.automation!.jobId, 'learning:reflector')
        assert.equal(migrated!.automationVersion, 1)
        assert.equal(f.manager.getSessionState('web:not-legacy')!.automation, undefined)
        const graph = await (await f.app.request('/api/sessions/graph')).json()
        for (const job of Object.values(LEARNING_AUTOMATIONS)) {
          const row = graph.sessions.find((row: { sessionId: string }) => row.sessionId === `heartbeat:${job.agentType}-1750000000000`)
          assert.equal(row.automation.jobId, job.id)
          assert.equal(row.automation.contextMode, 'fresh')
          assert.equal(row.automation.config.source, 'learning')
          assert.equal(row.automation.legacy, true)
        }
        await f.manager.buildSession('heartbeat:reflector-1750000000001', undefined, { agentType: 'reflector' })
        assert.equal(resolveAutomationSession(f.manager.getSessionState('heartbeat:reflector-1750000000001')!), undefined)
        const jobId = f.cron.addJob({ schedule: 'every 1h', name: 'Scheduled job', task: 'work', session: 'fresh' })
        f.cron.addJob({ schedule: 'every 1h', task: 'not listed', session: 'existing', target: { sessionId: 'web:not-legacy' } })
        const neverRun = f.cron.addJob({ schedule: 'every 1h', name: 'No runs yet', task: 'new', session: 'fresh', enabled: false })
        for (let i = 0; i < 3; i++) await f.cron.runNow(jobId)
        const all = await (await f.app.request(`/api/automations/${jobId}/runs`)).json()
        assert.equal(all.total, 3)
        assert(all.runs.every((run: { status: string }) => run.status === 'completed'))
        const page = await (await f.app.request(`/api/automations/${jobId}/runs?offset=1&limit=1`)).json()
        assert.deepEqual(page, { runs: [all.runs[1]], total: 3, offset: 1 })
        const exhausted = await (await f.app.request(`/api/automations/${jobId}/runs?offset=100`)).json()
        assert.deepEqual(exhausted, { runs: [], total: 3, offset: 100 })
        assert.equal((await f.app.request(`/api/automations/${jobId}/runs?limit=101`)).status, 400)
        assert.equal((await f.app.request(`/api/automations/${jobId}/runs?offset=-1`)).status, 400)
        assert.equal((await f.app.request('/api/automations/foreign-job/runs')).status, 404)
        assert.equal((await f.app.request('/api/automations', { method: 'POST' })).status, 404)
        f.cron.removeJob(jobId)
        const summaries = (await (await f.app.request('/api/automations')).json()).automations
        assert.equal(summaries.length, 5)
        assert.equal(summaries.find((s: { id: string }) => s.id === jobId).enabled, false)
        assert.equal(summaries.find((s: { id: string }) => s.id === neverRun).enabled, false)
        const historical = await (await f.app.request('/api/automations/learning%3Areflector/runs')).json()
        assert.equal(historical.total, 1)
        assert.equal(historical.runs[0].status, 'unknown')
        const other = new Hono()
        registerAutomationRoutes(other, new CronService(workspace), {
          listSessions: () => f.manager.listSessions(), getSessionState: (id: string) => f.manager.getSessionState(id),
        } as SessionManager, 'org-b')
        assert.deepEqual(await (await other.request('/api/automations')).json(), { automations: [] })
        assert.equal((await other.request(`/api/automations/${jobId}/runs`)).status, 404)
      } finally { await f.cron.stop(); await f.manager.stop(); store.close?.() }
    })
  })

  test(`${Store.name}: fresh execution stays running until terminal state, stop aborts and drains it`, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      const f = fixture(workspace, store)
      try {
        await f.manager.start()
        await f.cron.start()
        const id = f.cron.addJob({ schedule: 'every 1h', session: 'fresh', task: 'hold' })
        const run = f.cron.runNow(id)
        await until(() => f.requests.length === 1)
        const repeated = f.cron.runNow(id)
        const running = await (await f.app.request(`/api/automations/${id}/runs`)).json()
        assert.equal(running.runs[0].status, 'running')
        await f.cron.stop()
        await Promise.all([run, repeated])
        assert.equal(f.requests.length, 1)
        assert.equal(f.requests[0].signal.aborted, true)
        assert.equal(f.manager.getSessionState(f.requests[0].sessionId)!.executionStatus, 'cancelled')
        const ended = await (await f.app.request(`/api/automations/${id}/runs`)).json()
        assert.equal(ended.runs[0].status, 'cancelled')
      } finally { await f.cron.stop(); await f.manager.stop(); store.close?.() }
    })
  })

  test(`${Store.name}: fresh offline workdir fails without falling back to its Main display path`, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      const f = fixture(workspace, store, { remoteOnline: false })
      try {
        await f.manager.start()
        await f.cron.start()
        await f.manager.buildSession('web:origin', undefined, {
          folderId: 'folder-a', workdir: { version: 1, nodeId: 'remote-a', capabilityId: 'folder-a', displayPathSnapshot: workspace },
        })
        const tool = new CronAddTool(f.cron, f.manager, name => name === 'general')
        const ctx = { sessionId: 'web:origin' } as ExecutionContext
        assert.match(await tool.execute({ schedule: 'every 1h', task: 'offline', session: 'fresh' }, ctx), /Created job/)
        const job = f.cron.listJobs()[0]
        await f.cron.runNow(job.id)
        const runs = await (await f.app.request(`/api/automations/${job.id}/runs`)).json()
        assert.equal(runs.runs[0].status, 'failed')
        assert.equal(f.requests.length, 0)
        assert.equal(f.manager.getSessionState(runs.runs[0].sessionId)!.workdir!.nodeId, 'remote-a')
        assert.match(await tool.execute({ schedule: 'every 1h', task: 'foreign', session: 'fresh' },
          { sessionId: 'foreign:origin' } as ExecutionContext), /originating session is unavailable/)
      } finally { await f.cron.stop(); await f.manager.stop(); store.close?.() }
    })
  })
}

test('invalid modes and incompatible arguments are rejected before persistence', async () => {
  await withTempWorkspace(async workspace => {
    await mkdir(join(workspace, '.cron'))
    await writeFile(join(workspace, '.cron', 'jobs.json'), JSON.stringify({ version: 1, ownershipVersion: 2, jobs: [
    ] }))
    const cron = new CronService(workspace)
    try {
      await cron.start()
      assert.deepEqual(cron.listJobs(), [])
      assert.throws(() => cron.addJob({ schedule: 'every 1h', session: 'typo' as 'fresh' }), /Invalid cron job/)
      assert.throws(() => cron.addJob({ schedule: 'every 1h', session: 'existing' }), /Invalid cron job/)
      assert.throws(() => cron.addJob({ schedule: 'every 1h', session: 'fresh', target: { sessionId: 'web:origin' } }), /Invalid cron job/)
      assert.throws(() => cron.addJob({ schedule: 'invalid schedule', session: 'fresh' }))
      const tool = new CronAddTool(cron, undefined, name => name === 'general')
      const ctx = { sessionId: 'web:origin' } as ExecutionContext
      for (const session of ['typo', 'origin', 'isolated']) {
        assert.match(await tool.execute({ schedule: 'every 1h', task: 'x', session }, ctx), /session must/)
      }
      const add = { schedule: 'every 1h', task: 'x' }
      assert.match(await tool.execute({ ...add, isolated: true }, ctx), /isolated is not supported/)
      assert.match(await tool.execute({ ...add, targetSessionId: ' ' }, ctx), /targetSessionId must/)
      assert.match(await tool.execute({ ...add, session: 'fresh', targetSessionId: 'web:peer' }, ctx), /only for existing/)
      assert.match(await tool.execute({ ...add, agentType: 'general' }, ctx), /only for fresh/)
      assert.match(await tool.execute(add, ctx), /scheduling is unavailable/)
      assert.match(await tool.execute({ schedule: 'every 1h', task: 'x', session: 'fresh', agentType: 'missing' }, ctx), /unknown agent type/)
      assert.equal(JSON.parse(await readFile(join(workspace, '.cron', 'jobs.json'), 'utf8')).jobs.length, 0)
    } finally { await cron.stop() }
  })
})

test('learning registers once on the common scheduler, gates activity, links manual runs and preserves incremental watermark', async () => {
    await withTempWorkspace(async workspace => {
      const store = new JsonlSessionStore(join(workspace, 'sessions'))
      await store.init()
      const f = fixture(workspace, store)
      const scope = createProjectScope('org-a')
      const config = { reflectIntervalMs: 3600000, encapsulateIntervalMs: 3600000, soulIntervalMs: 3600000 }
      const learning = new LearningService(f.bus, scope, {
        reflector: async (signal, job, accepted) => {
          let id: string | undefined
          const ran = await triggerReflectorFlush(f.manager, signal, async task => {
            id = await f.dispatcher.dispatch(job, signal, task, accepted)
            return id
          })
          return ran ? id : false
        },
        encapsulator: (signal, job, accepted) => f.dispatcher.dispatch(job, signal, learningTask('encapsulator'), accepted),
        soulReflector: (signal, job, accepted) => f.dispatcher.dispatch(job, signal, learningTask('soulReflector'), accepted),
      }, config, f.cron, id => f.manager.getSessionState(id)?.automation?.config?.source === 'learning')
      try {
        await f.manager.start()
        await f.cron.start()
        learning.update(config)
        assert.deepEqual(f.cron.listJobs().map(j => j.id), Object.values(LEARNING_AUTOMATIONS).map(j => j.id))
        await f.cron.runNow('learning:reflector')
        assert.equal(f.requests.length, 0)
        await f.manager.deliver('web:origin', input('User activity'))
        await until(() => f.manager.getSessionState('web:origin')?.executionStatus === 'completed')
        const initialCount = (await f.manager.getHistory('web:origin', { offset: 0, pageSize: 0 })).total
        await f.cron.runNow('learning:reflector')
        assert.equal(f.requests.length, 2)
        assert.equal(learning.status().pipelines.reflector.pending, false)
        assert.equal(learning.status().pipelines.encapsulator.pending, true)
        assert.equal(learning.status().pipelines.soulReflector.pending, true)
        await f.cron.runNow('learning:encapsulator')
        await f.cron.runNow('learning:soul-reflector')
        assert.equal(f.requests.length, 4)
        const learningRuns = f.manager.listSessions().map(row => f.manager.getSessionState(row.sessionId)!)
          .filter(state => state.automation?.config?.source === 'learning')
        assert.equal(learningRuns.length, 3)
        for (const state of learningRuns) {
          assert.match(state.automation!.runId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
          assert.equal(state.sessionId, `cron:${state.automation!.runId}`)
          const listing = await (await f.app.request(`/api/sessions/${encodeURIComponent(state.sessionId)}/files`)).json()
          assert.deepEqual(listing.workdir, { kind: 'local', displayPath: workspace, scope: 'home' })
        }
        assert.equal(learning.status().pipelines.reflector.pending, false)
        const command = createLearnCommand(f.manager, pipeline => learning.trigger(pipeline))
        const ctx = {} as Parameters<typeof command.execute>[0]
        assert.match(await command.execute(ctx, 'reflector'), /No new activity/)
        assert.equal(f.requests.length, 4)
        await f.manager.deliver('web:origin', input('More user activity'))
        await until(() => f.requests.length === 5 && f.manager.getSessionState('web:origin')?.executionStatus === 'completed')
        assert.match(await command.execute(ctx, 'reflector'), /Session: cron:/)
        await until(() => !learning.status().pipelines.reflector.dispatching)
        assert.match(JSON.stringify(f.requests.at(-1)!.messages), new RegExp(`starting at index ${initialCount}`))
        learning.update({ ...config, enabled: false })
        assert.equal(f.cron.listJobs().every(job => job.enabled === false), true)
        assert.match(await command.execute(ctx, 'encapsulator'), /Session: cron:/)
        await until(() => !learning.status().pipelines.encapsulator.dispatching)
        assert.equal(f.cron.listJobs().length, 3)
        await learning.stop()
        assert.equal(f.cron.listJobs().length, 0)
      } finally { await learning.stop(); await f.cron.stop(); await f.manager.stop(); scope.close() }
  })

  test('manual learning returns a live run link on admission, joins an existing run, and remains abortable', async () => {
    await withTempWorkspace(async workspace => {
      const store = new JsonlSessionStore(join(workspace, 'sessions'))
      await store.init()
      const f = fixture(workspace, store)
      const scope = createProjectScope('org-a')
      const learning = new LearningService(f.bus, scope, {
        reflector: async () => false,
        encapsulator: (signal, job, accepted) => f.dispatcher.dispatch(job, signal, 'hold', accepted),
        soulReflector: async () => false,
      }, { enabled: false, reflectIntervalMs: 3600000, encapsulateIntervalMs: 3600000, soulIntervalMs: 3600000 }, f.cron)
      try {
        await f.manager.start()
        await f.cron.start()
        const command = createLearnCommand(f.manager, pipeline => learning.trigger(pipeline))
        const ctx = {} as Parameters<typeof command.execute>[0]
        const first = await command.execute(ctx, 'encapsulator')
        assert.match(first, /Session: cron:/)
        await until(() => f.requests.length === 1)
        assert.equal(learning.status().pipelines.encapsulator.dispatching, true)
        assert(learning.status().pipelines.encapsulator.lastDispatchedAt)
        assert.equal(await command.execute(ctx, 'encapsulator'), first)
        assert.equal(f.requests.length, 1)
        assert.equal(f.manager.getSessionState(f.requests[0].sessionId)!.executionStatus, 'running')
        await learning.stop()
        assert.equal(f.requests[0].signal.aborted, true)
        assert.equal(f.manager.getSessionState(f.requests[0].sessionId)!.executionStatus, 'cancelled')
      } finally { await learning.stop(); await f.cron.stop(); await f.manager.stop(); scope.close() }
    })
  })
})
