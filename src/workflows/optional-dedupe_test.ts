import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import test from 'node:test'
import { withTempWorkspace } from '../testing/workspace.ts'
import { projectStoragePath } from '../utils/data-paths.ts'
import { CronService } from '../cron/service.ts'
import { WorkflowRuntime } from './runtime.ts'
import type { Definition } from './contracts.ts'
const host = { canUse: (owner: string) => owner === 'owner', deliver: async () => { throw Error('No inbox effect authorized by this fixture') } }
const definition = (id: string): Definition => ({ id, revision: 1, owner: 'owner', source: { kind: 'external', id: 'feed' }, enabled: true, nodes: [{ kind: 'record' }] })
const admit = (runtime: WorkflowRuntime, workflow: string) => runtime.admit([{ workflow, source: { kind: 'external' as const, id: 'feed' }, observations: [{ id: 'same-observation', item: 'item', data: {} }] }])

test('only explicit gates deduplicate revisions; no-gate admissions have independent durable run identities', async () => withTempWorkspace(async directory => {
  let runtime = new WorkflowRuntime(directory, 'p', host); runtime.bindExternal(() => true); runtime.start()
  runtime.define(definition('plain'))
  runtime.define({ ...definition('dedup'), gate: { kind: 'revision-dedupe', first: 'emit' } })
  runtime.define({ ...definition('baseline'), gate: { kind: 'revision-dedupe', first: 'baseline' } })
  const first = admit(runtime, 'plain')[0], second = admit(runtime, 'plain')[0]
  assert.ok(first); assert.ok(second); assert.notEqual(first, second)
  assert.equal(admit(runtime, 'dedup').length, 1); assert.deepEqual(admit(runtime, 'dedup'), [])
  assert.deepEqual(admit(runtime, 'baseline'), [])
  assert.equal(runtime.inspect().dedupe.plain, undefined)
  await runtime.drain(); assert.equal(runtime.inspect().runs.filter(run => run.workflow === 'plain').length, 2)
  await runtime.stop()
  runtime = new WorkflowRuntime(directory, 'p', host); runtime.bindExternal(() => true); runtime.start()
  try {
    await runtime.drain()
    assert.deepEqual(runtime.inspect().runs.filter(run => run.workflow === 'plain').map(run => run.id), [first, second])
    assert.ok(runtime.inspect().runs.every(run => run.status === 'completed'))
    assert.deepEqual(admit(runtime, 'dedup'), []); assert.deepEqual(admit(runtime, 'baseline'), [])
    assert.equal(admit(runtime, 'plain').length, 1, 'a new admission is not confused with recovery of a saved run')
    runtime.remove('plain')
    assert.ok(runtime.inspect().dedupe.plain, 'retirement identity is retained even without a revision window')
    assert.throws(() => runtime.define(definition('plain')), /Retired/)
  } finally { await runtime.stop() }
}))

test('authoring never silently removes an existing external gate when the field is omitted', async () => withTempWorkspace(async directory => {
  const runtime = new WorkflowRuntime(directory, 'p', host); runtime.bindSourceAuthorizer((_owner, flow) => flow); runtime.start()
  const raw = { id: 'new-flow', name: 'No dedup', source: { kind: 'external', id: 'feed' }, binding: { demand: {} }, nodes: [{ kind: 'record' }], enabled: true }
  try {
    const plain = runtime.author('owner', raw)
    assert.equal(plain.gate, undefined)
    assert.equal(runtime.author('owner', { ...raw, name: 'Updated' }, 1).revision, 2)
    assert.throws(() => runtime.author('owner', { ...raw, gate: { kind: 'revision-dedupe', first: 'emit' } }, 2), /First-batch/)
    const gated = { ...raw, id: 'legacy', gate: { kind: 'revision-dedupe', first: 'baseline' } }
    runtime.author('owner', gated)
    assert.throws(() => runtime.author('owner', { ...raw, id: 'legacy' }, 1), /First-batch/)
    assert.equal(runtime.inspect().definitions.find(flow => flow.id === 'legacy')!.gate!.first, 'baseline')
    runtime.retire('owner', 'new-flow', 2)
    assert.throws(() => runtime.author('owner', raw), /Retired/)
  } finally { await runtime.stop() }
}))

test('schedule synchronization removes legacy gate once, preserves historical snapshots and recovers one saved run', async () => withTempWorkspace(async directory => {
  let calls = 0
  let runtime = new WorkflowRuntime(directory, 'p', host); runtime.start(true)
  let cron = new CronService(directory, runtime); cron.setHandler(async () => { calls++ }); await cron.start()
  cron.addJob({ schedule: 'every 1h', session: 'fresh', task: 'fixture' }, 'job')
  assert.equal(runtime.inspect().definitions[0].gate, undefined)
  await cron.runNow('job'); const savedId = runtime.inspect().runs[0].id
  await runtime.stop(); await cron.stop()
  const path = projectStoragePath(directory, '.workflows', 'state.json')
  const legacy = JSON.parse(await readFile(path, 'utf8'))
  for (const flow of [legacy.definitions[0], legacy.runs[0].definition]) { flow.gate = { kind: 'revision-dedupe', first: 'emit' }; flow.revision = 7 }
  delete legacy.admitted
  legacy.dedupe['schedule:job'] = { baseline: true, seen: ['old-tick'] }
  await writeFile(path, JSON.stringify(legacy))
  runtime = new WorkflowRuntime(directory, 'p', host); runtime.start(true)
  cron = new CronService(directory, runtime); cron.setHandler(async () => { calls++ }); await cron.start()
  assert.equal(runtime.inspect().definitions[0].revision, 8)
  assert.equal(runtime.inspect().definitions[0].gate, undefined)
  assert.equal(runtime.inspect().dedupe['schedule:job'], undefined)
  assert.equal(runtime.inspect().runs[0].definition.gate?.first, 'emit')
  assert.equal(runtime.inspect().runs[0].definition.revision, 7)
  await runtime.stop(); await cron.stop()
  runtime = new WorkflowRuntime(directory, 'p', host); runtime.start(true)
  cron = new CronService(directory, runtime); cron.setHandler(async () => { calls++ }); await cron.start()
  try {
    assert.equal(runtime.inspect().definitions[0].revision, 8, 'unchanged restart is not a new definition revision')
    assert.equal(runtime.inspect().runs[0].id, savedId)
    runtime.activate(); await runtime.drain(); await runtime.drain()
    assert.equal(calls, 1); assert.equal(runtime.inspect().runs[0].id, savedId)
    await cron.runNow('job'); assert.equal(calls, 2)
    assert.equal(runtime.inspect().runs[1].definition.gate, undefined)
    assert.equal(runtime.inspect().dedupe['schedule:job'], undefined)
  } finally { await runtime.stop(); await cron.stop() }
}))

test('admission identity commits atomically and a definition alone is not an admission receipt', async () => withTempWorkspace(async directory => {
  const { mkdir } = await import('node:fs/promises')
  const runtime = new WorkflowRuntime(directory, 'p', host); runtime.bindExternal(() => true); runtime.start()
  runtime.define(definition('plain'))
  assert.equal(runtime.hasAdmitted('plain'), false)
  const internals = runtime as unknown as { path: string }, original = internals.path
  const blocked = projectStoragePath(directory, 'blocked-state')
  await mkdir(blocked)
  try {
    internals.path = blocked // Atomic rename cannot replace a directory with the state file.
    assert.throws(() => admit(runtime, 'plain'))
    assert.equal(runtime.hasAdmitted('plain'), false)
    assert.equal(runtime.inspect().runs.length, 0)
    assert.equal(JSON.parse(await readFile(original, 'utf8')).admitted.plain, undefined)
    internals.path = original
    const first = admit(runtime, 'plain')[0]
    assert.ok(first); assert.equal(runtime.hasAdmitted('plain'), true)
    const stored = JSON.parse(await readFile(original, 'utf8'))
    assert.equal(stored.admitted.plain, true); assert.equal(stored.runs[0].id, first)
    assert.equal(admit(runtime, 'plain').length, 1, 'identity receipt must not act as revision deduplication')
  } finally { internals.path = original; await runtime.stop() }
}))

test('default installation cannot revive an admitted no-gate identity after terminal run retention', async () => withTempWorkspace(async directory => {
  const key = 'used', id = `default:${key}`, workflow = `schedule:${id}`
  const job = { schedule: 'every 1h', session: 'fresh' as const, task: 'fixture', id, createdAt: '2026-11-01T00:00:00.000Z' }
  let runtime = new WorkflowRuntime(directory, 'p', host); runtime.start()
  runtime.bindSchedule({ current: () => true, execute: async () => {} })
  runtime.define({ id: workflow, enabled: true, source: { kind: 'schedule', id }, nodes: [{ kind: 'schedule-action', action: 'agent', job }] })
  const [runId] = runtime.admit([{ workflow, source: { kind: 'schedule', id }, observations: [{ id: 'tick', data: {} }] }])
  await runtime.drain(); runtime.define(definition('other')); await runtime.stop()
  const path = projectStoragePath(directory, '.workflows', 'state.json')
  const state = JSON.parse(await readFile(path, 'utf8'))
  // Populate a valid terminal tail without running hundreds of synthetic effects.
  const prior = state.runs[0]
  state.runs.push(...Array.from({ length: 500 }, (_, index) => ({ ...prior, id: `other-${index}`, workflow: 'other', definition: definition('other') })))
  await writeFile(path, JSON.stringify(state))
  runtime = new WorkflowRuntime(directory, 'p', host); runtime.bindExternal(() => true); runtime.start()
  const cron = new CronService(directory, runtime); await cron.start()
  try {
    admit(runtime, 'other') // The actual bounded-retention path drops the old default run.
    assert.equal(runtime.inspect().runs.some(run => run.id === runId), false)
    assert.equal(runtime.hasAdmitted(workflow), true)
    await assert.rejects(cron.ensureDefaultJob(key, { schedule: job.schedule, session: 'fresh', task: job.task }), /Duplicate/)
    assert.equal(cron.listJobs().length, 0)
    const unusedId = 'default:unused'
    runtime.define({ id: `schedule:${unusedId}`, enabled: true, source: { kind: 'schedule', id: unusedId }, nodes: [{ kind: 'schedule-action', action: 'agent', job: { ...job, id: unusedId } }] })
    assert.equal(runtime.hasAdmitted(`schedule:${unusedId}`), false)
    await cron.ensureDefaultJob('unused', { schedule: job.schedule, session: 'fresh', task: job.task })
    assert.equal(cron.listJobs().length, 1, 'unadmitted Workflow-before-jobs installation still recovers')
  } finally { await runtime.stop(); await cron.stop() }
}))

test('legacy schedule identity migration preserves an evicted admission but not an unused definition', async () => withTempWorkspace(async directory => {
  let runtime = new WorkflowRuntime(directory, 'p', host); runtime.start(true)
  for (const id of ['used', 'unused']) runtime.define({ id: `schedule:${id}`, source: { kind: 'schedule', id }, enabled: true, gate: { kind: 'revision-dedupe', first: 'emit' }, nodes: [{ kind: 'schedule-action', action: 'agent', job: {} }] })
  await runtime.stop()
  const path = projectStoragePath(directory, '.workflows', 'state.json')
  const old = JSON.parse(await readFile(path, 'utf8')); delete old.admitted
  old.dedupe['schedule:used'] = { baseline: true, seen: ['old-schedule-tick'] }
  await writeFile(path, JSON.stringify(old))
  runtime = new WorkflowRuntime(directory, 'p', host); runtime.start(true)
  try {
    assert.equal(runtime.inspect().runs.length, 0)
    assert.equal(runtime.hasAdmitted('schedule:used'), true)
    assert.equal(runtime.hasAdmitted('schedule:unused'), false)
    assert.equal(JSON.parse(await readFile(path, 'utf8')).admitted['schedule:used'], true)
  } finally { await runtime.stop() }
}))
