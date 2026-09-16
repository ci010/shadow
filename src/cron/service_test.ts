import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { Cron } from 'croner'
import { withTempWorkspace } from '../testing/workspace.ts'
import { CronService } from './service.ts'
import { createOrganizationScope, getOrganizationScope } from '../organizations/scope.ts'

const mondayJob = {
  id: 'monday',
  schedule: '0 9 * * 1',
  task: 'Weekly task',
  createdAt: '2026-09-10T00:00:00.000Z',
  target: { sessionId: 'web:test' },
}

async function writeStore(workspace: string, content: string): Promise<string> {
  await mkdir(join(workspace, '.cron'), { recursive: true })
  const path = join(workspace, '.cron', 'jobs.json')
  await writeFile(path, content)
  return path
}

test('legacy cron jobs are rejected without scheduling or rewriting them', async (t) => {
  await withTempWorkspace(async (workspace) => {
    const raw = JSON.stringify([mondayJob])
    const path = await writeStore(workspace, raw)
    const nextRun = t.mock.method(Cron.prototype, 'nextRun')
    const service = new CronService(workspace)
    try {
      await assert.rejects(service.start(), /Legacy jobs file:.*recreate the jobs/)
      assert.equal(nextRun.mock.callCount(), 0)
      assert.deepEqual(service.listJobs(), [])
      assert.equal(await readFile(path, 'utf8'), raw)
    } finally {
      await service.stop()
    }
  })
})

test('versioned jobs use standard weekdays in the configured timezone', async (t) => {
  await withTempWorkspace(async (workspace) => {
    await writeStore(workspace, JSON.stringify({ version: 1, jobs: [mondayJob] }))
    const nextRun = t.mock.method(Cron.prototype, 'nextRun')
    const service = new CronService(workspace, 'Asia/Shanghai')
    try {
      await service.start()
      assert.deepEqual(service.listJobs(), [mondayJob])
      const scheduled = nextRun.mock.calls[0]?.this
      assert.ok(scheduled instanceof Cron)
      assert.equal(
        scheduled.nextRun(new Date('2026-09-10T00:00:00Z'))?.toISOString(),
        '2026-09-14T01:00:00.000Z',
      )
    } finally {
      await service.stop()
    }
  })
})

test('invalid cron stores fail without discarding the original data', async (t) => {
  const stores = [
    '',
    '{broken',
    JSON.stringify({ version: 2, jobs: [mondayJob] }),
    JSON.stringify({ version: 1, jobs: [{ ...mondayJob, schedule: 1 }] }),
    JSON.stringify({ version: 1, jobs: [mondayJob, mondayJob] }),
  ]
  for (const raw of stores) {
    await t.test(raw || 'empty file', async () => {
      await withTempWorkspace(async (workspace) => {
        const path = await writeStore(workspace, raw)
        const service = new CronService(workspace)
        try {
          await assert.rejects(service.start())
          assert.deepEqual(service.listJobs(), [])
          assert.equal(await readFile(path, 'utf8'), raw)
        } finally {
          await service.stop()
        }
      })
    })
  }
})

test('new cron jobs persist the format version and can be reloaded', async (t) => {
  await withTempWorkspace(async (workspace) => {
    const service = new CronService(workspace)
    const reloaded = new CronService(workspace)
    try {
      await service.start()
      const id = service.addJob({ schedule: '0 9 * * SUN', task: 'Sunday task' })
      await t.waitFor(async () => {
        const raw = await readFile(join(workspace, '.cron', 'jobs.json'), 'utf8')
        assert.deepEqual(JSON.parse(raw), { version: 1, jobs: service.listJobs() })
        return true
      })

      await service.stop()
      await reloaded.start()
      assert.equal(reloaded.listJobs()[0]?.id, id)
      assert.equal(reloaded.listJobs()[0]?.schedule, '0 9 * * SUN')
      assert.equal(reloaded.removeJob(id), true)
      await t.waitFor(async () => {
        const raw = await readFile(join(workspace, '.cron', 'jobs.json'), 'utf8')
        assert.deepEqual(JSON.parse(raw), { version: 1, jobs: [] })
        return true
      })
    } finally {
      await service.stop()
      await reloaded.stop()
    }
  })
})

test('same-name cron jobs bind runtime scope and stopping one drains only its own execution and writes', async (t) => {
  await withTempWorkspace(async (root) => {
    const homes = [join(root, 'a'), join(root, 'b')]
    const scopes = [createOrganizationScope('a'), createOrganizationScope('b')]
    const services = homes.map((home, i) => new CronService(home, 'UTC', scopes[i]))
    const scheduled: Cron[] = []
    const nextRun = t.mock.method(Cron.prototype, 'nextRun')
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const calls = [0, 0]
    let signal: AbortSignal | undefined
    try {
      for (let i = 0; i < services.length; i++) {
        await writeStore(homes[i], JSON.stringify({ version: 1, jobs: [mondayJob] }))
        services[i].setHandler(async (_job, abort) => {
          assert.equal(getOrganizationScope(), scopes[i])
          calls[i]++
          if (i === 0) {
            signal = abort
            entered.resolve()
            await release.promise
          }
        })
        const before = nextRun.mock.callCount()
        await services[i].start()
        const cron = nextRun.mock.calls[before]?.this
        assert(cron instanceof Cron)
        scheduled.push(cron)
      }
      const running = scheduled[0].trigger()
      await entered.promise
      let stopped = false
      const stopping = services[0].stop().then(() => { stopped = true })
      await new Promise<void>((resolve) => setImmediate(resolve))
      assert.equal(signal?.aborted, true)
      assert.equal(stopped, false)
      await scheduled[1].trigger()
      assert.deepEqual(calls, [1, 1])
      release.resolve()
      await Promise.all([running, stopping])
      await scheduled[0].trigger()
      await scheduled[1].trigger()
      assert.deepEqual(calls, [1, 2])
      services[1].addJob({ schedule: '0 10 * * MON', task: 'B only' })
      await services[1].stop()
      const a = JSON.parse(await readFile(join(homes[0], '.cron', 'jobs.json'), 'utf8'))
      const b = JSON.parse(await readFile(join(homes[1], '.cron', 'jobs.json'), 'utf8'))
      assert.equal(a.jobs.length, 1)
      assert.equal(b.jobs.length, 2)
      assert.equal(b.jobs[1].task, 'B only')
      assert.throws(() => services[0].addJob({ schedule: 'every 1m' }), /stopped/)
    } finally {
      release.resolve()
      await Promise.all(services.map((service) => service.stop()))
      scopes.forEach((scope) => scope.close())
    }
  })
})
