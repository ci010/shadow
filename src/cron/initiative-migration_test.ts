import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { withTempWorkspace } from '../testing/workspace.ts'
import { workspacePath } from '../utils/paths.ts'
import { CronService } from './service.ts'

test('cron rejects legacy planning metadata instead of silently importing it', async () => {
  await withTempWorkspace(async home => {
    await mkdir(workspacePath(home, '.cron'), { recursive: true })
    await writeFile(workspacePath(home, '.cron', 'jobs.json'), JSON.stringify({
      version: 1,
      ownershipVersion: 2,
      jobs: [{
        id: 'scheduled-work', createdAt: '2026-09-16T00:00:00.000Z', schedule: '0 0 1 1 *',
        enabled: false, session: 'fresh', folderId: 'folder-one', projectName: 'cleanup', task: 'Continue work',
      }],
    }))
    const service = new CronService(home)
    try {
      await assert.rejects(service.start(), /Unsupported legacy Work context/)
    } finally { await service.stop() }
  })
})
