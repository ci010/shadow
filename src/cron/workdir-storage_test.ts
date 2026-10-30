import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { withTempWorkspace } from '../testing/workspace.ts'
import { workspacePath } from '../utils/paths.ts'
import { managedSessionWorkdirId } from '../execution/managed-workdir.ts'
import { CronService, parseStoredCronJobs } from './service.ts'

const legacy = { version: 1, nodeId: 'child', capabilityId: 'exact%2Flegacy' }
const job = { id: 'persisted', session: 'fresh', enabled: false, task: 'test', schedule: 'every 1h', createdAt: '2026-01-01T00:00:00.000Z', workdir: legacy }
const data = { version: 1, ownershipVersion: 2, jobs: [job] }

for (const savedRef of [legacy, { version: 2, nodeId: legacy.nodeId, resourceId: legacy.capabilityId }]) {
test(`cron reads saved V${savedRef.version} refs without rewriting and writes only workdirId after edit`, async () => withTempWorkspace(async root => {
  const file = workspacePath(root, '.cron/jobs.json')
  await mkdir(workspacePath(root, '.cron'), { recursive: true })
  const original = JSON.stringify({ ...data, jobs: [{ ...job, workdir: savedRef }] })
  await writeFile(file, original)
  const cron = new CronService(root)
  try {
    await cron.start()
    assert.deepEqual(cron.listJobs()[0].workdir, { version: 2, nodeId: 'child', workdirId: legacy.capabilityId })
    assert.equal(await readFile(file, 'utf8'), original)
    cron.addJob({ session: 'fresh', enabled: false, task: 'another', schedule: 'every 1h' })
    await cron.flush()
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).jobs[0].workdir, { version: 2, nodeId: 'child', workdirId: legacy.capabilityId })
  } finally { await cron.stop() }
}))

}

test('cron malformed refs fail closed and managed legacy refs retain runtime-bound Project provenance', () => {
  for (const workdir of [null, {}, { version: 3, nodeId: 'child', workdirId: 'unknown' }, { version: 2, nodeId: 'child', workdirId: '' }]) {
    assert.throws(() => parseStoredCronJobs({ ...data, jobs: [{ ...job, workdir }] }), /workdir/)
  }
  const managed = { ...legacy, capabilityId: managedSessionWorkdirId('p', 'web:session') }
  const document = { ...data, jobs: [{ ...job, workdir: managed }] }
  assert.deepEqual(parseStoredCronJobs(document, 'p').jobs[0].workdir, { version: 2, nodeId: 'child', workdirId: managed.capabilityId })
  assert.throws(() => parseStoredCronJobs(document, 'other'), /ownership/)
})
