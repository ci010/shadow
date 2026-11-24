import { groupFolderSessions, type SidebarSession } from '../../app/src/folders-sidebar.ts'
import { isRegularQuickOpenSession } from '../../app/src/session-quick-open.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Bus } from '../bus/bus.ts'
import { SessionManager, type SessionManagerDeps } from '../sessions/session-manager.ts'
import { JsonlSessionStore } from '../sessions/session-store-jsonl.ts'
import { SqliteSessionStore } from '../sessions/session-store-sqlite.ts'
import { WorkAlignment } from '../sessions/work-alignment.ts'
import type { SessionState } from '../sessions/session-store.ts'
import { localFolderWorkdirRef, resolveSessionLocations, type WorkdirRefV2 } from '../sessions/locality.ts'
import { InitiativeStore, automaticWorkEligible } from '../initiatives/store.ts'
import type { WorkRecord } from '../initiatives/work-contract.ts'
import type { LLMProvider } from '../providers/provider.ts'
import { Tools } from '../tools/registry.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { WorkDispatcher } from './work-dispatch.ts'
import { WORK_DISPATCH_AUTOMATION } from './defaults.ts'
import { WORK_DISPATCH_ID, workDispatchConfigSchema } from './work-dispatch-contract.ts'

async function until(check: () => boolean) {
  const deadline = Date.now() + 5000
  while (!check()) { assert.ok(Date.now() < deadline, 'fixture timed out'); await new Promise(resolve => setTimeout(resolve, 10)) }
}

for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  test(`${Store.name}: real manager has one initial delivery, role-respecting host budgets, isolated cwd, blocked fallback and persisted recovery metadata`, async () => withTempWorkspace(async home => {
    const directory = join(home, 'sessions'), isolated = join(home, 'isolated')
    await mkdir(isolated)
    const store = new Store(directory)
    let closed = false
    await store.init()
    const bus = new Bus(), tools = new Tools(home)
    let inferences = 0, executions = 0, accepted = 0
    let raceKey: string | undefined, raceDependency: string | undefined, raceMode: 'cancelled' | 'dependency' | 'abort-during-verify' | 'reassigned' | undefined
    let raceController: AbortController | undefined, verificationCalls = 0
    let hold = false, holdEntered = false, identityFails = false
    tools.register({ name: 'step', description: 'Synthetic step', parameters: { type: 'object', properties: {} }, execute: async (_args, context) => {
      executions++
      assert.equal(resolveSessionLocations(home, manager.getSessionState(context.sessionId)!, undefined, manager.workdirLookup).workdir.available, true)
      return 'Synthetic verified step'
    } })
    tools.register({ name: 'forbidden', description: 'Role must keep this hidden', parameters: { type: 'object', properties: {} }, execute: async () => { throw new Error('must not execute') } })
    const provider: LLMProvider = { name: 'fixture', listModels: () => ['fixture'], chat: async (_messages, definitions, options) => {
      inferences++
      if (hold) {
        holdEntered = true
        return await new Promise<never>((_resolve, reject) => {
          const signal = options!.signal!
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          if (signal.aborted) reject(signal.reason)
        })
      }
      assert.deepEqual(definitions?.map(def => def.function.name), ['step'])
      return { content: '', toolCalls: [{ id: `step-${inferences}`, name: 'step', arguments: {} }] }
    } }
    const manager = new SessionManager({ workspace: home, projectId: 'fixture', store, bus, provider, tools,
      ownsFolder: (id: string) => id === 'isolated', ownsWorkdir: (ref: WorkdirRefV2) => ref.workdirId === localFolderWorkdirRef('isolated').workdirId,
      assertSessionFolder: (state: SessionState) => {
        if (state.folderId) assert.deepEqual(state.workdir, localFolderWorkdirRef(state.folderId))
      },
      workdirLookup: () => ({ node: 'online', workdir: { online: true, path: isolated } }),
      backgroundTasks: { listTasks: () => [] },
      agentTypes: { resolve: (name: string) => name === 'general' ? { name, description: '', prompt: '', source: 'builtin', defaultMode: 'session', allowedTools: ['step'] } : undefined },
      context: { buildSystemPromptDetails: async () => {
        if (raceKey && raceMode) {
          if (raceMode === 'dependency') {
            const record = initiatives.workRecords().find(item => item.key === raceKey)!
            initiatives.saveWork({ ...record, sequence: record.sequence + 1,
              dependencies: [raceDependency!] }, record.sequence, 'user', 'admission_dependency_race')
          }
          else if (raceMode === 'cancelled' || raceMode === 'reassigned') {
            const record = initiatives.workRecords().find(item => item.key === raceKey)!
            initiatives.saveWork({ ...record, sequence: record.sequence + 1,
              ...(raceMode === 'cancelled' ? { status: 'cancelled' as const } : { assignee: 'work-executor:historical',
                assignmentRevision: record.assignmentRevision + 1, automaticExecution: undefined }) }, record.sequence, 'user', 'admission_race')
          }
          raceKey = undefined
        }
        return { systemPrompt: 'Synthetic system prompt', sections: [] }
      } },
      handoffManager: { shouldHandoff: () => false, getContextPolicy: () => undefined },
      getLlmRuntimeConfig: () => ({ model: 'fixture', contextWindow: 128000, temperature: 0 }),
    } as unknown as SessionManagerDeps)
    const initiatives = new InitiativeStore(home, { isSessionKnown: id => !!manager.getSessionState(id) })
    const alignment = new WorkAlignment(initiatives, { state: id => manager.getSessionState(id),
      changed: (record, previous) => manager.notifyWorkChange(record, previous), })
    manager.alignment = alignment
    const config = workDispatchConfigSchema.parse({ kind: 'work-dispatch', folderId: 'source', maxConcurrent: 1, inferenceRequests: 2, toolCalls: 2 })
    const dispatcher = new WorkDispatcher({ projectId: 'fixture', store: initiatives, sessions: manager,
      validateTarget: async () => {}, prepare: async () => ({ folderId: 'isolated', path: isolated, branch: 'shadow/synthetic' }),
      verify: async (_config, _id, _execution, signal) => {
        if (identityFails) throw new Error('Isolated Git identity changed')
        verificationCalls++
        if (raceMode === 'abort-during-verify' && verificationCalls === 1) {
          assert.equal(signal, raceController!.signal, 'pre-commit verification must retain the original Cron/host signal')
          raceController!.abort(new Error('cancelled during admission identity verification'))
        }
      },
      changed: (record, previous) => manager.notifyWorkChange(record, previous) })
    dispatcher.setRunner(async (round, signal) => {
      const candidate = initiatives.workRecords().find(record => automaticWorkEligible(record, initiatives.workRecords()))
      if (candidate) await dispatcher.dispatchWork(round, candidate.key, candidate.sequence, {}, signal)
    })
    const subscription = bus.on('session.turn.finished', fact => dispatcher.finished(fact))
    const admissions = bus.on('session.input.accepted', () => { accepted++ })
    try {
      const legacyId = 'work-executor:historical'
      await store.saveState(legacyId, { sessionId: legacyId, projectId: 'fixture', segmentIndex: 0,
        mode: 'session', agentType: 'general', folderId: 'isolated', workdir: localFolderWorkdirRef('isolated'),
        automaticWork: { key: 'work:ad71b681-6627-5feb-a94e-beb1d8152bbf', jobId: WORK_DISPATCH_ID, limits: config },
        automation: { jobId: WORK_DISPATCH_ID, name: 'Work auto-dispatch', runId: legacyId,
          startedAt: new Date().toISOString(), contextMode: 'fresh', config: { source: 'cron', schedule: 'every 60s', agentType: 'general' } },
      })
      await manager.start()
      assert.equal(manager.getSessionState(legacyId)?.automation, undefined)
      assert.equal((await manager.querySessionHistoryStates({ jobId: WORK_DISPATCH_ID })).total, 0)
      const assertOrdinaryNavigation = (id: string) => {
        const summary = manager.listSessions().find(state => state.sessionId === id)!
        assert.ok(summary)
        assert.equal(summary.automation, undefined)
        const row = { ...summary, projectId: 'fixture', label: id, isDirectChat: false, isCurrent: false,
          parentSessionId: null, depth: 0 } satisfies SidebarSession
        assert.equal(isRegularQuickOpenSession(row), true)
        const groups = groupFolderSessions([], [row])
        assert.deepEqual(groups.unified.map(state => state.sessionId), [id])
        assert.deepEqual(groups.automations, [])
      }
      assertOrdinaryNavigation(legacyId)
      const job = { ...WORK_DISPATCH_AUTOMATION, program: config, id: WORK_DISPATCH_ID, createdAt: new Date().toISOString() }
      await dispatcher.dispatch(job, new AbortController().signal)
      assert.equal(inferences, 0)
      await manager.buildSession('work-executor:unbound', undefined, { mode: 'session', agentType: 'general', automaticWork: { key: 'work:8da08c12-7908-594d-87e6-a380fd60f0c1', jobId: WORK_DISPATCH_ID, limits: config } })
      await assert.rejects(manager.deliver('work-executor:unbound', { id: 'unsafe', kind: 'message', policy: 'queue', timestamp: new Date().toISOString(),
        source: { kind: 'event', eventId: 'unsafe', source: 'system', type: 'test' }, content: 'Must not execute in source or session data directory' }), /prepared isolated Workspace|no longer admissible/)
      await assert.rejects(manager.bindAutomaticWorkWorkspace('work-executor:unbound', 'foreign-project-folder'), /another Project/)
      assert.equal(inferences, 0)
      for (const action of ['cancelled', 'dependency', 'abort-during-verify', 'reassigned'] as const) {
        const raced = await alignment.execute({ kind: 'user' }, 'create', undefined, undefined,
          { title: `Synthetic ${action} during manager preparation`, definition: 'Do not infer after cancellation', assignee: null }) as WorkRecord
        if (action === 'dependency') {
          const prerequisite = await alignment.execute({ kind: 'user' }, 'create', undefined, undefined,
            { title: 'Unfinished explicit prerequisite', definition: 'Prevent dependent inference', assignee: null }) as WorkRecord
          await alignment.editNote({ kind: 'user' }, prerequisite.key, prerequisite.sequence, { status: 'cancelled' })
          raceDependency = prerequisite.key
        }
        raceKey = raced.key; raceMode = action; raceController = new AbortController(); verificationCalls = 0
        if (action === 'abort-during-verify') {
          await assert.rejects(dispatcher.dispatch(job, raceController.signal), /cancelled during admission identity verification/)
          assert.equal(alignment.get(raced.key).assignee, null)
        } else {
          await dispatcher.dispatch(job, raceController.signal)
          await until(() => raceKey === undefined && !manager.isSessionBusy(alignment.get(raced.key).assignee!))
          const record = alignment.get(raced.key)
          if (action === 'cancelled') assert.equal(record.status, 'cancelled')
          if (action === 'reassigned') assert.equal(record.assignee, legacyId)
          if (action === 'dependency') assert.equal(initiatives.workKickoff(record.automaticExecution!.inputId)?.state, 'pending')
        }
        assert.equal(inferences, 0)
        assert.equal(accepted, 0)
        const record = alignment.get(raced.key)
        if (record.status !== 'cancelled') await alignment.editNote({ kind: 'user' }, record.key, record.sequence, { status: 'cancelled' })
      }
      raceMode = undefined; raceKey = undefined; raceController = undefined
      const work = await alignment.execute({ kind: 'user' }, 'create', undefined, undefined,
        { title: 'Synthetic automatic task', definition: 'Verify execution limits', assignee: null }) as WorkRecord
      await dispatcher.dispatch(job, new AbortController().signal)
      await until(() => alignment.get(work.key).status === 'blocked')
      const final = alignment.get(work.key), id = final.assignee!
      assert.equal(accepted, 1, 'notifyWorkChange must not bypass the durable kickoff first-admission boundary')
      assert.equal(inferences, 2)
      assert.equal(executions, 2)
      assert.match(final.blockedReason!, /maximum number of iterations/)
      const state = manager.getSessionState(id)!
      assert.equal(state.mode, 'session')
      assert.equal(state.agentType, 'general')
      assert.equal(state.parentSessionId, null)
      assert.equal(state.automaticWork?.key, work.key)
      assertOrdinaryNavigation(id)
      assert.equal((await manager.querySessionHistoryStates({ jobId: WORK_DISPATCH_ID })).total, 0)
      assert.deepEqual(state.workdir, localFolderWorkdirRef('isolated'))
      const locations = resolveSessionLocations(home, state, undefined, manager.workdirLookup)
      assert.ok(locations.workdir.available && locations.workdir.locality === 'local')
      assert.equal(locations.workdir.path, isolated)
      assert.match(alignment.prompt(id), /retain responsibility/i)
      hold = true
      const second = await alignment.execute({ kind: 'user' }, 'create', undefined, undefined,
        { title: 'Synthetic capacity occupant', definition: 'Hold the one execution slot', assignee: null }) as WorkRecord
      await dispatcher.dispatch(job, new AbortController().signal)
      await until(() => holdEntered)
      await assert.rejects(manager.resumeSession(id, state.recovery!.id, true), /capacity is occupied/,
        'ordinary Session recovery must use the same controller, not bypass the automatic recovery endpoint')
      const secondCurrent = alignment.get(second.key), secondId = secondCurrent.assignee!
      assert.equal(await dispatcher.cancel(), true)
      await until(() => !manager.isSessionBusy(secondId) && alignment.get(second.key).status === 'blocked')
      assert.equal(alignment.get(second.key).assignee, secondId)
      identityFails = true
      await assert.rejects(manager.resumeSession(id, state.recovery!.id, true), /Git identity changed/,
        'ordinary Session recovery must reverify the actual isolated Git identity')
      assert.equal(inferences, 3)
      await manager.stop()
      store.close?.(); closed = true
      const restored = new Store(directory)
      try {
        await restored.init()
        const persisted = await restored.getState(id)
        assert.deepEqual(persisted?.automaticWork, state.automaticWork)
        assert.equal(persisted?.automaticWork?.limits.inferenceRequests, 2)
        assert.deepEqual(persisted?.workdir, localFolderWorkdirRef('isolated'))
        assert.equal(persisted?.recovery?.reason, 'failed')
      } finally { restored.close?.() }
    } finally { bus.off(subscription); bus.off(admissions); await manager.stop(); if (!closed) store.close?.(); initiatives.close() }
  }))
}
