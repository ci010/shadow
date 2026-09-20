import assert from 'node:assert/strict'
import test from 'node:test'
import { CronService } from './service.ts'
import { createProjectScope, getProjectScope } from '../projects/scope.ts'
import { withTempWorkspace } from '../testing/workspace.ts'

const settle = () => new Promise<void>(resolve => setImmediate(resolve))

test('maintenance uses scoped timers without agent jobs, handler calls or persistence', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  await withTempWorkspace(async home => {
    const scope = createProjectScope('knowledge-test')
    const cron = new CronService(home, 'UTC', scope)
    let scans = 0
    let agentCalls = 0
    cron.setHandler(async () => { agentCalls++ })
    try {
      await cron.start()
      cron.registerMaintenanceJob('maintenance:knowledge', 100, async () => {
        assert.equal(getProjectScope(), scope)
        scans++
      })
      assert.deepEqual(cron.listJobs(), [])
      t.mock.timers.tick(100)
      await settle()
      assert.equal(scans, 1)
      await cron.runNow('maintenance:knowledge')
      assert.equal(scans, 2)
      assert.equal(agentCalls, 0)
      cron.registerManagedJob('learning:fixture', { session: 'fresh', schedule: 'every 1m' }, 100, async () => { agentCalls++ })
      await cron.unregisterMaintenanceJob('learning:fixture')
      await cron.unregisterMaintenanceJob('maintenance:knowledge')
      t.mock.timers.tick(200)
      await settle()
      assert.equal(scans, 2)
      assert.equal(agentCalls, 1, 'Unregistering an unknown maintenance task must not stop a learning job')
      cron.unregisterManagedJob('learning:fixture')
      await assert.rejects(cron.runNow('maintenance:knowledge'), /Unknown cron job/)
    } finally { await cron.stop(); scope.close() }
  })
})

test('maintenance shares overlap protection and unregister aborts and drains only its task', async () => {
  await withTempWorkspace(async home => {
    const cron = new CronService(home)
    const entered = Promise.withResolvers<AbortSignal>()
    const released = Promise.withResolvers<void>()
    let calls = 0
    let otherCalls = 0
    try {
      cron.registerMaintenanceJob('maintenance:knowledge', 60_000, async signal => {
        calls++
        entered.resolve(signal)
        await released.promise
      })
      cron.registerMaintenanceJob('maintenance:other', 60_000, async () => { otherCalls++ })
      const first = cron.runNow('maintenance:knowledge')
      const signal = await entered.promise
      const second = cron.runNow('maintenance:knowledge')
      let drained = false
      const stopping = cron.unregisterMaintenanceJob('maintenance:knowledge').then(() => { drained = true })
      await settle()
      assert.equal(signal.aborted, true)
      assert.equal(drained, false)
      await cron.runNow('maintenance:other')
      assert.equal(otherCalls, 1)
      released.resolve()
      await Promise.all([first, second, stopping])
      assert.equal(calls, 1)
    } finally { released.resolve(); await cron.stop() }
  })
})

test('maintenance failures are propagated and IDs cannot collide with session jobs', async () => {
  await withTempWorkspace(async home => {
    const cron = new CronService(home)
    try {
      cron.registerMaintenanceJob('maintenance:broken', 60_000, async () => { throw new Error('scan failed') })
      await assert.rejects(cron.runNow('maintenance:broken'), /scan failed/)
      assert.throws(() => cron.registerMaintenanceJob('maintenance:broken', 10, async () => {}), /job ID/)
      assert.throws(() => cron.registerManagedJob('maintenance:broken', { session: 'fresh', schedule: 'every 1h' }, 10, async () => {}), /Invalid managed/)
      assert.throws(() => cron.registerMaintenanceJob('bad-interval', 0, async () => {}), /interval/)
      await cron.stop()
      assert.throws(() => cron.registerMaintenanceJob('stopped', 100, async () => {}), /stopped/)
    } finally { await cron.stop() }
  })
})
