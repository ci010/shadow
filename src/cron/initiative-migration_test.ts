import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withTempWorkspace } from '../testing/workspace.ts'
import { CronService } from './service.ts'

test('cron restores legacy Initiative linkage independently from its folder', async () => {
  await withTempWorkspace(async home => {
    await mkdir(join(home, '.cron'))
    await writeFile(join(home, '.cron', 'jobs.json'), JSON.stringify({
      version: 1,
      ownershipVersion: 2,
      jobs: [{
        id: 'scheduled-work', createdAt: '2026-09-16T00:00:00.000Z', schedule: '0 0 1 1 *',
        enabled: false, session: 'fresh', folderId: 'folder-one', projectName: 'cleanup', task: 'Continue work',
      }],
    }))
    const service = new CronService(home)
    try {
      await service.start()
      const job = service.listJobs()[0]
      assert.equal(job.folderId, 'folder-one')
      assert.equal(job.initiativeId, 'cleanup')
      assert.equal('projectName' in job, false)
    } finally { await service.stop() }
  })
})
