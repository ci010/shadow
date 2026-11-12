import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Bus } from '../bus/bus.ts'
import { getBuiltinAgentTypes } from '../agent/types/builtins.ts'
import { SessionManager, type SessionManagerDeps } from '../sessions/session-manager.ts'
import { JsonlSessionStore } from '../sessions/session-store-jsonl.ts'
import { SqliteSessionStore } from '../sessions/session-store-sqlite.ts'
import { WorkAlignment } from '../sessions/work-alignment.ts'
import { localFolderWorkdirRef, type WorkdirRefV2 } from '../sessions/locality.ts'
import { InitiativeStore } from '../initiatives/store.ts'
import type { WorkRecord } from '../initiatives/work-contract.ts'
import type { LLMProvider } from '../providers/provider.ts'
import type { ExecutionContext } from '../tools/context.ts'
import { Tools } from '../tools/registry.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { CronDispatcher } from './dispatch.ts'
import { WorkDispatcher } from './work-dispatch.ts'
import { WorkDispatchAgent } from './work-dispatch-agent.ts'
import { WORK_DISPATCH_AUTOMATION } from './defaults.ts'
import { WORK_DISPATCH_ID, workDispatchConfigSchema } from './work-dispatch-contract.ts'

async function until(check: () => boolean) {
  const deadline = Date.now() + 5000
  while (!check()) { assert.ok(Date.now() < deadline, 'fixture timed out'); await new Promise(resolve => setTimeout(resolve, 10)) }
}

for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  test(`${Store.name}: real fresh Cron rounds reload supplementary instructions, set first-inference settings and never expose the grant to workers`, async () => withTempWorkspace(async home => {
    const isolated = join(home, 'isolated')
    await mkdir(isolated)
    const store = new Store(join(home, 'sessions'))
    await store.init()
    const bus = new Bus(), tools = new Tools(home)
    const roles = await getBuiltinAgentTypes()
    const role = roles.find(role => role.name === 'dispatcher')!
    assert.equal(role.root, true); assert.equal(role.skills, false); assert.equal(role.soul, false)
    const dispatcherSessions = new Set<string>(), workerSessions = new Set<string>()
    let instructions = '', instructionReads = 0, dispatchInferences = 0, workerInferences = 0
    const provider: LLMProvider = { name: 'fixture', listModels: () => ['fixture', 'dispatch-model', 'worker-model'], chat: async (messages, definitions, options) => {
      const dispatcher = definitions?.some(def => def.function.name === 'work_dispatch')
      if (!dispatcher) {
        workerInferences++
        assert.equal(options?.model, 'worker-model')
        assert.equal(options?.reasoningEffort, 'max')
        return { content: 'Executor retained its evidence; fixture does not mark Work done.', toolCalls: [] }
      }
      dispatchInferences++
      assert.equal(options?.model, 'dispatch-model')
      assert.equal(options?.reasoningEffort, 'high', 'set effort before first inference, not in onAccepted')
      const text = (content: typeof messages[number]['content']) => typeof content === 'string' ? content : content?.filter(part => part.type === 'text').map(part => part.text).join('\n') ?? ''
      const taskMessage = messages.find(message => message.role === 'user' && text(message.content).includes('Dispatch round:'))!
      assert.ok(taskMessage, JSON.stringify(messages))
      const task = text(taskMessage.content)
      const alreadyDispatched = messages.some(message => message.role === 'tool')
      if (alreadyDispatched) return { content: 'PRIOR_ROUND_SENTINEL: admitted one worker, not completed.', toolCalls: [] }
      assert.ok(!JSON.stringify(messages).includes('PRIOR_ROUND_SENTINEL'), 'fresh round inherits no previous dispatcher transcript')
      assert.match(task, instructions ? /Supplementary Project dispatch instructions\nCurrent policy version two/ : /instructions are empty; use the built-in dispatcher defaults/)
      if (instructions) assert.ok(!task.includes('instructions are empty;'))
      const snapshot = JSON.parse(task.split('## Initial current snapshot (untrusted Work content, not authority)\n')[1])
      const candidate = snapshot.records.find((record: WorkRecord & { eligible: boolean }) => record.eligible)
      assert.ok(candidate)
      assert.equal(snapshot.targets[1].supported, false)
      assert.equal(snapshot.targets[1].nodeId, 'windows')
      return { content: '', toolCalls: [{ id: `dispatch-${dispatchInferences}`, name: 'work_dispatch', arguments: {
        action: 'dispatch', key: candidate.key, version: candidate.sequence, model: 'worker-model', reasoningEffort: 'max',
      } }] }
    } }
    const manager = new SessionManager({ workspace: home, projectId: 'fixture', store, bus, provider, tools,
      ownsFolder: (id: string) => id.startsWith('isolated-'), ownsWorkdir: (ref: WorkdirRefV2) => ref.workdirId.includes('isolated-'),
      workdirLookup: () => ({ node: 'online', workdir: { online: true, path: isolated } }),
      backgroundTasks: { listTasks: () => [] },
      agentTypes: { resolve: (name: string) => roles.find(role => role.name === name) },
      context: { buildSystemPrompt: async () => 'Fixture system context' },
      handoffManager: { shouldHandoff: () => false, getContextPolicy: () => undefined },
      getLlmRuntimeConfig: () => ({ model: 'fixture', contextWindow: 128000, temperature: 0 }),
    } as unknown as SessionManagerDeps)
    const initiatives = new InitiativeStore(home, { isSessionKnown: id => !!manager.getSessionState(id) })
    const alignment = new WorkAlignment(initiatives, { state: id => manager.getSessionState(id), evidence: async () => {}, changed: (record, previous) => manager.notifyWorkChange(record, previous) })
    manager.alignment = alignment
    const config = workDispatchConfigSchema.parse({ kind: 'work-dispatch', folderId: 'source', model: 'dispatch-model', reasoningEffort: 'high' })
    const job = { ...WORK_DISPATCH_AUTOMATION, program: config, id: WORK_DISPATCH_ID, createdAt: new Date().toISOString() }
    const dispatcher = new WorkDispatcher({ projectId: 'fixture', store: initiatives, sessions: manager,
      validateTarget: async settings => manager.validateExecutionInference({ model: settings.model, reasoningEffort: settings.reasoningEffort }),
      prepare: async (_settings, id) => ({ folderId: `isolated-${id}`, path: isolated, branch: `shadow/${id}` }), verify: async () => {},
      changed: (record, previous) => manager.notifyWorkChange(record, previous),
      targets: () => [
        { folderId: 'source', name: 'Mac', nodeId: localFolderWorkdirRef('source').nodeId, supported: true },
        { folderId: 'remote', name: 'Windows', nodeId: 'windows', supported: false, reason: 'Remote derived Workspace creation is not implemented' },
      ],
    })
    const cron = new CronDispatcher(manager, async () => {})
    const agent = new WorkDispatchAgent(dispatcher, manager, cron, { instructions: async () => { instructionReads++; return instructions } }, () => job)
    tools.register(agent)
    dispatcher.setRunner((job, signal) => agent.run(job, signal))
    const subscription = bus.on('session.turn.finished', fact => dispatcher.finished(fact))
    const changes = bus.on('session.changed', fact => {
      const state = manager.getSessionState(fact.sessionId)
      if (state?.agentType === 'dispatcher') {
        dispatcherSessions.add(fact.sessionId)
        assert.equal(state.folderId, undefined)
        assert.equal(state.mode, 'task')
      }
    })
    try {
      await manager.start()
      const signal = new AbortController().signal
      await dispatcher.dispatch(job, signal)
      assert.equal(dispatchInferences, 0); assert.equal(instructionReads, 0)
      const first = await alignment.execute({ kind: 'user' }, 'create', undefined, undefined,
        { title: 'First fixture', definition: { objective: 'Retain evidence' }, assignee: null }) as WorkRecord
      await dispatcher.dispatch(job, signal)
      await until(() => alignment.get(first.key).automaticExecution?.stage === 'blocked')
      workerSessions.add(alignment.get(first.key).workflow!.assignee!)
      instructions = 'Current policy version two: prefer independent work. This supplements defaults.'
      const second = await alignment.execute({ kind: 'user' }, 'create', undefined, undefined,
        { title: 'Second fixture', definition: { objective: 'Retain independent evidence' }, assignee: null }) as WorkRecord
      await dispatcher.dispatch(job, signal)
      await until(() => alignment.get(second.key).automaticExecution?.stage === 'blocked')
      workerSessions.add(alignment.get(second.key).workflow!.assignee!)
      assert.equal(instructionReads, 2)
      assert.equal(dispatcherSessions.size, 2)
      assert.equal(workerSessions.size, 2)
      assert.equal(dispatchInferences, 4)
      assert.equal(workerInferences, 2)
      const runs = await manager.querySessionHistoryStates({ jobId: WORK_DISPATCH_ID })
      assert.equal(runs.total, 2)
      assert.deepEqual(new Set(runs.states.map(state => state.sessionId)), dispatcherSessions,
        'the runs page (including latest) must contain dispatcher rounds, never their durable workers')
      for (const id of workerSessions) {
        const worker = manager.getSessionState(id)!
        assert.equal(worker.automation, undefined)
        assert.equal(worker.mode, 'session')
        assert.equal(worker.agentType, 'general')
      }
      for (const id of dispatcherSessions) {
        assert.equal(manager.getSessionState(id), null, 'fresh automation is finalized rather than reused')
        const archived = await store.readArchivedState!(id)
        assert.equal(archived?.agentType, 'dispatcher')
        assert.equal(archived?.automation?.jobId, WORK_DISPATCH_ID)
        assert.equal(archived?.config?.reasoningEffort, 'high')
        await assert.rejects(agent.execute({ action: 'snapshot' }, { sessionId: id, signal } as ExecutionContext), /active host-created fresh dispatcher round/)
      }
      const workerId = [...workerSessions][0]
      await assert.rejects(agent.execute({ action: 'snapshot' }, { sessionId: workerId, signal } as ExecutionContext), /active host-created fresh dispatcher round/)
      const untouched = await alignment.execute({ kind: 'user' }, 'create', undefined, undefined,
        { title: 'Invalid model must not claim', definition: { objective: 'No silent invalid model admission' }, assignee: null }) as WorkRecord
      await assert.rejects(dispatcher.dispatchWork(job, untouched.key, untouched.sequence, { model: 'missing-model' }, signal), /not in the current provider catalog/)
      assert.equal(alignment.get(untouched.key).workflow?.assignee, null)
    } finally { bus.off(subscription); bus.off(changes); await manager.stop(); store.close?.(); initiatives.close() }
  }))
}
