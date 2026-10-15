import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { Hono } from 'hono'
import { Bus } from '../bus/bus.ts'
import { SessionTools, Tools } from '../tools/registry.ts'
import { ImportTool } from '../tools/load-tool.ts'
import { InvokeTool } from '../tools/invoke-tool.ts'
import { SessionRetirementTool } from '../tools/session-retirement.ts'
import type { ExecutionContext } from '../tools/context.ts'
import type { LLMProvider, LLMResponse } from '../providers/provider.ts'
import { SessionManager, type SessionManagerDeps } from '../sessions/session-manager.ts'
import { SessionRetirement } from '../sessions/retirement.ts'
import { JsonlSessionStore } from '../sessions/session-store-jsonl.ts'
import { SqliteSessionStore } from '../sessions/session-store-sqlite.ts'
import { physicalSessionId } from '../sessions/session-identity.ts'
import type { SessionState, SessionStore } from '../sessions/session-store.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { workspacePath } from '../utils/paths.ts'
import { ConfigSchema } from '../config/schema.ts'
import { ProjectConfigStore } from '../projects/config-store.ts'
import { CronService } from './service.ts'
import { CronDispatcher } from './dispatch.ts'
import { registerAutomationRoutes } from './routes.ts'
import { SESSION_CLEANUP_AUTOMATION, SESSION_CLEANUP_DEFAULT_KEY } from './defaults.ts'

const candidate = 'web:chat-old-completed'
const completed = { outcome: 'complete', reason: 'Completed; no useful new knowledge or draft files',
  knowledge: 'none', knowledgeFiles: [], files: [] }
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 7000
  while (!await check()) { assert.ok(Date.now() < deadline, 'fixture timed out'); await pause(10) }
}

async function fixture(workspace: string, store: SessionStore) {
  await store.init()
  const old = new Date(Date.now() - 6 * 86_400_000).toISOString()
  const state: SessionState = { sessionId: candidate, projectId: 'fixture', mode: 'session', segmentIndex: 0,
    physicalIdVersion: 2, executionStatus: 'completed', lastUserMessageAt: old, lastActivityAt: old }
  if (!await store.getState(candidate)) {
    await store.saveState(candidate, state)
    await store.createSessionLog(physicalSessionId(state), [
      { role: 'user', content: 'Finish this task', timestamp: old },
      { role: 'assistant', content: `Finished the task, no outstanding work. ${'Verified fixture evidence. '.repeat(600)}`, timestamp: old },
    ])
  }
  const tools = new Tools(workspace)
  const importer = new ImportTool(new Map(), workspace)
  tools.register(importer)
  tools.register(new InvokeTool(importer))
  const steps = new Map<string, number>()
  let hold = false
  let enteredHold = false
  const provider: LLMProvider = {
    name: 'fixture', listModels: () => ['fixture'],
    async chat(messages, definitions, options) {
      const sessionId = JSON.parse(String(messages[0].content).split('\n')[0]).sessionId as string
      assert.ok(sessionId.startsWith('cron:'), 'No bespoke assessor session may be launched')
      assert.deepEqual(definitions?.map(tool => tool.function.name).sort(), ['import_tool', 'invoke_tool'])
      if (hold) {
        enteredHold = true
        return await new Promise<LLMResponse>((_, reject) => {
          const signal = options!.signal!
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          if (signal.aborted) reject(signal.reason)
        })
      }
      const step = steps.get(sessionId) ?? 0
      steps.set(sessionId, step + 1)
      const invoke = (args: Record<string, unknown>): LLMResponse => ({ content: '', toolCalls: [{
        id: `call-${step}`, name: 'invoke_tool', arguments: { name: 'session_retirement', args },
      }] })
      if (step === 0) return invoke({ action: 'list' })
      const last = [...messages].reverse().find(message => message.role === 'tool')
      const text = String(last?.content)
      assert.ok(!text.startsWith('Error'), text)
      if (step === 1) {
        const candidates = JSON.parse(text)
        if (!candidates.length) return { content: 'No eligible sessions', toolCalls: [] }
        assert.ok(candidates.includes(candidate))
        return invoke({ action: 'inspect', sessionId: candidate })
      }
      if (step === 2) {
        const evidence = JSON.parse(text)
        assert.equal(evidence.sessionId, candidate)
        assert.ok(evidence.history.length)
        assert.ok(text.length > 12_000, 'Inspection evidence must survive the ordinary truncation threshold intact')
        return invoke({ action: 'apply', token: evidence.token, proposal: completed })
      }
      assert.match(text, /recoverable; no physical deletion/)
      return { content: 'Verified recoverable retirement of the completed session.', toolCalls: [] }
    },
  }
  const manager = new SessionManager({
    workspace, projectId: 'fixture', store, bus: new Bus(), provider, tools,
    backgroundTasks: { listTasks: () => [] },
    agentTypes: { resolve: (name: string) => name === 'general'
      ? { name, description: '', prompt: '', source: 'builtin', defaultMode: 'session' } : undefined },
    context: { buildSystemPrompt: async (ctx: unknown) => JSON.stringify(ctx) },
    handoffManager: { shouldHandoff: () => false, getContextPolicy: () => undefined },
    getLlmRuntimeConfig: () => ({ model: 'fixture', contextWindow: 128000, temperature: 0 }),
  } as unknown as SessionManagerDeps)
  const cron = new CronService(workspace)
  const retirement = new SessionRetirement({ sessions: manager, workspace, folderPath: () => undefined,
    protected: id => cron.listJobs().some(job => job.enabled !== false &&
      [job.target?.sessionId, job.originSessionId, job.workspaceRoot].includes(id)) })
  const retirementTool = new SessionRetirementTool(retirement, manager, cron)
  importer.registerBuiltin(retirementTool.name, retirementTool)
  const dispatcher = new CronDispatcher(manager, async () => { throw new Error('Expected fresh automation') })
  cron.setHandler(async (job, signal) => { await dispatcher.dispatch(job, signal) })
  const app = new Hono()
  registerAutomationRoutes(app, cron, manager, 'fixture')
  await manager.start()
  await cron.start()
  return { manager, cron, app, steps, retirementTool,
    hold: () => { hold = true }, enteredHold: () => enteredHold,
    close: async () => { await cron.stop(); await manager.stop(); store.close?.() } }
}

for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  test(`${Store.name}: cleanup uses ordinary listing, controls, agent/tool loop, scheduled/manual runs and durable history`, async () => {
    await withTempWorkspace(async workspace => {
      const f = await fixture(workspace, new Store(join(workspace, 'sessions')))
      try {
        await f.cron.ensureDefaultJob(SESSION_CLEANUP_DEFAULT_KEY, { ...SESSION_CLEANUP_AUTOMATION, schedule: 'every 1s' })
        const job = f.cron.listJobs()[0]
        assert.equal(job.enabled, false)
        const inventory = await (await f.app.request('/api/automations')).json()
        assert.equal(inventory.automations[0].id, job.id)
        assert.equal(inventory.automations[0].source, 'cron')
        assert.equal(inventory.automations[0].editable, true)
        await pause(1100)
        assert.equal(f.steps.size, 0, 'Disabled timer must not admit work')
        assert.equal((await f.app.request(`/api/automations/${job.id}/run`, { method: 'POST' })).status, 202)
        await until(async () => (await f.manager.listHistoryStates({ jobId: job.id })).some(state => state.executionStatus === 'completed'))
        assert.ok(f.manager.getSessionState(candidate)?.retirement)
        const history = await (await f.app.request(`/api/automations/${job.id}/runs`)).json()
        assert.equal(history.runs.length, 1)
        const runId = history.runs[0].sessionId
        assert.ok(runId.startsWith('cron:'))
        const historyText = JSON.stringify(await f.manager.getHistory(runId))
        assert.match(historyText, /session_retirement/)
        assert.match(historyText, /recoverable/)
        assert.equal(f.manager.getSessionState(candidate)?.retirement?.assessorSessionId, runId)
        await f.manager.restoreRetiredSession(candidate)
        const patch = (enabled: boolean) => f.app.request(`/api/automations/${job.id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }),
        })
        assert.equal((await patch(true)).status, 200)
        await until(async () => !!f.manager.getSessionState(candidate)?.retirement)
        await patch(false)
        await until(async () => (await f.manager.listHistoryStates({ jobId: job.id })).length === 2)
        const count = f.steps.size
        await pause(1100)
        assert.equal(f.steps.size, count)
        await f.cron.stop()
        const reloaded = new CronService(workspace)
        await reloaded.start()
        try {
          await reloaded.ensureDefaultJob(SESSION_CLEANUP_DEFAULT_KEY, SESSION_CLEANUP_AUTOMATION)
          assert.equal(reloaded.listJobs().length, 1)
          assert.equal(reloaded.listJobs()[0].enabled, false)
          assert.deepEqual(reloaded.listJobs()[0].executionLimits, job.executionLimits)
          reloaded.removeJob(job.id)
          await reloaded.flush()
        } finally { await reloaded.stop() }
        const afterRemoval = new CronService(workspace)
        await afterRemoval.start()
        await afterRemoval.ensureDefaultJob(SESSION_CLEANUP_DEFAULT_KEY, SESSION_CLEANUP_AUTOMATION)
        assert.equal(afterRemoval.listJobs().length, 0, 'Removed defaults must not resurrect')
        await afterRemoval.stop()
        f.hold()
        // Restart the same normal scheduler and add an unrelated ordinary job to prove shared cancellation.
        await f.cron.start()
        const cancelId = f.cron.addJob({ ...SESSION_CLEANUP_AUTOMATION, name: 'Cancellable cleanup' })
        await f.app.request(`/api/automations/${cancelId}/run`, { method: 'POST' })
        await until(async () => f.enteredHold())
        assert.equal((await f.app.request(`/api/automations/${cancelId}/cancel`, { method: 'POST' })).status, 200)
        const cancelled = await f.manager.listHistoryStates({ jobId: cancelId })
        assert.equal(cancelled[0]?.executionStatus, 'cancelled')
      } finally { await f.close() }
      const restored = await fixture(workspace, new Store(join(workspace, 'sessions')))
      try {
        assert.ok((await restored.manager.automationFeatureStates()).length >= 3, 'History survives actual store reload')
        assert.ok(restored.manager.getSessionState(candidate)?.retirement, 'Retirement receipt survives store reload')
      } finally { await restored.close() }
    })
  })
}

test('legacy config is inert and old jobs files receive a disabled default without rewriting jobs', async () => {
  await withTempWorkspace(async workspace => {
    const config = ConfigSchema.parse({ sessionRetirement: { enabled: true, inactivityDays: 1 } })
    assert.equal('sessionRetirement' in config, false)
    const configPath = join(workspace, 'synthetic-project.json')
    const oldConfig = JSON.stringify({ sessionRetirement: { enabled: true, inactivityDays: 1 } })
    await writeFile(configPath, oldConfig)
    const configStore = new ProjectConfigStore({ configPath, home: workspace, getSharedConfig: () => ConfigSchema.parse({}) })
    await configStore.init()
    assert.equal('sessionRetirement' in configStore.current(), false)
    assert.equal(await readFile(configPath, 'utf8'), oldConfig, 'Loading must not rewrite configuration')
    await configStore.update(raw => raw)
    assert.equal('sessionRetirement' in JSON.parse(await readFile(configPath, 'utf8')), false)
    const cron = new CronService(workspace)
    await cron.start()
    const id = cron.addJob({ session: 'fresh', task: 'Existing user job', schedule: 'every 1h', enabled: false })
    await cron.stop()
    const path = workspacePath(workspace, '.cron', 'jobs.json')
    const legacy = JSON.parse(await readFile(path, 'utf8'))
    delete legacy.initializedDefaults
    await writeFile(path, JSON.stringify(legacy))
    await cron.start()
    try {
      await cron.ensureDefaultJob(SESSION_CLEANUP_DEFAULT_KEY, SESSION_CLEANUP_AUTOMATION)
      assert.equal(cron.listJobs().length, 2)
      assert.equal(cron.listJobs().find(job => job.id === id)?.task, 'Existing user job')
      assert.ok(cron.listJobs().every(job => job.enabled === false))
      assert.throws(() => cron.addJob({ session: 'fresh', schedule: 'every 1h',
        executionLimits: { allowedTools: ['session_retirement'], inferenceRequests: 0, toolCalls: 1, argumentBytes: 1 } }), /Invalid cron/)
      await cron.stop()
      const interruptedInstall = JSON.parse(await readFile(path, 'utf8'))
      delete interruptedInstall.initializedDefaults
      await writeFile(path, JSON.stringify(interruptedInstall))
      await cron.start()
      await cron.ensureDefaultJob(SESSION_CLEANUP_DEFAULT_KEY, SESSION_CLEANUP_AUTOMATION)
      assert.equal(cron.listJobs().length, 2, 'Interrupted default installation must not duplicate its persisted job')
    } finally { await cron.stop() }
  })
})

test('retirement tool rejects normal sessions even if they know its name', async () => {
  await withTempWorkspace(async workspace => {
    const f = await fixture(workspace, new JsonlSessionStore(join(workspace, 'sessions')))
    try {
      await assert.rejects(f.retirementTool.execute({ action: 'list' }, {
        sessionId: candidate, signal: new AbortController().signal,
      } as ExecutionContext), /host-configured/)
    } finally { await f.close() }
  })

  test('generic trusted automation grants reject arbitrary imports and nested tool escalation', () => {
    const tools = new SessionTools(new Tools('.'), '.')
    tools.setTrustedLimits(SESSION_CLEANUP_AUTOMATION.executionLimits!)
    assert.equal(tools.executionDenial('import_tool', { source: 'v:tools/session_retirement' }), undefined)
    for (const source of ['external.json', 'v:tools/exec', 'v:tools/cron', 'v:tools/session_retirement/../exec']) {
      assert.match(tools.executionDenial('import_tool', { source })!, /explicitly granted/)
    }
    assert.match(tools.executionDenial('import_tool', { source: 'v:tools/session_retirement', args: ['--unsafe'] })!, /explicitly granted/)
    assert.match(tools.executionDenial('invoke_tool', { name: 'exec', args: {} })!, /allowlist/)
  })
})
