import assert from 'node:assert/strict'
import test from 'node:test'
import { CronService } from '../../cron/service.ts'
import { withTempWorkspace } from '../../testing/workspace.ts'
import type { KnowledgeMaintenanceStatus } from '../../knowledge/maintenance-contracts.ts'
import { scheduleKnowledgeMaintenance, KNOWLEDGE_MAINTENANCE_JOB_ID, KNOWLEDGE_MAINTENANCE_CHECK_MS } from './knowledge-maintenance.ts'

const day = 24 * 60 * 60 * 1000
test('daily maintenance resumes durable cadence, catches up after startup and honors manual scans', async () => {
  await withTempWorkspace(async home => {
    const cron = new CronService(home)
    let now = Date.parse('2026-09-20T00:00:00Z')
    let calls = 0
    const status: KnowledgeMaintenanceStatus = { intervalMs: day, scanning: false, report: null }
    const scheduler = scheduleKnowledgeMaintenance(cron, {
      status: () => status,
      scan: async () => {
        calls++
        status.report = { id: String(calls), scannedAt: new Date(now).toISOString(), entriesScanned: 0, findings: [] }
        return status.report
      },
    }, () => now)
    try {
      await cron.runNow(KNOWLEDGE_MAINTENANCE_JOB_ID)
      assert.equal(calls, 0, 'Do not scan before skill discovery is ready')
      await scheduler.start()
      assert.equal(calls, 1, 'Missing or overdue persisted report is scanned on startup')
      now += day - 1
      await cron.runNow(KNOWLEDGE_MAINTENANCE_JOB_ID)
      assert.equal(calls, 1)
      now++
      await cron.runNow(KNOWLEDGE_MAINTENANCE_JOB_ID)
      assert.equal(calls, 2)
      now += day - 100
      status.report!.scannedAt = new Date(now).toISOString()
      now += KNOWLEDGE_MAINTENANCE_CHECK_MS
      await cron.runNow(KNOWLEDGE_MAINTENANCE_JOB_ID)
      assert.equal(calls, 2, 'A manual scan advances the durable cadence')
      await scheduler.stop()
      const restarted = scheduleKnowledgeMaintenance(cron, {
        status: () => status, scan: async () => { calls++; return status.report! },
      }, () => now)
      await restarted.start()
      assert.equal(calls, 2, 'Restarting does not repeat a recent persisted scan')
      await restarted.stop()
    } finally { await scheduler.stop(); await cron.stop() }
  })
})

test('failed scheduled scans retry no faster than the check interval', async () => {
  await withTempWorkspace(async home => {
    const cron = new CronService(home)
    let now = 1
    let calls = 0
    const scheduler = scheduleKnowledgeMaintenance(cron, {
      status: () => ({ intervalMs: day, scanning: false, report: null }),
      scan: async () => { calls++; throw new Error('unavailable') },
    }, () => now)
    try {
      await assert.rejects(scheduler.start(), /unavailable/)
      await scheduler.start()
      assert.equal(calls, 1)
      now += KNOWLEDGE_MAINTENANCE_CHECK_MS
      await assert.rejects(scheduler.start(), /unavailable/)
      assert.equal(calls, 2)
    } finally { await scheduler.stop(); await cron.stop() }
  })
})
