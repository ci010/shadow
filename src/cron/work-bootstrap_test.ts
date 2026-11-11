import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Bus } from '../bus/bus.ts'
import { FolderRegistry } from '../folders/registry.ts'
import { pickFolder } from '../folders/picker-service.ts'
import { DerivedWorkspaces } from '../folders/derived-workspace.ts'
import { SessionManager, type SessionManagerDeps } from '../sessions/session-manager.ts'
import { JsonlSessionStore } from '../sessions/session-store-jsonl.ts'
import { SqliteSessionStore } from '../sessions/session-store-sqlite.ts'
import { WorkAlignment } from '../sessions/work-alignment.ts'
import { LOCAL_NODE_ID, localFolderWorkdirRef } from '../sessions/locality.ts'
import { InitiativeStore } from '../initiatives/store.ts'
import type { WorkRecord } from '../initiatives/work-contract.ts'
import type { LLMProvider } from '../providers/provider.ts'
import { Tools } from '../tools/registry.ts'
import { ImportTool } from '../tools/load-tool.ts'
import { InvokeTool } from '../tools/invoke-tool.ts'
import { UseProjectTool } from '../tools/use-project.ts'
import type { ExecutionContext } from '../tools/context.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { WorkDispatcher } from './work-dispatch.ts'
import { WorkBootstrapTool } from './work-bootstrap.ts'
import { WORK_DISPATCH_AUTOMATION } from './defaults.ts'
import { WORK_DISPATCH_ID, workDispatchConfigSchema } from './work-dispatch-contract.ts'
import { isolationGit as git } from './work-isolation.ts'

for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  test(`${Store.name}: zero-target bootstrap uses real tool grants, registered source, isolated preparation and committed continuation`, async () => withTempWorkspace(async home => {
    const source = join(home, 'repo'); await mkdir(source)
    const signal = new AbortController().signal
    await git(source, ['init', '-b', 'main'], signal)
    await git(source, ['config', 'user.name', 'Fixture'], signal)
    await git(source, ['config', 'user.email', 'fixture@example.invalid'], signal)
    await writeFile(join(source, 'tracked'), 'committed')
    await git(source, ['add', '.'], signal)
    await git(source, ['commit', '-m', 'Disposable fixture'], signal)
    await git(source, ['update-ref', 'refs/remotes/origin/baseline', 'HEAD'], signal)
    await writeFile(join(source, 'tracked'), 'unrelated source branch commit')
    await git(source, ['commit', '-am', 'Unrelated fixture branch'], signal)
    await writeFile(join(source, 'tracked'), 'private dirty source')
    const folders = new FolderRegistry(home); await folders.init()
    const derived = new DerivedWorkspaces({ projectId: 'fixture', directory: join(home, 'derived'), folders, validateWork: () => {} })
    const store = new Store(join(home, 'sessions')); await store.init()
    const bus = new Bus(), tools = new Tools(home)
    const importer = new ImportTool(new Map(), home, 'fixture')
    tools.register(new InvokeTool(importer))
    tools.register(new UseProjectTool({ projectId: 'fixture', folders,
      beforeSwitch: async (ctx, folderId) => dispatcher.assertBootstrapBinding(ctx.sessionId, folderId) }))
    let inferences = 0, registered = '', isolated = '', workerId = '', completed = false, failPreparation = true
    const receipts: string[] = []
    const provider: LLMProvider = { name: 'fixture', listModels: () => ['fixture'], chat: async messages => {
      inferences++
      const last = messages.filter(message => message.role === 'tool').at(-1)
      if (last) receipts.push(String(last.content))
      const invoke = (args: Record<string, unknown>) => ({ content: '', toolCalls: [{ id: `step-${inferences}`, name: 'invoke_tool', arguments: { name: 'work_bootstrap', args } }] })
      if (inferences === 1) {
        assert.equal(manager.getSessionState(workerId)?.automaticWork?.phase, 'bootstrap')
        assert.equal(manager.getSessionState(workerId)?.folderId, undefined)
        return invoke({ action: 'register', nodeId: LOCAL_NODE_ID, path: source })
      }
      if (inferences === 2) {
        registered = JSON.parse(String(last!.content)).folder.id
        return { content: '', toolCalls: [{ id: 'deny-source', name: 'workspace_use', arguments: { workspace: registered } }] }
      }
      if (inferences === 3) {
        assert.match(String(last!.content), /host-prepared/)
        assert.equal(manager.getSessionState(workerId)?.folderId, undefined)
        return invoke({ action: 'prepare', folderId: registered, branch: 'refs/remotes/origin/baseline' })
      }
      if (inferences === 4) {
        assert.match(String(last!.content), /injected preparation failure/)
        assert.equal(manager.getSessionState(workerId)?.automaticWork?.phase, 'bootstrap')
        assert.equal((await store.getState(workerId))?.automaticWork?.phase, 'bootstrap')
        assert.equal(manager.getSessionState(workerId)?.folderId, undefined)
        return invoke({ action: 'prepare', folderId: registered, branch: 'refs/remotes/origin/baseline' })
      }
      if (inferences === 5) {
        isolated = JSON.parse(String(last!.content)).folderId
        assert.notEqual(isolated, registered)
        return invoke({ action: 'prepare', folderId: registered, branch: 'refs/remotes/origin/baseline' })
      }
      if (inferences === 6) {
        await assert.rejects(dispatcher.prepareBootstrap(workerId, registered, 'refs/heads/main', signal), /same base/)
        await assert.rejects(dispatcher.prepareBootstrap(workerId, 'different-source', 'refs/remotes/origin/baseline', signal), /same source/)
        assert.equal(JSON.parse(String(last!.content)).folderId, isolated, 'retry reuses isolated receipt')
        return { content: '', toolCalls: [{ id: 'bind-isolated', name: 'workspace_use', arguments: { workspace: isolated } }] }
      }
      assert.match(String(last!.content), /Working context committed/)
      const state = manager.getSessionState(workerId)!
      assert.equal(state.folderId, isolated); assert.equal(state.automaticWork?.phase, 'implementation')
      completed = true
      return { content: 'Fixture implementation can now start in isolation.', toolCalls: [] }
    } }
    const manager = new SessionManager({ workspace: home, projectId: 'fixture', store, bus, provider, tools,
      ownsFolder: (id: string) => !!folders.get(id), ownsWorkdir: (ref: any) => !!folders.lookupWorkdir(ref),
      workdirLookup: (ref: any) => folders.lookupWorkdir(ref) ?? { node: 'missing' },
      backgroundTasks: { listTasks: () => [] },
      agentTypes: { resolve: (name: string) => ({ name, description: '', prompt: '', source: 'builtin', defaultMode: 'session' }) },
      context: { buildSystemPrompt: async () => 'Synthetic system prompt' },
      handoffManager: { shouldHandoff: () => false, getContextPolicy: () => undefined },
      getLlmRuntimeConfig: () => ({ model: 'fixture', contextWindow: 128000, temperature: 0 }),
    } as unknown as SessionManagerDeps)
    const initiatives = new InitiativeStore(home, { isSessionKnown: id => !!manager.getSessionState(id) })
    const alignment = new WorkAlignment(initiatives, { state: id => manager.getSessionState(id), evidence: async () => {}, changed: (r, p) => manager.notifyWorkChange(r, p) })
    manager.alignment = alignment
    const dispatcher = new WorkDispatcher({ projectId: 'fixture', store: initiatives, sessions: manager,
      validateProgram: async () => {}, targets: () => [],
      validateTarget: async config => { if (!config.folderId) throw new Error('Source required'); await folders.requireExecutionAvailable(config.folderId) },
      prepare: async (config, id, signal) => {
        if (failPreparation) { failPreparation = false; throw new Error('injected preparation failure; no implementation allowed') }
        const result = await derived.createDerivedWorkspace({ source: config.folderId!, branch: config.baseBranch!, idempotencyKey: `automation:${id}` }, signal)
        return { folderId: result.workspaceId, path: result.path, branch: result.branch }
      }, verify: async (config, id, execution) => {
        assert.equal(manager.getSessionState(id)?.folderId, execution.folderId)
        assert.equal(config.folderId, registered)
        await derived.verify((await derived.retained(`automation:${id}`))!, signal)
      }, changed: (r, p) => manager.notifyWorkChange(r, p) })
    const bootstrap = new WorkBootstrapTool('fixture', dispatcher, (nodeId, path, signal) => pickFolder({ registry: folders,
      picker: { inventory: () => ({ nodes: [{ nodeId: LOCAL_NODE_ID, role: 'main', connection: 'connected' }] } as any), executor: {} as any } }, 'select', { nodeId, path }, signal))
    importer.registerBuiltin(bootstrap.name, bootstrap)
    let scans = 0
    dispatcher.setRunner(async (job, signal) => {
      scans++
      const work = initiatives.workRecords()[0]
      const record = await dispatcher.dispatchWork(job, work.key, work.sequence, {}, signal)
      workerId = record.workflow!.assignee!
    })
    // Capture identity before the first inference, not after async dispatch returns.
    bus.on('session.changed', fact => { if (manager.getSessionState(fact.sessionId)?.automaticWork) workerId = fact.sessionId })
    const job = { ...WORK_DISPATCH_AUTOMATION, program: workDispatchConfigSchema.parse({ kind: 'work-dispatch' }), id: WORK_DISPATCH_ID, createdAt: new Date().toISOString() }
    try {
      await manager.start()
      await dispatcher.dispatch(job, signal); assert.equal(scans, 0); assert.equal(inferences, 0)
      const work = await alignment.execute({ kind: 'user' }, 'create', undefined, undefined,
        { title: 'Bootstrap fixture', definition: { objective: 'Use authorized disposable source' }, assignee: null }) as WorkRecord
      await dispatcher.dispatch(job, signal)
      const deadline = Date.now() + 10000
      while (!completed && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
      assert.equal(completed, true, JSON.stringify(receipts))
      assert.equal(scans, 1); assert.equal(inferences, 7)
      assert.equal(alignment.get(work.key).workflow?.assignee, workerId)
      assert.equal(await readFile(join(source, 'tracked'), 'utf8'), 'private dirty source')
      assert.equal(await readFile(join(folders.get(isolated)!.path, 'tracked'), 'utf8'), 'committed')
      const ctx = { projectId: 'fixture', sessionId: workerId, signal, toolCallName: 'invoke_tool' } as ExecutionContext
      await assert.rejects(bootstrap.execute({ action: 'prepare', folderId: registered, branch: 'refs/remotes/origin/baseline' }, ctx), /bootstrap assignee/)
      await assert.rejects(bootstrap.execute({ action: 'register', nodeId: LOCAL_NODE_ID, path: source }, { ...ctx, projectId: 'foreign' }), /direct/)
      await assert.rejects(bootstrap.execute({ action: 'register', nodeId: LOCAL_NODE_ID, path: source }, { ...ctx, sessionId: 'other' }), /bootstrap assignee/)
      await assert.rejects(bootstrap.execute({ action: 'prepare', folderId: registered, branch: 'refs/remotes/origin/baseline' }, { ...ctx, scriptInvocation: true }), /direct/)
      await manager.stop()
      const saved = await store.getState(workerId)
      assert.equal(saved?.automaticWork?.phase, 'implementation')
      assert.equal(saved?.automaticWork?.prepared?.folderId, isolated)
      assert.equal(saved?.automaticWork?.limits.folderId, registered)
      assert.equal(saved?.automaticWork?.limits.baseBranch, 'refs/remotes/origin/baseline')
    } finally { await manager.stop(); store.close?.(); initiatives.close() }
  }))
}

test('bootstrap registration requires explicit online exact device; remote failures and wrong-device receipts never touch Main', async () => {
  const { FOLDER_BROWSE_OPERATION, FOLDER_SELECT_OPERATION } = await import('../folders/picker.ts')
  let mainCalls = 0, remoteCalls = 0, transportCalls = 0, authorized = true, online = true, supported = true, mismatch = false, fail = false
  const ref = { version: 2 as const, nodeId: 'child', workdirId: `picked-v1:${'a'.repeat(64)}` }
  const dispatcher = { assertBootstrap: () => { if (!authorized) throw new Error('not current assignee') } } as unknown as WorkDispatcher
  const registry = {
    register: async () => { mainCalls++; throw new Error('Main must never run') },
    registerRemote: async (target: any) => { remoteCalls++; assert.deepEqual(target, ref); return { id: 'remote-source', kind: 'remote', workdir: target } as any },
  }
  const bootstrap = new WorkBootstrapTool('fixture', dispatcher, (nodeId, path, signal) => pickFolder({ registry,
    picker: { inventory: () => ({ nodes: [{ nodeId: 'child', role: 'child', connection: online ? 'connected' : 'offline', executionProtocol: 'compatible',
      support: { operations: supported ? [FOLDER_BROWSE_OPERATION, FOLDER_SELECT_OPERATION] : [] } }] } as any), executor: {
        async *execute(request: any) {
          transportCalls++; assert.equal(request.nodeId, 'child'); assert.equal(request.operation, FOLDER_SELECT_OPERATION)
          assert.deepEqual(request.args, { path: '/opaque/remote/repository' })
          if (fail) throw new Error('remote denied')
          yield { type: 'stdout', chunk: JSON.stringify({ ...ref, nodeId: mismatch ? 'other-child' : 'child' }) } as any
          yield { type: 'completed', receipt: { state: 'completed' } } as any
        }, getStatus: async () => undefined, cancel: async () => undefined,
      } as any } }, 'select', { nodeId, path }, signal))
  const context = { projectId: 'fixture', sessionId: 'worker', toolCallName: 'invoke_tool', signal: new AbortController().signal } as ExecutionContext
  const request = { action: 'register', nodeId: 'child', path: '/opaque/remote/repository' }
  await assert.rejects(bootstrap.execute({ action: 'register', path: request.path }, context))
  authorized = false; await assert.rejects(bootstrap.execute(request, context), /assignee/); authorized = true
  online = false; await assert.rejects(bootstrap.execute(request, context), /offline/); online = true
  supported = false; await assert.rejects(bootstrap.execute(request, context), /Update/); supported = true
  assert.equal(transportCalls, 0)
  fail = true; await assert.rejects(bootstrap.execute(request, context), /remote denied/); fail = false
  mismatch = true; await assert.rejects(bootstrap.execute(request, context), /Invalid selected folder/); mismatch = false
  assert.equal(remoteCalls, 0)
  assert.equal(JSON.parse(await bootstrap.execute(request, context)).folder.id, 'remote-source')
  assert.equal(remoteCalls, 1); assert.equal(mainCalls, 0)
  for (const patch of [{ scriptInvocation: true }, { recoveringToolCall: true }, { projectId: 'foreign' }, { remoteWorkdir: ref }]) {
    await assert.rejects(bootstrap.execute(request, { ...context, ...patch } as ExecutionContext), /direct/)
  }
  const controller = new AbortController(); controller.abort()
  await assert.rejects(bootstrap.execute(request, { ...context, signal: controller.signal }), /abort/i)
  assert.equal(transportCalls, 3); assert.equal(mainCalls, 0)
})
