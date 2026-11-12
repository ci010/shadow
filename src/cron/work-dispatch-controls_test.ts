import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'
import { CronService, parseStoredCronJobs } from './service.ts'
import { registerAutomationRoutes } from './routes.ts'
import { WORK_DISPATCH_AUTOMATION } from './defaults.ts'
import { WORK_DISPATCH_DEFAULT_KEY, WORK_DISPATCH_ID, workDispatchConfigSchema } from './work-dispatch-contract.ts'
import type { SessionManager } from '../sessions/session-manager.ts'
import { withTempWorkspace } from '../testing/workspace.ts'

const sessions = { automationFeatureStates: async () => [] } as unknown as SessionManager
const endpoint = `/api/automations/${WORK_DISPATCH_ID}`

test('standard program automation persists its 60s schedule, target, limits and enablement; API is authorized and rejects invalid configured targets', async () => withTempWorkspace(async home => {
  const cron = new CronService(home)
  let runs = 0, resumed = 0, stopped = 0
  let release: (() => void) | undefined
  cron.setHandler(async job => { assert.equal(job.program?.kind, 'work-dispatch'); runs++; await new Promise<void>(resolve => { release = resolve }) })
  await cron.start()
  await cron.ensureDefaultJob(WORK_DISPATCH_DEFAULT_KEY, WORK_DISPATCH_AUTOMATION)
  const app = new Hono()
  registerAutomationRoutes(app, cron, sessions, 'project', undefined, undefined, undefined, {
    authorize: request => request.headers.get('x-owner') === 'yes', preference: () => false, update: async () => {},
  }, undefined, {
    validateAdmission: async () => {},
    validate: async config => { if (config.folderId !== 'local-repository') throw new Error('Registered available local repository required; remote or missing targets are refused') },
    resume: async () => { resumed++ }, cancel: async () => { stopped++; return true },
  })
  const request = (suffix: string, method: string, body?: unknown, authorized = true) => app.request(endpoint + suffix, {
    method, headers: { 'content-type': 'application/json', ...(authorized ? { 'x-owner': 'yes' } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  try {
    const listed = await (await app.request('/api/automations')).json()
    const summary = listed.automations.find((item: { id: string }) => item.id === WORK_DISPATCH_ID)
    assert.equal(summary.schedule, 'every 60s')
    assert.equal(summary.enabled, false)
    assert.equal(summary.configurationError, undefined)
    assert.match(summary.notice, /without a default Workspace/)
    assert.equal((await request('/run', 'POST')).status, 400)
    assert.equal((await request('', 'PATCH', { enabled: true })).status, 200, 'Project admission does not require an execution target')
    assert.equal((await request('', 'PATCH', { program: { kind: 'work-dispatch', folderId: 'remote' } })).status, 400)
    assert.equal((await request('', 'PATCH', { enabled: true }, false)).status, 403)
    assert.equal((await request('/run', 'POST', undefined, false)).status, 403)
    assert.equal((await request('/work/resume', 'POST', { key: 'work:fixture', version: 1 }, false)).status, 403)
    assert.equal(resumed, 0)
    assert.equal(runs, 0)
    assert.equal((await request('', 'PATCH', { program: { kind: 'work-dispatch', folderId: 'local-repository', inferenceRequests: 7 }, schedule: 'every 60s' })).status, 200)
    assert.equal((await request('', 'PATCH', { enabled: true })).status, 200)
    const running = cron.runNow(WORK_DISPATCH_ID)
    while (!release) await new Promise(resolve => setImmediate(resolve))
    assert.equal(cron.isRunning(WORK_DISPATCH_ID), true)
    const overlap = cron.runNow(WORK_DISPATCH_ID)
    release(); await Promise.all([running, overlap])
    assert.equal(runs, 1)
    assert.equal(cron.isRunning(WORK_DISPATCH_ID), false)
    assert.equal((await request('/cancel', 'POST')).status, 200)
    assert.equal(stopped, 1)
    assert.equal((await request('/work/resume', 'POST', { key: 'work:fixture', version: 1 })).status, 202)
    assert.equal(resumed, 1)
    assert.equal((await request('', 'PATCH', { enabled: false })).status, 200)
    await cron.flush()
    const restored = new CronService(home)
    try {
      await restored.start()
      const persisted = restored.listJobs().find(job => job.id === WORK_DISPATCH_ID)!
      assert.equal(persisted.schedule, 'every 60s')
      assert.equal(persisted.enabled, false)
      assert.equal(persisted.program?.folderId, 'local-repository')
      assert.equal(persisted.program?.inferenceRequests, 7)
      await restored.ensureDefaultJob(WORK_DISPATCH_DEFAULT_KEY, WORK_DISPATCH_AUTOMATION)
      assert.equal(restored.listJobs().filter(job => job.program).length, 1)
    } finally { await restored.stop() }
    assert.throws(() => cron.addJob({ ...WORK_DISPATCH_AUTOMATION, program: workDispatchConfigSchema.parse({ kind: 'work-dispatch', folderId: 'other' }) }, 'another-dispatcher'), /Invalid cron job/)
    assert.doesNotThrow(() => parseStoredCronJobs({ version: 1, ownershipVersion: 2, jobs: [{ ...WORK_DISPATCH_AUTOMATION, id: WORK_DISPATCH_ID, createdAt: new Date().toISOString(), enabled: true }] }))
  } finally { release?.(); await cron.stop() }
}))

test('program mutation and recovery fail closed when no human authorization controller is installed', async () => withTempWorkspace(async home => {
  const cron = new CronService(home)
  try {
    await cron.start()
    await cron.ensureDefaultJob(WORK_DISPATCH_DEFAULT_KEY, WORK_DISPATCH_AUTOMATION)
    const app = new Hono()
    registerAutomationRoutes(app, cron, sessions, 'project')
    assert.equal((await app.request(endpoint, { method: 'PATCH', body: JSON.stringify({ enabled: true }) })).status, 403)
    assert.equal((await app.request(endpoint + '/run', { method: 'POST' })).status, 403)
    assert.equal((await app.request(endpoint + '/work/resume', { method: 'POST' })).status, 403)
  } finally { await cron.stop() }
}))


test('workspace-less Project dispatch enables, runs manually and persists without weakening selected-target validation', async () => withTempWorkspace(async home => {
  const cron = new CronService(home)
  let runs = 0
  cron.setHandler(async job => { assert.equal(job.program?.folderId, undefined); runs++ })
  await cron.start()
  await cron.ensureDefaultJob(WORK_DISPATCH_DEFAULT_KEY, WORK_DISPATCH_AUTOMATION)
  const app = new Hono()
  registerAutomationRoutes(app, cron, sessions, 'project', undefined, undefined, undefined, {
    authorize: () => true, preference: () => false, update: async () => {},
  }, undefined, {
    validateAdmission: async () => {},
    validate: async config => { if (config.folderId && config.folderId !== 'supported-repository') throw new Error('An exact available source is required') },
    resume: async () => {},
  })
  const patch = (body: unknown) => app.request(endpoint, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  try {
    assert.equal((await patch({ program: { kind: 'work-dispatch' } })).status, 200)
    assert.equal((await patch({ enabled: true })).status, 200)
    assert.equal((await patch({ program: { kind: 'work-dispatch', folderId: 'supported-repository' } })).status, 200)
    assert.equal((await patch({ enabled: true })).status, 200)
    assert.equal((await patch({ program: { kind: 'work-dispatch' } })).status, 200, 'an enabled Project timer needs no default repository')
    assert.equal((await patch({ enabled: false })).status, 200)
    assert.equal((await patch({ program: { kind: 'work-dispatch' } })).status, 200)
    assert.equal(cron.listJobs().find(job => job.id === WORK_DISPATCH_ID)?.program?.folderId, undefined)
    assert.equal((await app.request(endpoint + '/run', { method: 'POST' })).status, 202)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(runs, 1)
    assert.equal((await patch({ enabled: true })).status, 200)
    await cron.flush()
    const restored = new CronService(home)
    try {
      await restored.start()
      const saved = restored.listJobs().find(job => job.id === WORK_DISPATCH_ID)!
      assert.equal(saved.enabled, true); assert.equal(saved.program?.folderId, undefined)
    } finally { await restored.stop() }
  } finally { await cron.stop() }
}))


test('enabling a restored legacy default checks inference admission, not its stale execution source', async () => withTempWorkspace(async home => {
  const original = new CronService(home)
  await original.start()
  await original.ensureDefaultJob(WORK_DISPATCH_DEFAULT_KEY, WORK_DISPATCH_AUTOMATION)
  await original.configureProgram(WORK_DISPATCH_ID, workDispatchConfigSchema.parse({ kind: 'work-dispatch', folderId: 'old-offline-source' }))
  await original.stop()
  const cron = new CronService(home)
  await cron.start()
  await cron.ensureDefaultJob(WORK_DISPATCH_DEFAULT_KEY, WORK_DISPATCH_AUTOMATION)
  let inferenceAvailable = true, targetChecks = 0
  const app = new Hono()
  registerAutomationRoutes(app, cron, sessions, 'project', undefined, undefined, undefined, {
    authorize: request => request.headers.get('x-owner') === 'yes', preference: () => false, update: async () => {},
  }, undefined, {
    validateAdmission: async () => { if (!inferenceAvailable) throw new Error('Configured model unavailable') },
    validate: async () => { targetChecks++; throw new Error('Saved execution source unavailable') },
    resume: async () => {},
  })
  const patch = (enabled: boolean, authorized = true) => app.request(endpoint, { method: 'PATCH', headers: {
    'content-type': 'application/json', ...(authorized ? { 'x-owner': 'yes' } : {}),
  }, body: JSON.stringify({ enabled }) })
  try {
    assert.equal((await patch(true, false)).status, 403)
    inferenceAvailable = false
    const denied = await patch(true)
    assert.equal(denied.status, 400)
    assert.match((await denied.json()).message, /Configured model unavailable/)
    assert.equal(cron.listJobs()[0]?.enabled, false)
    inferenceAvailable = true
    assert.equal((await patch(true)).status, 200)
    assert.equal(targetChecks, 0)
    assert.equal(cron.listJobs()[0]?.program?.folderId, 'old-offline-source', 'never silently clear saved targets')
    assert.equal((await app.request(endpoint + '/run', { method: 'POST', headers: { 'x-owner': 'yes' } })).status, 400)
    assert.equal(targetChecks, 1, 'execution still validates the exact saved target')
    inferenceAvailable = false
    assert.equal((await patch(false)).status, 200, 'disabling requires no inference or source')
  } finally { await cron.stop() }
}))
