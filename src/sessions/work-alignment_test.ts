import { ToolNoEffectError, completedToolFailure, requireToolText } from '../tools/tool.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { InitiativeStore } from '../initiatives/store.ts'
import { workKey, type WorkChange, type WorkRecord } from '../initiatives/work-contract.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { WorkAlignment } from './work-alignment.ts'
import { SessionTools, Tools } from '../tools/registry.ts'
import type { ExecutionContext } from '../tools/context.ts'
import type { SessionState } from './session-store.ts'
import { WorkTool, workReceipt } from '../tools/work.ts'
import { InitiativeTool } from '../tools/initiative.ts'
import { INITIATIVE_SCHEMA_PROMPT } from '../initiatives/schema.ts'
import { ReadTool } from '../tools/read.ts'
import { VirtualFs } from '../vfs/virtual-fs.ts'
import { AudioCppService } from '../audio-cpp/service.ts'
import { AudioCppTool } from '../tools/audio-cpp.ts'
import { parseDecisionEvidence } from './decision-brief.ts'
import { access, writeFile } from 'node:fs/promises'
import { ExecTool } from '../tools/shell.ts'
import { CommandHandlerManager } from '../tools/shell-commands/command-handler.ts'
import { ProcessManager } from '../execution/processes/manager.ts'
import { defaultManagedShell } from '../execution/processes/shells.ts'
import { BackgroundTaskManager } from '../agent/background-task.ts'
import { Bus } from '../bus/bus.ts'
import { EventService } from '../events/service.ts'
import { EvalBridgeRuntime } from '../script-runtime/bridge.ts'
import { createProjectScope } from '../projects/scope.ts'
import { McpConnection, type McpToolInfo } from '../mcp/client.ts'
import { McpToolAdapter } from '../mcp/adapter.ts'
import { mcpReadOnlyPolicy } from '../mcp/readonly.ts'
import type { McpServerConfig } from '../config/schema.ts'
import { InvokeTool } from '../tools/invoke-tool.ts'
import { MicroApps } from '../microapps/service.ts'
import { MicroAppTool } from '../tools/micro-app.ts'
import { CancelTool } from '../tools/cancel.ts'

const worker = 'web:worker', owner = 'web:owner', peer = 'web:peer'

test('MCP reads bypass Work admission, but unknown and write tools never reach paused or terminal Work', async t => withTempWorkspace(async workspace => {
  const f = fixture(workspace)
  const call = t.mock.method(McpConnection.prototype, 'callTool', async () => 'read result')
  const effects = t.mock.method(f.store, 'startWorkEffect')
  f.base.register(new InvokeTool())
  const config: McpServerConfig = { name: 'fixture', command: 'never-run', transport: 'stdio' }
  const info: McpToolInfo = { name: 'get_record', description: 'Fixture', inputSchema: { type: 'object' }, readOnlyHint: true }
  const fingerprint = mcpReadOnlyPolicy(config, info).fingerprint
  const policies: { config: McpServerConfig; info: McpToolInfo; allowed: boolean; unknown: boolean }[] = [
    { config, info, allowed: false, unknown: true },
    { config: { ...config, trustReadOnlyHints: true }, info, allowed: true, unknown: false },
    { config: { ...config, trustReadOnlyHints: true }, info: { ...info, readOnlyHint: false }, allowed: false, unknown: false },
    { config: { ...config, readOnlyOverrides: { get_record: { readOnly: true, fingerprint } } }, info, allowed: true, unknown: false },
    { config: { ...config, trustReadOnlyHints: true, readOnlyOverrides: { get_record: { readOnly: false, fingerprint } } }, info, allowed: false, unknown: false },
    { config: { ...config, trustReadOnlyHints: true, readOnlyOverrides: { get_record: { readOnly: true, fingerprint: '0'.repeat(64) } } }, info, allowed: false, unknown: true },
  ]
  try {
    f.store.migrateWorkItems()
    const work = await f.alignment.execute({ kind: 'session', sessionId: worker }, 'create', undefined, undefined, {
      title: 'Fixture', definition: change().definition, reason: 'Synthetic request',
    }) as WorkRecord
    await f.adopt(work.key)
    for (const state of ['paused', 'done', 'cancelled', 'transition'] as const) {
      const current = f.alignment.get(work.key)
      f.store.saveWork({
        ...current, sequence: current.sequence + 1, paused: state === 'paused',
        workflow: { ...current.workflow!, status: state === 'done' || state === 'cancelled' ? state : 'pending' },
        transition: state === 'transition'
          ? { id: randomUUID(), strategy: 'fresh', sessionId: worker, revision: 1, status: 'pending' } : undefined,
      }, current.sequence, worker, 'fixture')
      for (const policy of policies) {
        f.tools.registerDynamic(new McpToolAdapter(new McpConnection(policy.config), policy.info))
        const before = call.mock.callCount()
        const result = requireToolText(await f.tools.execute('invoke_tool', { name: 'fixture__get_record', args: {} }, f.context()))
        if (policy.allowed) assert.equal(result, 'read result')
        else {
          assert.match(result, state === 'paused' ? /is paused/ : state === 'transition' ? /context transition/ : new RegExp(`terminal \\(${state}\\)`))
          if (state !== 'paused') assert.doesNotMatch(result, /is paused/)
          if (policy.unknown) assert.match(result, /not confirmed read-only/)
        }
        assert.equal(call.mock.callCount() - before, policy.allowed ? 1 : 0)
        assert.equal(f.store.workEffects().length, 0)
      }
    }
    f.tools.registerDynamic(new McpToolAdapter(new McpConnection({ ...config, trustReadOnlyHints: true }), info))
    const before = call.mock.callCount()
    await assert.rejects(f.tools.execute('invoke_tool', { name: 'fixture__get_record', args: {} },
      { ...f.context(), signal: AbortSignal.abort() }), /abort/i)
    assert.match(requireToolText(await f.tools.execute('invoke_tool', { name: 'fixture__get_record', args: {} }, {
      ...f.context(), remoteWorkdir: {
        nodeId: 'remote', capabilityId: 'opaque', get executor(): never { throw new Error('Must not use remote executor') },
      },
    })), /remote workdirs/)
    assert.equal(call.mock.callCount(), before)
    assert.equal(effects.mock.callCount(), 0, 'Read-only calls must never start Work effects')
  } finally { f.tools.resetDynamic(); f.store.close() }
}))

const adoption = { understanding: 'Both evaluations are required.', stop: ['Treating smoke as final scope'], retain: ['Verified inputs'], next: ['Run a bounded first phase'] }
const inventory = { completed: ['Collected inputs'], artifacts: ['synthetic/report.json'], inFlight: [], unknown: [], retired: ['Smoke-only goal'] }
function change(revision = 0): WorkChange {
  return { subject: { kind: 'topic', sessionId: worker }, expectedRevision: revision,
    change: 'understanding', reason: 'Keep final outcome distinct from execution staging.', paused: false,
    definition: { objective: 'Run both independent evaluations', acceptance: ['Both have attributable results'], boundaries: ['No publication authority'], evidence: [] } }
}
function fixture(workspace: string, trackWork = false) {
  const states: Record<string, SessionState> = Object.fromEntries([worker, owner, peer].map(sessionId => [sessionId, { sessionId, mode: 'session', segmentIndex: 0 }]))
  const options = { trackWork, isSessionKnown: (id: string) => !!states[id] }
  const store = new InitiativeStore(workspace, options)
  const changes: WorkRecord[] = [], transitions: WorkRecord[] = []
  const alignment = new WorkAlignment(store, {
    state: id => states[id], evidence: async () => { throw new Error('No evidence fixture for this source.') },
    changed: async record => { changes.push(record) },
    fresh: async (_, record) => { transitions.push(record) },
    successor: async () => 'web:successor',
  })
  const base = new Tools(workspace)
  base.setWorkGuard(alignment)
  base.register(new WorkTool(alignment))
  const tools = new SessionTools(base, workspace)
  const context = (id = worker): ExecutionContext => ({
    sessionId: id, physicalSessionId: 'synthetic.0', channel: 'web', chatId: id.slice(4), senderId: 'fixture',
    messageId: randomUUID(), signal: new AbortController().signal, projectId: 'project', tools,
    workStamps: alignment.snapshot(id),
  })
  const apply = async (request = change(), human = false) => {
    await alignment.execute(human ? { kind: 'user' } : { kind: 'session', sessionId: worker }, 'update', undefined, undefined, request)
    return alignment.get(workKey(request.subject))
  }
  const adopt = async (key = workKey(change().subject), revision = 1, id = worker) =>
    alignment.execute({ kind: 'session', sessionId: id }, 'adopt', key, revision, adoption)
  return { states, options, store, alignment, base, tools, context, apply, adopt, changes, transitions }
}

test('runtime Work facts distinguish absent contracts and the current authenticated owner input', async () => withTempWorkspace(async workspace => {
  const f = fixture(workspace)
  try {
    const ownerContext = { ...f.context(), inputSource: 'user' as const, admin: true, isGroup: false, workUserInput: 'Append one requirement.' }
    assert.match(f.alignment.prompt(worker, ownerContext), /Work mode: optional[\s\S]*Ordinary requests execute directly/)
    const restrictedTools = new SessionTools(f.base, workspace, ['read'])
    assert.doesNotMatch(f.alignment.prompt(peer, { ...f.context(peer), tools: restrictedTools }), /Before exec|must create/,
      'Do not instruct roles without Work access to create work')
    await f.apply(); await f.adopt()
    for (const input of [
      ownerContext, { ...ownerContext, admin: false }, { ...ownerContext, isGroup: true },
      { ...ownerContext, inputSource: 'session' as const }, { ...ownerContext, inputSource: 'event' as const },
      { ...ownerContext, workUserInput: undefined }, { ...ownerContext, channel: 'a2a' },
    ]) {
      const allowed = input === ownerContext
      const prompt = f.alignment.prompt(worker, input)
      assert.match(prompt, allowed ? /Current input supports an owner-directed additive/ : /requestQuote is unavailable/)
      const result = JSON.parse(requireToolText(await f.tools.execute('work', { action: 'context' }, input)))
      assert.deepEqual(result.currentInput, { ownerFollowup: allowed })
      assert.equal(f.alignment.get(workKey(change().subject)).revision, 1, 'Facts never change a contract or grant approval')
    }
  } finally { f.store.close() }
}))

test('Work tool receipts omit repeated definitions but retain fencing, waits, effects and full-detail access', async () => withTempWorkspace(async workspace => {
  const f = fixture(workspace)
  const invoke = async (args: Record<string, unknown>) => JSON.parse(requireToolText(await f.tools.execute('work', args, f.context())))
  try {
    const initial = await invoke({ action: 'context' })
    assert.ok(initial.schema.create)
    const definition = { objective: 'Deliver the complete reusable application. '.repeat(12),
      acceptance: Array.from({ length: 8 }, (_, index) => `${index}: Preserve the requested behavior, repeat-use lifecycle and attributable verification. `.repeat(3)),
      boundaries: ['No implicit approval or device access. '.repeat(8)], evidence: [] }
    const created = await invoke({ action: 'create', data: { title: 'Receipt fixture', reason: 'Synthetic test', definition } })
    assert.equal(created.definition, undefined)
    assert.equal(created.definitionChanged, true)
    assert.equal(created.acceptanceCount, 8)
    assert.equal(created.workflow.assignmentRevision, 1)
    assert.equal(created.authority.executor, worker)
    assert.equal(created.paused, false)
    assert.equal(created.adoption, null)
    const stored = f.alignment.get(created.key)
    assert.ok(JSON.stringify(created).length < JSON.stringify(stored).length * 0.5, 'Representative mutation receipt shrinks by at least half')
    const detail = await invoke(created.detail)
    assert.deepEqual(detail.records[0].definition, stored.definition)
    assert.equal(detail.schema, undefined)
    assert.deepEqual((await invoke(detail.schemaRequest)).schema, initial.schema)
    assert.deepEqual(detail.currentInput, { ownerFollowup: false })
    const adopted = await invoke({ action: 'adopt', key: created.key, revision: created.revision,
      data: { understanding: 'Complete scope', next: ['Verify'], acceptance: ['One additional in-scope check'] } })
    assert.equal(adopted.revision, 2)
    assert.equal(adopted.definitionChanged, true)
    assert.equal(adopted.acceptanceCount, 9)
    assert.equal(adopted.adoption.revision, 2)
    assert.equal(adopted.adoption.sessionId, worker)
    assert.equal(adopted.adoption.understanding, undefined)
    assert.match(requireToolText(await f.tools.execute('work', { action: 'progress', key: created.key, revision: 1,
      data: { expectedSequence: adopted.sequence, status: 'in_progress' } }, f.context())), /revision changed/)
    const effectId = randomUUID()
    f.store.startWorkEffect(effectId, worker, 'fixture', f.alignment.snapshot(worker))
    f.store.finishWorkEffect(effectId, true)
    const blocked = await invoke({ action: 'progress', key: created.key, revision: 2,
      data: { expectedSequence: adopted.sequence, status: 'blocked', blockedScope: 'step', blockedReason: 'Await exact owner review' } })
    assert.equal(blocked.workflow.blockedReason, 'Await exact owner review')
    assert.equal(blocked.workflow.blockedScope, 'step')
    assert.equal(blocked.definitionChanged, false)
    assert.ok(blocked.effects.some((effect: { id: string; status: string }) => effect.id === effectId && effect.status === 'unknown'))
    assert.deepEqual((await invoke(blocked.detail)).effects, blocked.effects)
    const pending: WorkRecord = { ...f.alignment.get(created.key),
      checkpoint: { sessionId: worker, revision: 2, completed: ['Source saved'], artifacts: ['app.html'],
        inFlight: ['Existing background job'], unknown: [effectId], retired: [] },
      transition: { id: randomUUID(), strategy: 'successor', sessionId: worker, revision: 2, status: 'pending' },
      answerReview: { requestId: 'pending-answer', text: 'Owner answer is not adopted yet' },
      proposals: [{ id: randomUUID(), baseRevision: 2, assignmentRevision: 1, change: 'goal',
        reason: 'Needs explicit review', definition: stored.definition, paused: false, status: 'pending' }],
    }
    const receipt = workReceipt(pending, f.alignment.context(worker, created.key, false), 2)
    assert.deepEqual(receipt.checkpoint, pending.checkpoint)
    assert.deepEqual(receipt.transition, pending.transition)
    assert.deepEqual(receipt.answerReview, pending.answerReview)
    assert.equal(receipt.pendingProposals?.[0].id, pending.proposals![0].id)
    assert.equal(receipt.pendingProposals?.[0].baseRevision, 2)
    assert.equal('definition' in receipt.pendingProposals![0], false)
    assert.match(requireToolText(await f.tools.execute('work', { action: 'context', data: { includeSchema: 'yes' } }, f.context())), /Error/)
    assert.equal(f.alignment.get(created.key).sequence, blocked.sequence, 'Read validation never changes persisted state')
  } finally { f.store.close() }
}))

test('exec argument rejection has no unknown effect and never starts local or remote execution', async t => withTempWorkspace(async workspace => {
  const f = fixture(workspace), manager = new ProcessManager(), bus = new Bus()
  const events = new EventService(workspace, bus, async (sessionId, input) => ({ status: 'accepted', sessionId, inputId: input.id }))
  const tasks = new BackgroundTaskManager(bus, events)
  const commandHandler = new CommandHandlerManager()
  f.base.register(new ExecTool(workspace, 120_000, commandHandler, manager, defaultManagedShell(), tasks))
  const spawn = t.mock.method(manager, 'spawn', async () => { throw new Error('Must not spawn') })
  try {
    await f.apply(); await f.adopt()
    for (const remote of [false, true]) {
      const context = { ...f.context(), cwd: workspace, ...(remote ? { remoteWorkdir: {
        nodeId: 'remote', capabilityId: 'opaque', get executor(): never { throw new Error('Must not contact remote') },
      } } : {}) }
      for (const args of [{ script: 'print("not executed")', shell: 'python' }, { shell: 'node' }, { script: ' ' }]) {
        assert.match(requireToolText(await f.tools.execute('exec', args, context)), /Error executing exec:.*(shell|script)/)
        assert.deepEqual(f.store.workEffects(), [])
        f.alignment.assertCurrent(f.alignment.snapshot(worker), worker)
      }
    }
    assert.equal(spawn.mock.callCount(), 0)
    assert.deepEqual(manager.list(), [])
  } finally { await tasks.stop(); await events.stop(); bus.stopAll(); f.store.close() }
}))

for (const shell of [defaultManagedShell(), 'node'] as const) {
  for (const failed of [false, true]) {
    test(`Work receipts use ${shell} execution status, not successful-looking output (${failed ? 'failed' : 'success'})`, async () => withTempWorkspace(async workspace => {
      const f = fixture(workspace), manager = new ProcessManager(), bus = new Bus()
      const scope = createProjectScope('project')
      const runtime = new EvalBridgeRuntime({ projectId: scope.projectId, scope })
      const events = new EventService(workspace, bus, async (sessionId, input) => ({ status: 'accepted', sessionId, inputId: input.id }))
      const tasks = new BackgroundTaskManager(bus, events)
      f.base.register(new ExecTool(workspace, 120_000, new CommandHandlerManager(), manager, defaultManagedShell(), tasks))
      try {
        await f.apply()
        await f.adopt()
        const source = failed
          ? 'console.log("PASS before failure"); console.error("assertion failed"); throw new Error("fixture failure")'
          : 'console.log("Error: quoted test fixture, not failure"); console.error("warning")'
        const file = join(workspace, 'outcome.cjs')
        await writeFile(file, source)
        const result = await f.tools.execute('exec', {
          shell, script: shell === 'node' ? source : `"${process.execPath}" "${file}"`,
        }, { ...f.context(), cwd: workspace, evalBridge: runtime })
        const text = requireToolText(result)
        if (failed) {
          assert.match(text, /PASS before failure/)
          assert.match(text, /assertion failed/)
          if (shell === 'node') assert.equal(JSON.parse(text).ok, false, 'JSON script envelope stays compatible')
          else assert.match(text, /^Error: command exited with code 1/)
          assert.equal(f.store.workEffects().length, 0, 'A complete error receipt is not a lost execution or a rollback')
          assert.ok(f.store.workHistory(workKey(change().subject)).some(event => event.kind === 'tool_result'
            && (event.data as { outcome: string }).outcome === 'returned_error'))
          f.alignment.assertCurrent(f.alignment.snapshot(worker), worker)
        } else {
          assert.match(text, /Error: quoted test fixture/)
          assert.equal(f.store.workEffects().length, 0)
          f.alignment.assertCurrent(f.alignment.snapshot(worker), worker)
        }
      } finally {
        await tasks.stop(); await events.stop(); bus.stopAll()
        for (const managed of manager.list()) await manager.terminate(managed)
        await runtime.shutdown(); scope.close(); f.store.close()
      }
    }))
  }
}

test('adopting feedback does not silently unblock work; diagnostics distinguish progress from approval', async () => withTempWorkspace(async workspace => {
  const f = fixture(workspace)
  const actor = { kind: 'session' as const, sessionId: worker }
  try {
    f.store.migrateWorkItems()
    const work = await f.alignment.execute(actor, 'create', undefined, undefined, {
      title: 'Feedback', definition: change().definition, reason: 'Synthetic request',
    }) as WorkRecord
    await f.adopt(work.key)
    await f.alignment.execute(actor, 'progress', work.key, work.revision, {
      expectedSequence: f.alignment.get(work.key).sequence, status: 'blocked', blockedReason: 'Awaiting a requirement answer', blockedScope: 'work',
    })
    await f.adopt(work.key)
    assert.equal(f.alignment.get(work.key).workflow?.status, 'blocked')
    assert.throws(() => f.alignment.assertCurrent(f.alignment.snapshot(worker), worker),
      /Awaiting a requirement answer[\s\S]*Adoption does not change progress[\s\S]*Do not clear an unmet approval/)
    await f.alignment.execute(actor, 'progress', work.key, work.revision, {
      expectedSequence: f.alignment.get(work.key).sequence, status: 'in_progress',
    })
    f.alignment.assertCurrent(f.alignment.snapshot(worker), worker)
    assert.deepEqual(f.alignment.get(work.key).definition, work.definition, 'Resuming progress cannot broaden authority')
  } finally { f.store.close() }
}))

test('step waits permit independent work without changing progress or bypassing explicit fences', async () => withTempWorkspace(async workspace => {
  const f = fixture(workspace)
  const actor = { kind: 'session' as const, sessionId: worker }
  let writes = 0
  f.base.register({ name: 'fixture_write', description: '', parameters: { type: 'object', properties: {} },
    async execute() { writes++; return 'saved independent work' } })
  try {
    f.store.migrateWorkItems()
    const work = await f.alignment.execute(actor, 'create', undefined, undefined,
      { title: 'Independent preparation', definition: change().definition, reason: 'Synthetic request' }) as WorkRecord
    await f.adopt(work.key)
    const progress = (data: object) => f.alignment.execute(actor, 'progress', work.key, 1,
      { expectedSequence: f.alignment.get(work.key).sequence, ...data })
    await progress({ status: 'blocked', blockedReason: 'Publication approval pending' })
    assert.equal(f.alignment.get(work.key).workflow?.blockedScope, 'step')
    assert.equal(await f.tools.execute('fixture_write', {}, f.context()), 'saved independent work')
    assert.equal(f.alignment.get(work.key).workflow?.status, 'blocked')
    assert.deepEqual(f.alignment.get(work.key).definition, work.definition)
    const effect = randomUUID()
    f.store.startWorkEffect(effect, worker, 'uncertain_publish', f.alignment.snapshot(worker))
    f.store.finishWorkEffect(effect, true)
    assert.match(requireToolText(await f.tools.execute('fixture_write', {}, f.context())), /unknown outcome/)
    f.store.finishWorkEffect(effect, false)
    await progress({ status: 'blocked', blockedReason: 'Explicit whole-work hold', blockedScope: 'work' })
    await progress({ status: 'blocked', blockedReason: 'Still waiting' })
    assert.equal(f.alignment.get(work.key).workflow?.blockedScope, 'work', 'Updating the reason must not weaken an existing hold')
    assert.match(requireToolText(await f.tools.execute('fixture_write', {}, f.context())), /is blocked/)
    await progress({ status: 'blocked', blockedReason: 'Independent preparation is available', blockedScope: 'step' })
    const current = f.alignment.get(work.key)
    f.store.saveWork({ ...current, sequence: current.sequence + 1, paused: true }, current.sequence, 'human', 'fixture_pause')
    assert.match(requireToolText(await f.tools.execute('fixture_write', {}, f.context())), /is paused/)
    assert.equal(writes, 1)
    await assert.rejects(progress({ status: 'in_progress', blockedScope: 'step' }), /requires blocked/)
  } finally { f.store.close() }
}))

test('dynamic argument rejection happens before Work effects and tool execution', async () => withTempWorkspace(async workspace => {
  const f = fixture(workspace)
  let executions = 0
  const tool = { name: 'validated_write', description: '', parameters: {
    type: 'object' as const, properties: { value: { type: 'integer' } }, required: ['value'], additionalProperties: false,
  }, async execute() { executions++; return 'saved' } }
  f.tools.registerDynamic(tool)
  try {
    await f.apply(); await f.adopt()
    for (const args of [{}, { value: 'wrong' }, { value: 1, extra: true }]) {
      assert.match(requireToolText(await f.tools.executeDynamic(tool.name, args, f.context())), /invalid arguments[\s\S]*no tool was executed/)
      assert.deepEqual(f.store.workEffects(), [])
    }
    assert.equal(executions, 0)
    assert.equal(await f.tools.executeDynamic(tool.name, { value: 1 }, f.context()), 'saved')
    assert.equal(executions, 1)
    assert.deepEqual(f.store.workEffects(), [])
  } finally { f.store.close() }
}))

test('runtime effect hints are bounded, scoped and never invent a missing result reference', async () => withTempWorkspace(async workspace => {
  const f = fixture(workspace)
  try {
    await f.apply(); await f.adopt()
    const ids = Array.from({ length: 5 }, () => randomUUID())
    for (const id of ids) {
      f.store.startWorkEffect(id, worker, 'fixture', f.alignment.snapshot(worker))
      f.store.finishWorkEffect(id, true)
    }
    const prompt = f.alignment.prompt(worker)
    assert.match(prompt, /Unresolved Work effects \(5; showing 3\)/)
    assert.equal(ids.filter(id => prompt.includes(id)).length, 3)
    assert.doesNotMatch(prompt, /"resultSource":/)
    assert.doesNotMatch(f.alignment.prompt(peer), /Unresolved Work effects/)
    assert.throws(() => f.alignment.assertCurrent(f.alignment.snapshot(worker), worker), /unknown outcome/)
    const large = '\0'.repeat(511) + 'x'
    for (const id of ids) f.store.workEvent(workKey(change().subject), worker, 'tool_result', {
      invocationId: id, resultSource: { sessionId: large, physicalId: large, kind: 'tool', id: large },
    })
    const compact = f.alignment.prompt(worker)
    assert.match(compact, /Result references exceed automatic context/)
    assert.doesNotMatch(compact, /\\u0000/)
    assert.ok(compact.slice(compact.indexOf('# Unresolved Work effects')).length < 8000)
    for (const id of ids) f.store.finishWorkEffect(id, false)
    assert.doesNotMatch(f.alignment.prompt(worker), /# Unresolved Work effects/)
  } finally { f.store.close() }
}))

test('progress discovery describes evidence as references, not a list of strings', async () => withTempWorkspace(async workspace => {
  const f = fixture(workspace)
  try {
    const { schema } = f.alignment.context(worker)
    assert.deepEqual(schema.management.progress.result.evidence, [schema.evidenceSchema])
    assert.deepEqual(Object.keys(schema.management.progress.result.evidence[0]).sort(),
      ['id', 'kind', 'physicalId', 'quote', 'sessionId'])
  } finally { f.store.close() }
}))

test('contracts separate human provenance, agent phase, control and executor adoption', async () => withTempWorkspace(async workspace => {
  const f = fixture(workspace)
  try {
    const record = await f.apply()
    assert.equal(record.origin, 'agent_interpretation')
    assert.throws(() => f.alignment.assertCurrent(f.alignment.snapshot(worker), worker), /not adopted/)
    await assert.rejects(f.alignment.execute({ kind: 'user' }, 'adopt', record.key, 1, adoption), /cannot impersonate/)
    await assert.rejects(f.alignment.execute({ kind: 'session', sessionId: peer }, 'adopt', record.key, 1, adoption), /Only the current/)
    await f.adopt()
    f.alignment.assertCurrent(f.alignment.snapshot(worker), worker)
    assert.equal(f.alignment.get(record.key).definition.objective, 'Run both independent evaluations')
    assert.deepEqual(f.alignment.get(record.key).adoption?.next, adoption.next)
    await assert.rejects(f.alignment.execute({ kind: 'session', sessionId: peer }, 'update', undefined, undefined, change(1)), /Only the work controller/)
    const proposed = await f.alignment.execute({ kind: 'session', sessionId: peer }, 'propose', undefined, undefined, change(1))
    assert.equal((proposed as { status: string }).status, 'proposed')
    assert.equal(f.alignment.get(record.key).revision, 1)
    await f.apply(change(1), true)
    await assert.rejects(f.apply(change(2)), /human review/)
    await assert.rejects(f.apply(change(1), true), /revision changed/)
    assert.throws(() => f.store.query('SELECT * FROM work_contracts', worker), /Unknown/)
  } finally { f.store.close() }
}))

test('Work evidence reports the actual field and shared reference shape, not a Decision brief', async () => withTempWorkspace(async workspace => {
  const f = fixture(workspace)
  try {
    const result = requireToolText(await f.tools.execute('work', { action: 'create', data: {
      title: 'Fixture', reason: 'User request',
      definition: { objective: 'Outcome', acceptance: ['Verified'], boundaries: [], evidence: ['user said so'] },
    } }, f.context()))
    assert.match(result, /definition\.evidence\.0/)
    assert.match(result, /sessionId, physicalId, kind/)
    assert.doesNotMatch(result, /Decision brief requires an object/)
    const help = JSON.stringify(await f.alignment.execute({ kind: 'session', sessionId: worker }, 'context', undefined, undefined, undefined))
    assert.match(help, /evidenceSchema/)
    assert.match(help, /physicalId/)
    assert.throws(() => parseDecisionEvidence('summary', 'data.evidence'), /data\.evidence.*evidence reference/)
    const reference = { sessionId: worker, physicalId: 'segment', kind: 'tool' as const, id: 'call', quote: 'receipt' }
    assert.deepEqual(parseDecisionEvidence(reference), reference)
    assert.throws(() => parseDecisionEvidence({ ...reference, quote: '' }), /evidence\.quote/)
  } finally { f.store.close() }
}))

test('audio catalog rejection stays a visible failure without fencing unrelated work; uncertain errors still fence', async () => withTempWorkspace(async workspace => {
  const f = fixture(workspace)
  let probeFailure = false
  const service = new AudioCppService(workspace, async () => {
    if (probeFailure) throw new Error('Probe terminated unexpectedly')
    return '{"schema_version":1,"loaders":{}}'
  })
  f.base.register(new AudioCppTool(service, 'project', workspace))
  f.base.register({ name: 'write_fixture', description: '', parameters: { type: 'object', properties: {} }, async execute() { return 'written' } })
  try {
    await f.apply(); await f.adopt()
    assert.match(requireToolText(await f.tools.execute('audio_cpp', { action: 'configure', binary: process.execPath }, f.context())), /Configuration was not written/)
    await assert.rejects(access(join(workspace, '.audio-cpp.json')), { code: 'ENOENT' })
    assert.equal(f.store.workEffects().length, 0)
    assert.ok(f.store.workHistory(workKey(change().subject)).some(event => event.kind === 'tool_result'
      && (event.data as { outcome: string }).outcome === 'not_applied'))
    assert.equal(await f.tools.execute('write_fixture', {}, f.context()), 'written')
    probeFailure = true
    assert.match(requireToolText(await f.tools.execute('audio_cpp', { action: 'configure', binary: process.execPath }, f.context())), /terminated unexpectedly/)
    assert.equal(f.store.workEffects()[0].status, 'unknown')
    assert.match(requireToolText(await f.tools.execute('write_fixture', {}, f.context())), /unknown|unresolved/i)
  } finally { f.store.close() }
}))

test('Micro App manifest preflight does not fence recovery, but a lost publication acknowledgement remains uncertain', async t => withTempWorkspace(async workspace => {
  const f = fixture(workspace)
  const service = new MicroApps('project', workspace, () => ({
    name: 'unused', listModels: async () => [],
    chat: async () => { throw new Error('Publication must not call a model') },
  }), () => 'unused')
  await service.init()
  f.base.register(new InvokeTool())
  f.tools.registerDynamic(new MicroAppTool(service, id => assert.equal(id, worker)))
  const publish = service.publish.bind(service)
  let loseAcknowledgement = false
  const calls = t.mock.method(service, 'publish', async (...args: Parameters<MicroApps['publish']>) => {
    const result = await publish(...args)
    if (loseAcknowledgement) throw new Error('Synthetic lost publication acknowledgement')
    return result
  })
  const invoke = (args: Record<string, unknown>) => f.tools.execute('invoke_tool', { name: 'micro_app', args },
    { ...f.context(), cwd: workspace })
  const manifest = { version: 1, name: 'Fixture', description: 'No model calls', entry: 'index.html', files: ['index.html'] }
  try {
    await f.apply(); await f.adopt()
    await writeFile(join(workspace, 'index.html'), '<title>Fixture</title>')
    for (const content of ['{', JSON.stringify({ ...manifest, llm: { maxCalls: 0, maxOutputTokens: 0 } }), ' '.repeat(65537)]) {
      await writeFile(join(workspace, 'shadow-app.json'), content)
      assert.match(requireToolText(await invoke({ action: 'publish', directory: '.' })), /source validation failed before publication/)
      assert.equal(calls.mock.callCount(), 0)
      assert.equal(f.store.workEffects().length, 0)
      assert.deepEqual(service.list(), [])
    }
    await writeFile(join(workspace, 'shadow-app.json'), JSON.stringify(manifest))
    const app = JSON.parse(requireToolText(await invoke({ action: 'publish', directory: '.' })))
    assert.equal(calls.mock.callCount(), 1)
    assert.equal(app.status, 'awaiting_approval')
    assert.equal(f.store.workEffects().length, 0)
    await writeFile(join(workspace, 'index.html'), '<title>Changed</title>')
    loseAcknowledgement = true
    assert.match(requireToolText(await invoke({ action: 'publish', directory: '.', id: app.id, revision: app.revision })), /lost publication acknowledgement/)
    assert.notEqual(service.get(app.id).revision, app.revision, 'The simulated acknowledgement failure follows a real publication')
    assert.equal(f.store.workEffects()[0].status, 'unknown')
    assert.match(requireToolText(await invoke({ action: 'publish', directory: '.' })), /unknown|unresolved/i)
    assert.equal(calls.mock.callCount(), 2, 'Uncertain publication must still block blind replay')
  } finally { await f.tools.resetDynamicAndWait(); await service.shutdown(); f.store.close() }
}))

test('only the trusted no-effect error clears an effect; error text and properties cannot impersonate it', async () => withTempWorkspace(async workspace => {
  const f = fixture(workspace)
  f.base.register({ name: 'preflight_fixture', description: '', parameters: { type: 'object', properties: {} },
    async execute() { throw new ToolNoEffectError('Validation failed before changes') } })
  f.base.register({ name: 'uncertain_fixture', description: '', parameters: { type: 'object', properties: {} },
    async execute() { throw Object.assign(new Error('Validation failed before changes'), { effect: 'none' }) } })
  try {
    await f.apply(); await f.adopt()
    assert.match(requireToolText(await f.tools.execute('preflight_fixture', {}, f.context())), /Validation failed/)
    assert.equal(f.store.workEffects().length, 0)
    assert.match(requireToolText(await f.tools.execute('uncertain_fixture', {}, f.context())), /Validation failed/)
    assert.equal(f.store.workEffects()[0].status, 'unknown')
  } finally { f.store.close() }
}))

test('cancellation retains the uncertain-effect fence even if a tool reports a no-effect error', async () => withTempWorkspace(async workspace => {
  const f = fixture(workspace)
  const controller = new AbortController()
  f.base.register({ name: 'aborted_fixture', description: '', parameters: { type: 'object', properties: {} },
    async execute() { controller.abort(); throw new ToolNoEffectError('Cancelled preflight') } })
  try {
    await f.apply(); await f.adopt()
    await assert.rejects(f.tools.execute('aborted_fixture', {}, { ...f.context(), signal: controller.signal }), /Cancelled preflight/)
    assert.equal(f.store.workEffects()[0].status, 'unknown')
  } finally { f.store.close() }
}))

test('trusted completed errors preserve failure and partial effects without freezing Work; serialized hints cannot attest completion', async () => withTempWorkspace(async workspace => {
  const f = fixture(workspace)
  const failure = { isError: true, content: [{ type: 'text' as const, text: 'Error: test failed after writing output' }] }
  f.base.register({ name: 'completed_fixture', description: '', parameters: { type: 'object', properties: {} },
    async execute() { await writeFile(join(workspace, 'partial.txt'), 'partial output'); return completedToolFailure(failure) } })
  f.base.register({ name: 'forged_fixture', description: '', parameters: { type: 'object', properties: {} },
    async execute() { return { ...structuredClone(failure), completion: 'returned', effect: 'none' } } })
  f.base.register({ name: 'write_fixture', description: '', parameters: { type: 'object', properties: {} }, async execute() { return 'written' } })
  try {
    await f.apply(); await f.adopt()
    const result = requireToolText(await f.tools.execute('completed_fixture', {}, f.context()))
    assert.match(result, /Error: test failed/)
    await access(join(workspace, 'partial.txt'))
    assert.equal(f.store.workEffects().length, 0)
    assert.ok(f.store.workHistory(workKey(change().subject)).some(event => event.kind === 'tool_result'
      && (event.data as { outcome: string }).outcome === 'returned_error'))
    assert.equal(await f.tools.execute('write_fixture', {}, f.context()), 'written')
    await f.tools.execute('forged_fixture', {}, f.context())
    assert.equal(f.store.workEffects()[0].status, 'unknown')
    assert.match(requireToolText(await f.tools.execute('write_fixture', {}, f.context())), /unknown/)
  } finally { f.store.close() }
}))

test('abort overrides a trusted completed result', async () => withTempWorkspace(async workspace => {
  const f = fixture(workspace), controller = new AbortController()
  f.base.register({ name: 'abort_fixture', description: '', parameters: { type: 'object', properties: {} },
    async execute() {
      controller.abort()
      return completedToolFailure({ isError: true, content: [{ type: 'text', text: 'Error: stopped' }] })
    } })
  try {
    await f.apply(); await f.adopt()
    await f.tools.execute('abort_fixture', {}, { ...f.context(), signal: controller.signal })
    assert.equal(f.store.workEffects()[0].status, 'unknown')
  } finally { f.store.close() }
}))

test('registry fences old inference, same-batch adoption, nested tools, and restored pending calls', async () => withTempWorkspace(async workspace => {
  const f = fixture(workspace)
  let writes = 0
  f.base.register({ name: 'write_fixture', description: '', parameters: { type: 'object', properties: {} },
    async execute() { writes++; return 'written' } })
  f.base.register({ name: 'nested_fixture', description: '', parameters: { type: 'object', properties: {} },
    async execute(_, context) { return context.tools.execute('write_fixture', {}, context) } })
  try {
    assert.equal(requireToolText(await f.tools.execute('write_fixture', {}, f.context())), 'written')
    await f.apply()
    const clarification = { name: 'ask', description: '', parameters: { type: 'object' as const, properties: {} }, async execute() { return 'clarification' } }
    assert.equal(f.alignment.before(clarification, { action: 'ask' }, f.context()), undefined, 'Asking for clarification does not require adopting an unclear goal')
    const unadopted = f.context()
    await f.adopt()
    assert.match(requireToolText(await f.tools.execute('write_fixture', {}, unadopted)), /basis changed|not adopted/)
    assert.match(requireToolText(await f.tools.execute('write_fixture', {}, { ...f.context(), workStamps: undefined })), /not adopted/)
    const old = f.context()
    const snapshot = f.tools.snapshot()
    assert.equal(snapshot.getWorkGuard(), f.alignment, 'Call snapshots keep the runtime fence')
    assert.equal(await f.tools.execute('nested_fixture', {}, old), 'written')
    await f.apply(change(1), true)
    await f.adopt(undefined, 2)
    assert.match(requireToolText(await f.tools.execute('nested_fixture', {}, old)), /basis changed/)
    assert.equal(writes, 2)
    assert.equal(await f.tools.execute('write_fixture', {}, f.context()), 'written')
    assert.equal(writes, 3)
  } finally { f.store.close() }
}))

test('reading and activating a Skill does not require a work item or adoption', async () => withTempWorkspace(async workspace => {
  const f = fixture(workspace)
  const vfs = new VirtualFs()
  let activations = 0
  vfs.mount('v:skills', 'Skills', () => { activations++; return 'Skill instructions and tools registered.' })
  const read = new ReadTool(workspace, vfs)
  f.base.register(read)
  f.base.register({ name: 'write_fixture', description: '', parameters: { type: 'object', properties: {} },
    async execute() { return 'written' } })
  try {
    assert.equal(read.readonly({ path: 'v:skills/audio-cpp' }), false, 'Skill activation stays non-parallel')
    assert.equal(read.readonly({ path: 'v:skills/audio-cpp/SKILL.md' }), true)
    assert.equal(await f.tools.execute('read', { path: 'v:skills/audio-cpp' }, f.context()), 'Skill instructions and tools registered.')
    assert.equal(activations, 1)
    assert.equal(requireToolText(await f.tools.execute('write_fixture', {}, f.context())), 'written')
    await f.apply()
    assert.equal(await f.tools.execute('read', { path: 'v:skills/audio-cpp' }, f.context()), 'Skill instructions and tools registered.')
    assert.equal(activations, 2)
    assert.match(requireToolText(await f.tools.execute('write_fixture', {}, f.context())), /not adopted/)
    assert.throws(() => f.alignment.before({ name: 'read', readonly: false, description: '',
      parameters: { type: 'object', properties: {} }, async execute() { return '' } },
    { path: 'v:skills/audio-cpp/tool.ts' }, f.context()), /not adopted/)
  } finally { f.store.close() }
}))

test('late results stay attributable and unresolved effects survive restart without replay', async () => withTempWorkspace(async workspace => {
  const f = fixture(workspace)
  const result = Promise.withResolvers<string>(), started = Promise.withResolvers<void>()
  f.base.register({ name: 'held_fixture', description: '', parameters: { type: 'object', properties: {} },
    async execute() { started.resolve(); return result.promise } })
  try {
    await f.apply(); await f.adopt()
    const pending = f.tools.execute('held_fixture', {}, f.context())
    await started.promise
    assert.equal(f.store.workEffects().length, 1)
    await f.apply(change(1), true)
    result.resolve('external result')
    assert.match(requireToolText(await pending), /STALE WORK RESULT/)
    const key = workKey(change().subject)
    const event = f.store.workHistory(key).find(item => item.kind === 'tool_result')
    assert.equal((event?.data as { stale: boolean }).stale, true)
    await f.adopt(key, 2)
    const effectId = randomUUID()
    f.store.startWorkEffect(effectId, worker, 'external', f.alignment.snapshot(worker))
    assert.equal(f.alignment.context(worker).effects[0].resultSource, undefined,
      'Legacy or interrupted effects without a returned result must not invent a source')
    f.store.close()
    const reopened = new InitiativeStore(workspace, f.options)
    try {
      reopened.recoverWorkEffects()
      assert.equal(reopened.workEffects()[0].status, 'unknown')
      assert.equal(reopened.workRecords()[0].revision, 2)
      assert.equal(reopened.workRecords()[0].adoption?.revision, 2)
    } finally { reopened.close() }
  } finally { result.resolve('cleanup'); f.store.close() }
}))

test('execution cancellation remains available while work is paused and unadopted', async () => withTempWorkspace(async workspace => {
  const f = fixture(workspace)
  try {
    await f.apply({ ...change(), paused: true })
    const cancel = new CancelTool({ getSessionState: () => null, getDelegationOwner: () => undefined,
      assertFolderAccess: () => {}, getActiveSession: () => undefined })
    assert.equal(f.alignment.before(cancel, { executionId: 'virtual:child' }, f.context()), undefined)
    const impostor = { name: 'cancel', description: '', parameters: { type: 'object' as const, properties: {} },
      async execute() { return 'new work disguised as cancellation' } }
    assert.throws(() => f.alignment.before(impostor, {}, f.context()), /basis changed|not adopted/)
  } finally { f.store.close() }
}))

test('bounded tasks cannot manage contracts but retain their durable owner execution fence', async () => withTempWorkspace(async workspace => {
  const f = fixture(workspace)
  let writes = 0
  f.base.register({ name: 'write_fixture', description: '', parameters: { type: 'object', properties: {} },
    async execute() { writes++; return 'written' } })
  try {
    const tools = new SessionTools(f.base, workspace)
    tools.setExecutionScope('task', ['task'])
    assert.equal(tools.has('work'), false)
    f.states['task:standalone'] = { sessionId: 'task:standalone', mode: 'task', segmentIndex: 0 }
    assert.equal(await tools.execute('write_fixture', {}, { ...f.context('task:standalone'), tools }), 'written')
    f.states['task:child'] = { sessionId: 'task:child', mode: 'task', segmentIndex: 0, parentSessionId: worker }
    await f.apply()
    const pending = { ...f.context('task:child'), tools }
    assert.match(requireToolText(await tools.execute('write_fixture', {}, pending)), /not adopted/)
    await f.adopt()
    assert.match(requireToolText(await tools.execute('write_fixture', {}, pending)), /basis changed|not adopted/)
    assert.equal(await tools.execute('write_fixture', {}, { ...f.context('task:child'), tools }), 'written')
    assert.equal(writes, 2)
  } finally { f.store.close() }
}))

test('safe fresh-context transitions require executor inventory and retain unknown effects', async () => withTempWorkspace(async workspace => {
  const f = fixture(workspace)
  try {
    const { key } = await f.apply()
    await assert.rejects(f.alignment.execute({ kind: 'user' }, 'transition', key, 1, { strategy: 'fresh' }), /checkpoint/)
    await f.alignment.execute({ kind: 'session', sessionId: worker }, 'checkpoint', key, 1, { ...inventory, inFlight: ['remote job'] })
    await assert.rejects(f.alignment.execute({ kind: 'user' }, 'transition', key, 1, { strategy: 'fresh' }), /in-flight/)
    await f.alignment.execute({ kind: 'session', sessionId: worker }, 'checkpoint', key, 1, inventory)
    await assert.rejects(f.alignment.execute({ kind: 'session', sessionId: peer }, 'transition', key, 1, { strategy: 'fresh' }), /controller/)
    await f.alignment.execute({ kind: 'user' }, 'transition', key, 1, { strategy: 'fresh' })
    assert.equal(f.transitions.length, 1)
    await assert.rejects(f.adopt(), /pending transition/)
    const record = f.alignment.get(key)
    assert.match(f.alignment.handoff(record), /retired.*Smoke-only/)
    f.alignment.finishTransition(key, record.transition!.id)
    await f.adopt()
    f.alignment.assertCurrent(f.alignment.snapshot(worker), worker)
    f.alignment.reviewAnswer(worker, 'I asked for both, not just smoke.', 'question')
    assert.throws(() => f.alignment.assertCurrent(f.alignment.snapshot(worker), worker), /not adopted/)
    assert.equal(f.alignment.get(key).answerReview?.text, 'I asked for both, not just smoke.')
  } finally { f.store.close() }
}))

test('Initiative contracts reuse assignment authority and isolate selected unaffected work', async () => withTempWorkspace(async workspace => {
  const f = fixture(workspace, true)
  try {
    f.store.query("INSERT INTO initiatives(id,title,goal,context) VALUES('build','Build','Deliver both outputs',''); INSERT INTO initiative_items(id,initiative_id,title,assignee_session_id) VALUES('a','build','Output A','web:worker'); INSERT INTO initiative_items(id,initiative_id,title,assignee_session_id) VALUES('b','build','Output B','web:worker')", owner)
    assert.equal(f.alignment.records(worker).length, 2)
    await f.adopt('item:a'); await f.adopt('item:b')
    await f.alignment.execute({ kind: 'user' }, 'update', undefined, undefined, {
      ...change(), subject: { kind: 'item', initiativeId: 'build', itemId: 'a' }, expectedRevision: 1, paused: true,
    })
    assert.throws(() => f.alignment.assertCurrent(f.alignment.snapshot(worker), worker), /not adopted/)
    await f.alignment.execute({ kind: 'session', sessionId: worker }, 'select', 'item:b', 1, undefined)
    f.alignment.assertCurrent(f.alignment.snapshot(worker), worker)
    f.store.query("UPDATE initiative_items SET status='in_progress' WHERE id='b'", worker)
    assert.equal(f.alignment.get('item:b').revision, 1, 'Status changes are not semantic revisions')
    assert.throws(() => f.store.query("UPDATE initiatives SET goal='Only smoke' WHERE id='build'", owner), /versioned agreements/)
    f.base.register(new InitiativeTool(f.store, 'project', INITIATIVE_SCHEMA_PROMPT))
    const readTools = new SessionTools(f.base, workspace, ['initiative'])
    assert.match(requireToolText(await readTools.execute('initiative', { query: 'SELECT * FROM initiative_items' }, { ...f.context(), tools: readTools, workStamps: [] })), /Output A/)
  } finally { f.store.close() }
}))

test('successor preparation retires old execution but cannot seize Initiative ownership', async () => withTempWorkspace(async workspace => {
  const f = fixture(workspace, true)
  try {
    f.store.query("INSERT INTO initiatives(id,title,goal,context) VALUES('build','Build','Deliver',''); INSERT INTO initiative_items(id,initiative_id,title,assignee_session_id) VALUES('a','build','Output','web:worker')", owner)
    await f.adopt('item:a')
    await f.alignment.execute({ kind: 'session', sessionId: worker }, 'checkpoint', 'item:a', 1, inventory)
    await f.alignment.execute({ kind: 'session', sessionId: owner }, 'transition', 'item:a', 1, { strategy: 'successor' })
    assert.equal(f.store.workAuthority({ kind: 'item', initiativeId: 'build', itemId: 'a' }).executor, worker)
    await assert.rejects(f.adopt('item:a'), /retired/)
    await assert.rejects(f.alignment.execute({ kind: 'session', sessionId: owner }, 'release', 'item:a', 1, undefined), /Only the current assignee/)
    await f.alignment.execute({ kind: 'session', sessionId: worker }, 'release', 'item:a', 1, undefined)
    assert.equal(f.store.workAuthority({ kind: 'item', initiativeId: 'build', itemId: 'a' }).executor, null)
    assert.throws(() => f.alignment.assertCurrent(f.alignment.snapshot(worker), worker), /not adopted|paused/)
  } finally { f.store.close() }
}))

test('v3 migration preserves legacy work without inventing contracts or user requirements', async () => withTempWorkspace(async workspace => {
  const store = new InitiativeStore(workspace)
  store.query("INSERT INTO initiatives(id,title,goal,context) VALUES('legacy','Legacy','Original','Keep'); INSERT INTO initiative_items(id,initiative_id,title,assignee_session_id) VALUES('old','legacy','Old task','worker')", 'owner')
  store.close()
  const db = new DatabaseSync(join(workspace, 'initiatives.sqlite'))
  db.exec('DROP TABLE work_focus; DROP TABLE work_effects; DROP TABLE work_contract_events; DROP TABLE work_contracts; PRAGMA user_version=3')
  db.close()
  const reopened = new InitiativeStore(workspace, { trackWork: true })
  try {
    assert.deepEqual(reopened.workRecords(), [])
    assert.equal(reopened.query('SELECT assignee_session_id FROM initiative_items', 'owner').results[0].rows[0].assignee_session_id, 'worker')
  } finally { reopened.close() }
}))

test('aborting evidence review never publishes an agreement', async () => withTempWorkspace(async workspace => {
  const f = fixture(workspace), controller = new AbortController()
  const alignment = new WorkAlignment(f.store, {
    state: id => f.states[id],
    evidence: async () => { controller.abort(new Error('Cancelled review')) },
    changed: async () => { assert.fail('An aborted review must not publish') },
    fresh: async () => { assert.fail('No transition requested') },
    successor: async () => { throw new Error('No successor requested') },
  })
  try {
    const request = change()
    request.definition.evidence = [{ sessionId: worker, physicalId: 'synthetic.0', kind: 'user', id: 'input', quote: 'Both outcomes' }]
    await assert.rejects(alignment.execute({ kind: 'user' }, 'update', undefined, undefined, request, controller.signal), /Cancelled review/)
    assert.deepEqual(f.store.workRecords(), [])
  } finally { f.store.close() }
}))
