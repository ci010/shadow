import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CronService } from '../../cron/service.ts'
import { scheduleSessionRetirement, SESSION_RETIREMENT_INTERVAL_MS, SESSION_RETIREMENT_JOB_ID } from './session-retirement.ts'

test('retirement starts after readiness, runs daily, and drains on shutdown', async () => {
  let callback!: (signal: AbortSignal) => Promise<void>
  let scans = 0
  const stopped: string[] = []
  const cron = {
    registerMaintenanceJob(id: string, interval: number, handler: typeof callback) {
      assert.equal(id, SESSION_RETIREMENT_JOB_ID)
      assert.equal(interval, 24 * 60 * 60 * 1000)
      assert.equal(interval, SESSION_RETIREMENT_INTERVAL_MS)
      callback = handler
    },
    async runNow() { await callback(new AbortController().signal) },
    async unregisterMaintenanceJob(id: string) { assert.equal(id, SESSION_RETIREMENT_JOB_ID); stopped.push('unregister') },
  } as unknown as CronService
  const scheduler = scheduleSessionRetirement(cron, {
    async scan(signal) { assert.equal(signal?.aborted, false); scans++ },
    async stop() { stopped.push('drained') },
  })
  await callback(new AbortController().signal)
  assert.equal(scans, 0)
  await scheduler.start()
  assert.equal(scans, 1)
  await callback(new AbortController().signal)
  assert.equal(scans, 2)
  await scheduler.stop()
  assert.deepEqual(stopped, ['drained', 'unregister'])
  await callback(new AbortController().signal)
  assert.equal(scans, 2)
})
