import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile, writeFile } from 'node:fs/promises'
import { Hono } from 'hono'
import { withTempWorkspace } from '../testing/workspace.ts'
import { projectStoragePath } from '../utils/data-paths.ts'
import { WorkflowRuntime } from './runtime.ts'
import { WorkflowDefinition, type Definition } from './contracts.ts'
import { WorkflowTool, createWorkflowHandler, registerWorkflowRoutes } from './management.ts'
import type { ExecutionContext } from '../tools/context.ts'
import { CronService } from '../cron/service.ts'
import { createProjectScope } from '../projects/scope.ts'
import { TestSignalProviderRuntime } from '../signals/providers/testing.ts'
import { SignalProviderTool } from '../tools/signal-provider.ts'

const record = (id: string, first: 'emit' | 'baseline' = 'emit'): Definition => ({ id, revision: 1, owner: 'owner', source: { kind: 'external', id: 'feed' }, gate: { kind: 'revision-dedupe', first }, nodes: [{ kind: 'record' }], enabled: true })
const admit = (runtime: WorkflowRuntime, workflow: string, revision = 'r1') => runtime.admit([{ workflow, source: { kind: 'external', id: 'feed' }, observations: [{ id: revision, item: 'item1', data: { title: revision } }] }])
const host = { canUse: (id: string) => id === 'owner', deliver: async () => { throw Error('No agent/inbox action authorized') } }

test('independent baseline/emit, duplicate revisions, deterministic materialization and restart without a model', async () => withTempWorkspace(async directory => {
  let runtime = new WorkflowRuntime(directory, 'p', host)
  runtime.bindExternal(() => true); runtime.start()
  runtime.define(record('baseline', 'baseline')); runtime.define(record('emit'))
  assert.deepEqual(admit(runtime, 'baseline'), [])
  assert.equal(admit(runtime, 'emit').length, 1)
  await Promise.all([runtime.drain(), runtime.drain()])
  assert.equal(runtime.inspect().records.emit.item1.id, 'r1')
  assert.equal(runtime.inspect().records.baseline, undefined)
  assert.deepEqual(admit(runtime, 'emit'), [])
  assert.equal(admit(runtime, 'baseline', 'r2').length, 1)
  await runtime.stop()
  runtime = new WorkflowRuntime(directory, 'p', host); runtime.bindExternal(() => true); runtime.start()
  try {
    await runtime.drain()
    assert.equal(runtime.inspect().records.baseline.item1.id, 'r2')
    assert.deepEqual(admit(runtime, 'baseline', 'r2'), [])
    assert.equal(runtime.inspect().runs.length, 2)
    assert(runtime.inspect().runs.every(r => r.status === 'completed'))
    runtime.remove('baseline')
    assert.throws(() => runtime.define(record('baseline')), /Retired/)
  } finally { await runtime.stop() }
}))

test('retry persists transform result and accepted draft progress; stable input IDs cross restart', async () => withTempWorkspace(async directory => {
  let now = 1, reject = true
  const attempts: string[] = [], accepted: string[] = []
  const options = { canUse: host.canUse, now: () => now, deliver: async (id: string, input: Parameters<NonNullable<ConstructorParameters<typeof WorkflowRuntime>[2]['deliver']>>[1]) => {
    attempts.push(input.id)
    if (attempts.length > 1 && reject) throw Error('secret-error-body')
    accepted.push(input.id)
    return { status: 'accepted' as const, sessionId: id, inputId: input.id }
  } }
  let runtime = new WorkflowRuntime(directory, 'p', options); runtime.bindExternal(() => true); runtime.start()
  runtime.define({ ...record('notify'), nodes: [{ kind: 'transform', code: 'export function run(){return [{content:"one"},{content:"two"}]}' }, { kind: 'inbox' }] })
  admit(runtime, 'notify'); await runtime.drain()
  let run = runtime.inspect().runs[0]
  assert.equal(run.status, 'retry'); assert.equal(run.cursor, 1); assert.equal(run.delivered, 1)
  assert.equal(run.error, 'action_failed'); assert.equal(JSON.stringify(runtime.inspect()).includes('secret-error-body'), false)
  await runtime.stop()
  reject = false; now = 60001
  runtime = new WorkflowRuntime(directory, 'p', options); runtime.bindExternal(() => true); runtime.start()
  try {
    await runtime.drain()
    run = runtime.inspect().runs[0]
    assert.equal(run.status, 'completed'); assert.equal(accepted.length, 2)
    assert.equal(attempts[1], attempts[2]); assert.notEqual(accepted[0], accepted[1])
  } finally { await runtime.stop() }
}))

test('unsafe schedule failure and crash recovery block replay; explicit acknowledgement, revocation and overlap', async () => withTempWorkspace(async directory => {
  let calls = 0, fail = true
  const runtime = new WorkflowRuntime(directory, 'p', host); runtime.start()
  const cron = new CronService(directory, runtime)
  cron.setHandler(async () => { calls++; if (fail) throw Error('uncertain fresh-session side effect') })
  await cron.start()
  const id = cron.addJob({ schedule: 'every 1h', session: 'fresh', task: 'explicit action', originSessionId: 'owner' }, 'job')
  await Promise.all([cron.runNow(id), cron.runNow(id)])
  let run = runtime.inspect().runs[0]
  assert.equal(calls, 1); assert.equal(run.status, 'blocked')
  await cron.runNow(id)
  assert.equal(calls, 1); assert.equal(runtime.inspect().runs.length, 1, 'blocked schedule coalesces ticks')
  assert.throws(() => runtime.control('owner', run.id, 'retry'), /acknowledgeReplay/)
  await runtime.stop(); await cron.stop()
  // Simulate the crash window after persisting node-start but before recording its effect outcome.
  const path = projectStoragePath(directory, '.workflows', 'state.json')
  const stored = JSON.parse(await readFile(path, 'utf8')); stored.runs[0].status = 'running'
  await writeFile(path, JSON.stringify(stored))
  const recovered = new WorkflowRuntime(directory, 'p', host)
  recovered.start(); const recoveredCron = new CronService(directory, recovered); recoveredCron.setHandler(async () => { calls++; if (fail) throw Error('uncertain fresh-session side effect') }); await recoveredCron.start()
  try {
    run = recovered.inspect().runs[0]
    assert.equal(run.status, 'blocked'); assert.equal(run.error, 'interrupted_effect')
    await recovered.drain(); assert.equal(calls, 1)
    fail = false; recovered.control('owner', run.id, 'retry', true); await recovered.drain()
    assert.equal(calls, 2); assert.equal(recovered.inspect().runs[0].status, 'completed')
    recovered.manage('schedule:job', 'pause'); await recoveredCron.runNow(id)
    assert.equal(calls, 2, 'schedule ticks do not override Workflow pause')
  } finally { await recovered.stop(); await recoveredCron.stop() }
}))

test('queued schedule snapshot is revalidated after removal; deferred host startup cannot execute', async () => withTempWorkspace(async directory => {
  let calls = 0
  const runtime = new WorkflowRuntime(directory, 'p', host); runtime.start(true)
  const cron = new CronService(directory, runtime); cron.setHandler(async () => { calls++ }); await cron.start()
  try {
    cron.addJob({ schedule: 'every 1h', session: 'fresh', task: 'no replay' }, 'job')
    await cron.runNow('job'); assert.equal(calls, 0); assert.equal(runtime.inspect().runs[0].status, 'queued')
    cron.removeJob('job'); runtime.activate(); await runtime.drain()
    assert.equal(calls, 0); assert.notEqual(runtime.inspect().runs[0].status, 'completed')
  } finally { await runtime.stop(); await cron.stop() }
}))

test('Project, owner, wire source/action, HTTP and direct-input permissions are enforced', async () => withTempWorkspace(async directory => {
  const runtime = new WorkflowRuntime(directory, 'p', host); runtime.bindExternal(() => true); runtime.start()
  runtime.define(record('flow'))
  const tool = new WorkflowTool(runtime), views = createWorkflowHandler(runtime)
  const context = { projectId: 'p', sessionId: 'owner', inputSource: 'user', signal: new AbortController().signal } as ExecutionContext
  try {
    assert.throws(() => admit(runtime, 'missing'), /binding mismatch/)
    const foreign = createProjectScope('other')
    assert.throws(() => new CronService(directory, runtime, 'UTC', foreign), /same Project/)
    foreign.close()
    assert.throws(() => runtime.admit([{ workflow: 'flow', source: { kind: 'schedule', id: 'feed' }, observations: [] }]), /binding mismatch/)
    assert.throws(() => WorkflowDefinition.parse({ ...record('evil'), nodes: [{ kind: 'schedule-action', action: 'agent', job: {} }] }), /boundary/)
    await assert.rejects(tool.execute({ action: 'pause', id: 'flow' }, { ...context, inputSource: 'event' }), /direct user/)
    await assert.rejects(tool.execute({ action: 'pause', id: 'flow' }, { ...context, projectId: 'other' }), /Wrong Project/)
    await assert.rejects(tool.execute({ action: 'pause', id: 'flow' }, { ...context, sessionId: 'stranger' }), /durable local/)
    await assert.rejects(async () => views.read('', { ...context, projectId: 'other' }), /Wrong Project/)
    assert.match(String(await views.read('', context)), /not model sessions/)
    const app = new Hono(); registerWorkflowRoutes(app, runtime, request => request.headers.get('x-test') === 'authorized')
    assert.equal((await app.request('/api/workflows')).status, 403)
    assert.equal((await app.request('/api/workflows/control', { method: 'POST', body: JSON.stringify({ action: 'pause', id: 'flow' }) })).status, 403)
    assert.equal((await app.request('/api/workflows/control', { method: 'POST', headers: { 'x-test': 'authorized' }, body: JSON.stringify({ action: 'pause', id: 'flow' }) })).status, 200)
    assert.equal((await app.request('/api/workflows', { headers: { 'x-test': 'authorized' } })).status, 200)
    await runtime.stop()
    const other = new WorkflowRuntime(directory, 'other-project', host)
    assert.throws(() => other.start(), /another Project/)
  } finally { await runtime.stop() }
}))

test('real external collector -> per-subscription dedupe -> deterministic action; checkpoint handoff gap is replay safe', async t => withTempWorkspace(async directory => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now)
  const source = new TestSignalProviderRuntime(directory, { execute: async () => { throw Error('no network required') } }, host.deliver, host.canUse, () => false)
  source.start()
  try {
    source.publish('owner', { id: 'feed', version: 1, description: 'fixture', http: { origin: 'https://example.org', routes: [{ method: 'GET', path: '/' }] },
      code: 'export function run({demands}){return Object.fromEntries(demands.map(d=>[d.key,{mode:"delta",signals:[{id:"r1",item:"item1",data:{title:"hello"}}],checkpoint:{cursor:1}}]))}' })
    source.create('owner', { id: 'feed', provider: 'feed', version: 1 })
    source.subscribe('owner', { id: 'record', instance: 'feed', demand: {}, first: 'emit', action: { kind: 'record' } })
    source.subscribe('owner', { id: 'quiet', instance: 'feed', demand: {}, first: 'baseline', action: { kind: 'record' } })
    assert.throws(() => source.subscribe('owner', { id: 'missing-first', instance: 'feed', demand: {}, action: { kind: 'record' } }), /Required/)
    const tool = new SignalProviderTool(source, 'fixture')
    await assert.rejects(tool.execute({ action: 'subscribe', input_json: '{}' }, { projectId: 'fixture', sessionId: 'owner', inputSource: 'event', signal: new AbortController().signal } as ExecutionContext), /direct user/)
    const original = source.workflow.admit.bind(source.workflow)
    let failAfterAdmission = true
    t.mock.method(source.workflow, 'admit', (...args: Parameters<WorkflowRuntime['admit']>) => { const result = original(...args); if (failAfterAdmission) { failAfterAdmission = false; throw Error('simulated stop before source checkpoint') } return result })
    await source.run()
    assert.deepEqual(JSON.parse(await readFile(projectStoragePath(directory, '.signals', 'sources-v4.json'), 'utf8')).demands, {})
    assert.equal(source.workflow.inspect().records['external:record'].item1.id, 'r1')
    now += 60001; await source.run()
    const state = source.workflow.inspect()
    assert.equal(state.runs.length, 1); assert.equal(state.records['external:quiet'], undefined)
    const demands = Object.values(JSON.parse(await readFile(projectStoragePath(directory, '.signals', 'sources-v4.json'), 'utf8')).demands)
    assert.deepEqual(demands, [{ mode: 'delta', checkpoint: { cursor: 1 } }], 'source stores protocol state, not seen/baseline/jobs')
  } finally { await source.stop() }
}))


test('different workflows progress while an explicit agent action is running; transforms cannot import IO', async () => withTempWorkspace(async directory => {
  let enter!: () => void, release!: () => void
  const entering = new Promise<void>(resolve => { enter = resolve })
  const waiting = new Promise<void>(resolve => { release = resolve })
  const runtime = new WorkflowRuntime(directory, 'p', host); runtime.bindExternal(() => true)
  runtime.bindSchedule({ current: () => true, execute: async () => { enter(); await waiting; return { sessionId: 'cron:explicit-action' } } }); runtime.start()
  runtime.define({ id: 'schedule:agent', owner: 'owner', source: { kind: 'schedule', id: 'agent' }, gate: { kind: 'revision-dedupe', first: 'emit' }, enabled: true,
    nodes: [{ kind: 'schedule-action', action: 'agent', job: {} }] })
  runtime.define(record('data'))
  runtime.define({ ...record('no-io'), nodes: [{ kind: 'transform', code: 'import {call} from "@shadow/fetch"; export async function run(){await call({});return [{content:"forbidden"}]}' }, { kind: 'inbox' }] })
  runtime.admit([{ workflow: 'schedule:agent', source: { kind: 'schedule', id: 'agent' }, observations: [{ id: 'tick', data: {} }] }])
  const running = runtime.drain('schedule:agent'); await entering
  try {
    admit(runtime, 'data'); admit(runtime, 'no-io')
    await Promise.all([runtime.drain('data'), runtime.drain('no-io')])
    assert.equal(runtime.inspect().records.data.item1.id, 'r1')
    assert.equal(runtime.inspect().runs.find(r => r.workflow === 'no-io')!.status, 'retry')
    assert.equal(runtime.inspect().runs.find(r => r.workflow === 'schedule:agent')!.status, 'running')
    release(); await running
    assert.deepEqual(runtime.inspect().runs.find(r => r.workflow === 'schedule:agent')!.output, { sessionId: 'cron:explicit-action' })
  } finally { release(); await running; await runtime.stop() }
}))

test('recovered one-shot succeeds once and durably removes its Schedule source', async () => withTempWorkspace(async directory => {
  const runtime = new WorkflowRuntime(directory, 'p', host); runtime.start(true)
  const cron = new CronService(directory, runtime)
  let calls = 0
  cron.setHandler(async () => { calls++ }); await cron.start()
  try {
    cron.addJob({ schedule: 'every 1h', session: 'fresh', task: 'one-shot', deleteAfterRun: true }, 'once')
    await cron.runNow('once'); assert.equal(calls, 0)
    runtime.activate(); await runtime.drain()
    assert.equal(calls, 1); assert.equal(cron.listJobs().length, 0)
    assert.equal(JSON.parse(await readFile(projectStoragePath(directory, '.cron', 'jobs.json'), 'utf8')).jobs.length, 0)
    assert.equal(runtime.inspect().runs[0].status, 'completed')
    await runtime.drain(); assert.equal(calls, 1)
  } finally { await runtime.stop(); await cron.stop() }
}))


test('managed Schedule reconstruction preserves queued preflight identity and never implies an agent action', async () => withTempWorkspace(async directory => {
  let scans = 0
  const definition = { schedule: 'every 3600000ms', session: 'fresh' as const, source: 'learning' as const, task: 'deterministic eligible-evidence preflight' }
  const first = new WorkflowRuntime(directory, 'p', host); first.start(true)
  const before = new CronService(directory, first)
  before.registerManagedJob('learning:fixture', definition, 3600000, async () => { scans++ })
  await before.start(); await before.runNow('learning:fixture')
  assert.equal(scans, 0)
  assert.equal(first.inspect().runs[0].definition.nodes[0].kind, 'schedule-action')
  const node = first.inspect().runs[0].definition.nodes[0]
  assert(node.kind === 'schedule-action'); assert.equal(node.action, 'program')
  await first.stop(); await before.stop()
  const path = projectStoragePath(directory, '.workflows', 'state.json')
  const stored = JSON.parse(await readFile(path, 'utf8'))
  stored.runs[0].definition.nodes[0].job.createdAt = '2000-01-01T00:00:00.000Z'
  await writeFile(path, JSON.stringify(stored))
  const recovered = new WorkflowRuntime(directory, 'p', host), after = new CronService(directory, recovered)
  after.registerManagedJob('learning:fixture', definition, 3600000, async () => { scans++ })
  recovered.start(); await after.start()
  try {
    await recovered.drain()
    assert.equal(scans, 1); assert.equal(recovered.inspect().runs[0].status, 'completed')
    assert.equal(recovered.inspect().runs[0].output, undefined, 'no session was requested/created by a preflight')
  } finally { await recovered.stop(); await after.stop() }
}))


test('failure to persist an unsafe outcome cannot replay it when storage recovers without process restart', async t => withTempWorkspace(async directory => {
  let effects = 0, failWrites = false
  const runtime = new WorkflowRuntime(directory, 'p', host); runtime.start()
  runtime.bindSchedule({ current: () => true, execute: async () => { effects++; failWrites = true; return { sessionId: 'cron:accepted' } } })
  runtime.define({ id: 'schedule:write-failure', source: { kind: 'schedule', id: 'write-failure' }, gate: { kind: 'revision-dedupe', first: 'emit' }, enabled: true,
    nodes: [{ kind: 'schedule-action', action: 'agent', job: {} }] })
  runtime.admit([{ workflow: 'schedule:write-failure', source: { kind: 'schedule', id: 'write-failure' }, observations: [{ id: 'tick', data: {} }] }])
  const target = runtime as unknown as { update(change: (state: unknown) => void): void }
  const update = target.update.bind(runtime)
  t.mock.method(target, 'update', (change: (state: unknown) => void) => { if (failWrites) throw Error('fixture disk unavailable'); update(change) })
  try {
    await assert.rejects(runtime.drain(), /disk unavailable/)
    assert.equal(runtime.inspect().runs[0].status, 'running')
    failWrites = false; await runtime.drain()
    assert.equal(effects, 1); assert.equal(runtime.inspect().runs[0].status, 'blocked')
  } finally { failWrites = false; await runtime.stop() }
}))
