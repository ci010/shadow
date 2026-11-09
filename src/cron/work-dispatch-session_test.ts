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
import { InitiativeStore } from '../initiatives/store.ts'
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
    let raceKey: string | undefined, raceMode: 'cancelled' | 'paused' | 'abort-during-verify' | 'abort-during-context' | undefined
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
      context: { buildSystemPrompt: async () => {
        if (raceKey && raceMode) {
          if (raceMode === 'abort-during-context') raceController!.abort(new Error('cancelled during Session preparation'))
          else if (raceMode === 'paused' || raceMode === 'cancelled') {
            const record = initiatives.workRecords().find(item => item.key === raceKey)!
            initiatives.saveWork({ ...record, sequence: record.sequence + 1,
              ...(raceMode === 'paused' ? { paused: true } : { workflow: { ...record.workflow!, status: 'cancelled' } }) }, record.sequence, 'user', 'admission_race')
          }
          raceKey = undefined
        }
        return 'Synthetic system prompt'
      } },
      handoffManager: { shouldHandoff: () => false, getContextPolicy: () => undefined },
      getLlmRuntimeConfig: () => ({ model: 'fixture', contextWindow: 128000, temperature: 0 }),
    } as unknown as SessionManagerDeps)
    const initiatives = new InitiativeStore(home, { isSessionKnown: id => !!manager.getSessionState(id) })
    const alignment = new WorkAlignment(initiatives, { state: id => manager.getSessionState(id), evidence: async () => {},
      changed: (record, previous) => manager.notifyWorkChange(record, previous), })
    manager.alignment = alignment
    const config = workDispatchConfigSchema.parse({ kind: 'work-dispatch', folderId: 'source', inferenceRequests: 2, toolCalls: 2 })
    const dispatcher = new WorkDispatcher({ projectId: 'fixture', store: initiatives, sessions: manager,
      validateTarget: async () => {}, prepare: async () => ({ folderId: 'isolated', path: isolated, branch: 'shadow/synthetic' }),
      verify: async (_config, _id, _execution, signal) => {
        if (identityFails) throw new Error('Isolated Git identity changed')
        verificationCalls++
        if (raceMode === 'abort-during-verify' && verificationCalls === 2) {
          assert.equal(signal, raceController!.signal, 'the admission recheck must retain the original Cron/host signal')
          raceController!.abort(new Error('cancelled during admission identity verification'))
        }
      },
      changed: (record, previous) => manager.notifyWorkChange(record, previous) })
    const subscription = bus.on('session.turn.finished', fact => dispatcher.finished(fact))
    const admissions = bus.on('session.input.accepted', () => { accepted++ })
    try {
      await manager.start()
      const job = { ...WORK_DISPATCH_AUTOMATION, program: config, id: WORK_DISPATCH_ID, createdAt: new Date().toISOString() }
      await dispatcher.dispatch(job, new AbortController().signal)
      assert.equal(inferences, 0)
      await manager.buildSession('work-executor:unbound', undefined, { mode: 'session', agentType: 'general', automaticWork: { key: 'work:unbound', jobId: WORK_DISPATCH_ID, limits: config } })
      await assert.rejects(manager.deliver('work-executor:unbound', { id: 'unsafe', kind: 'message', policy: 'queue', timestamp: new Date().toISOString(),
        source: { kind: 'event', eventId: 'unsafe', source: 'system', type: 'test' }, content: 'Must not execute in source or session data directory' }), /prepared isolated Workspace|no longer admissible/)
      await assert.rejects(manager.bindAutomaticWorkWorkspace('work-executor:unbound', 'foreign-project-folder'), /another Project/)
      assert.equal(inferences, 0)
      for (const action of ['cancelled', 'paused', 'abort-during-verify', 'abort-during-context'] as const) {
        const raced = await alignment.execute({ kind: 'user' }, 'create', undefined, undefined,
          { title: `Synthetic ${action} during manager preparation`, definition: { objective: 'Do not infer after cancellation or pause' }, assignee: null }) as WorkRecord
        raceKey = raced.key; raceMode = action; raceController = new AbortController(); verificationCalls = 0
        await dispatcher.dispatch(job, raceController.signal)
        assert.equal(inferences, 0)
        assert.equal(accepted, 0)
        if (action === 'cancelled') assert.equal(alignment.get(raced.key).workflow?.status, 'cancelled')
        else if (action === 'paused') assert.equal(alignment.get(raced.key).paused, true)
        else {
          assert.equal(raceController.signal.aborted, true)
          assert.equal(alignment.get(raced.key).workflow?.status, 'blocked')
          assert.ok(alignment.get(raced.key).workflow?.assignee)
        }
      }
      raceMode = undefined; raceKey = undefined; raceController = undefined
      const work = await alignment.execute({ kind: 'user' }, 'create', undefined, undefined,
        { title: 'Synthetic automatic task', definition: { objective: 'Verify execution limits' }, assignee: null }) as WorkRecord
      await dispatcher.dispatch(job, new AbortController().signal)
      await until(() => alignment.get(work.key).workflow?.status === 'blocked')
      const final = alignment.get(work.key), id = final.workflow!.assignee!
      assert.equal(accepted, 1, 'notifyWorkChange must not bypass the dispatcher write-ahead first-admission barrier')
      assert.equal(inferences, 2)
      assert.equal(executions, 2)
      assert.match(final.workflow!.blockedReason!, /maximum number of iterations/)
      const state = manager.getSessionState(id)!
      assert.deepEqual(state.workdir, localFolderWorkdirRef('isolated'))
      const locations = resolveSessionLocations(home, state, undefined, manager.workdirLookup)
      assert.ok(locations.workdir.available && locations.workdir.locality === 'local')
      assert.equal(locations.workdir.path, isolated)
      assert.match(alignment.prompt(id), /retain responsibility/i)
      hold = true
      const second = await alignment.execute({ kind: 'user' }, 'create', undefined, undefined,
        { title: 'Synthetic capacity occupant', definition: { objective: 'Hold the one execution slot' }, assignee: null }) as WorkRecord
      await dispatcher.dispatch(job, new AbortController().signal)
      await until(() => holdEntered)
      await assert.rejects(manager.resumeSession(id, state.recovery!.id, true), /capacity is occupied/,
        'ordinary Session recovery must use the same controller, not bypass the automatic recovery endpoint')
      const secondCurrent = alignment.get(second.key), secondId = secondCurrent.workflow!.assignee!
      assert.equal(await dispatcher.cancel(), true)
      await until(() => !manager.isSessionBusy(secondId) && alignment.get(second.key).workflow?.status === 'blocked')
      assert.equal(alignment.get(second.key).workflow?.assignee, secondId)
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
