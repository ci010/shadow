import assert from 'node:assert/strict'
import test from 'node:test'
import { scheduleDelivery, scheduleNodeDelivery, validScheduleDelivery } from './delivery.ts'
import { WorkflowDefinition } from '../workflows/contracts.ts'
import { TestCronService } from './testing.ts'
import { withTempWorkspace } from '../testing/workspace.ts'

test('delivery comes from saved job evidence, not legacy action or strategy labels', () => {
  for (const action of ['session', 'agent', 'program']) {
    assert.deepEqual(scheduleNodeDelivery({ kind: 'schedule-action', action, job: { id: 'stable', session: 'fresh' } }), { kind: 'automation', jobId: 'stable', context: 'fresh-per-run' })
    assert.deepEqual(scheduleNodeDelivery({ kind: 'schedule-action', action, job: { target: { sessionId: 'fixed' } } }), { kind: 'session', sessionId: 'fixed', context: 'reuse' })
  }
  assert.equal(scheduleDelivery({ session: 'fresh' }), undefined)
  assert.equal(scheduleDelivery({ id: 'a', session: 'fresh', target: { sessionId: 'fixed' } }), undefined)
  const job = { id: 'stable', session: 'fresh' }
  assert.equal(validScheduleDelivery({ kind: 'automation', jobId: 'other', context: 'fresh-per-run' }, job), false)
  assert.equal(scheduleNodeDelivery({ kind: 'schedule-action', job, delivery: { kind: 'automation', jobId: 'other', context: 'fresh-per-run' } }), undefined)
  assert.equal(WorkflowDefinition.safeParse({ id: 'schedule:stable', source: { kind: 'schedule', id: 'stable' }, enabled: true, nodes: [{ kind: 'schedule-action', action: 'agent', job, delivery: { kind: 'automation', jobId: 'other', context: 'fresh-per-run' } }] }).success, false)
})

test('new schedule adapter records delivery; equivalent historical definitions do not revision churn or replay', async () => withTempWorkspace(async directory => {
  const cron = new TestCronService(directory)
  let calls = 0
  cron.setHandler(async () => { calls++ })
  try {
    cron.addJob({ schedule: 'every 1h', session: 'fresh', task: 'fixture' }, 'stable')
    await cron.flush()
    const definition = cron.workflow.inspect().definitions[0]
    assert.deepEqual(scheduleNodeDelivery(definition.nodes[0]), { kind: 'automation', jobId: 'stable', context: 'fresh-per-run' })
    assert.ok('delivery' in definition.nodes[0])
    const legacy = structuredClone(definition)
    if (legacy.nodes[0].kind === 'schedule-action') delete legacy.nodes[0].delivery
    cron.workflow.define(legacy)
    await cron.start()
    assert.deepEqual(cron.workflow.inspect().definitions[0], legacy)
    assert.equal(calls, 0)
    await cron.updateJob('stable', { schedule: 'every 2h', session: 'fresh', task: 'changed' })
    assert.equal(cron.workflow.inspect().definitions[0].revision, legacy.revision + 1)
    assert.ok('delivery' in cron.workflow.inspect().definitions[0].nodes[0])
    assert.equal(calls, 0)
  } finally { await cron.stop() }
}))

test('managed strategy registration timestamps do not revise canonical delivery', async () => withTempWorkspace(async directory => {
  const cron = new TestCronService(directory)
  const def = { schedule: 'every 3600000ms', session: 'fresh' as const, source: 'learning' as const, task: 'preflight' }
  try {
    cron.registerManagedJob('learning:fixture', def, 3600000, async () => {})
    const before = cron.workflow.inspect().definitions[0]
    const legacy = structuredClone(before)
    if (legacy.nodes[0].kind === 'schedule-action') (legacy.nodes[0].job as Record<string, unknown>).createdAt = '2000-01-01T00:00:00.000Z'
    cron.workflow.define(legacy)
    cron.registerManagedJob('learning:fixture', def, 3600000, async () => {})
    assert.deepEqual(cron.workflow.inspect().definitions[0], legacy)
    assert.deepEqual(scheduleNodeDelivery(legacy.nodes[0]), { kind: 'automation', jobId: 'learning:fixture', context: 'fresh-per-run' })
  } finally { await cron.stop() }
}))
