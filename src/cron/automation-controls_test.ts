import { automationDispatchModel, automationModelSettings } from './automation-model.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'
import { TestCronService as CronService } from './testing.ts'
import { registerAutomationRoutes } from './routes.ts'
import type { SessionManager } from '../sessions/session-manager.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { ProjectConfigStore } from '../projects/config-store.ts'
import { ConfigSchema } from '../config/schema.ts'
import { join } from 'node:path'

const sessions = { querySessionHistoryStates: async () => ({ states: [], total: 0 }), automationFeatureStates: async () => [], listHistoryStates: async () => [], listSessions: () => [] } as unknown as SessionManager

test('persisted cron controls reject invalid/unknown jobs, isolate items and restore disabled preferences', async () => {
  await withTempWorkspace(async workspace => {
    const cron = new CronService(workspace)
    await cron.start()
    const a = cron.addJob({ session: 'fresh', schedule: 'every 1h', task: 'a' })
    const b = cron.addJob({ session: 'fresh', schedule: 'every 1h', task: 'b' })
    const app = new Hono()
    registerAutomationRoutes(app, cron, sessions, 'a')
    const patch = (id: string, body: unknown) => app.request(`/api/automations/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    try {
      assert.equal((await patch(a, { enabled: 'false' })).status, 400)
      assert.equal((await patch(a, { enabled: false, task: 'replace' })).status, 400)
      assert.equal((await patch('unknown', { enabled: true })).status, 404)
      assert.equal((await patch(a, { enabled: false })).status, 200)
      assert.equal(cron.listJobs().find(job => job.id === a)!.enabled, false)
      assert.notEqual(cron.listJobs().find(job => job.id === b)!.enabled, false)
      await cron.stop()
      const restored = new CronService(workspace)
      await restored.start()
      try {
        assert.equal(restored.listJobs().find(job => job.id === a)!.enabled, false)
        assert.equal(await restored.setJobEnabled(a, true), true)
        assert.equal(restored.listJobs().find(job => job.id === a)!.enabled, true)
      } finally { await restored.stop() }
    } finally { await cron.stop() }
  })
})

test('learning preferences persist while master is off and inventory distinguishes configured/effective state', async () => {
  await withTempWorkspace(async workspace => {
    const options = { configPath: join(workspace, 'project.json'), home: workspace, getSharedConfig: () => ConfigSchema.parse({}) }
    const store = new ProjectConfigStore(options)
    await store.init()
    await store.update(raw => ({ ...raw, learning: { ...(raw.learning as object), enabled: false, pipelines: { reflector: false } } }))
    const restored = new ProjectConfigStore(options)
    await restored.init()
    assert.equal(restored.current().learning.pipelines?.reflector, false)
    const cron = new CronService(workspace)
    cron.registerManagedJob('learning:reflector', { session: 'fresh', source: 'learning', schedule: 'every 1h', enabled: false }, 3600000, async () => {})
    const app = new Hono()
    registerAutomationRoutes(app, cron, sessions, 'a', undefined, undefined, {
      preference: () => restored.current().learning.pipelines?.reflector !== false,
      globallyEnabled: () => false,
      update: async (_id, enabled) => { await restored.update(raw => ({ ...raw, learning: { ...(raw.learning as object), pipelines: { reflector: enabled } } })) },
    })
    try {
      const result = await app.request('/api/automations/learning:reflector', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }) })
      assert.equal(result.status, 200)
      assert.deepEqual((await result.json()).automation, { id: 'learning:reflector', name: 'learning:reflector', source: 'learning', session: 'fresh', schedule: 'every 1h', enabled: false, configuredEnabled: true, editable: true, disabledByGlobal: true, workflow: { id: 'schedule:learning:reflector', pending: 0, blocked: 0 } })
      const restarted = new ProjectConfigStore(options)
      await restarted.init()
      assert.equal(restarted.current().learning.pipelines?.reflector, true)
      await restarted.update(raw => ({ ...raw, learning: { ...(raw.learning as object), enabled: true } }))
      assert.equal(restarted.current().learning.pipelines?.reflector, true)
    } finally { await cron.stop() }
  })
})

test('disabling a cron timer stops future admissions and re-enabling resumes only that item', async () => {
  await withTempWorkspace(async workspace => {
    const cron = new CronService(workspace)
    const calls = new Map<string, number>()
    cron.setHandler(async job => { calls.set(job.id, (calls.get(job.id) ?? 0) + 1) })
    await cron.start()
    const a = cron.addJob({ session: 'fresh', schedule: 'every 1s' })
    const b = cron.addJob({ session: 'fresh', schedule: 'every 1s' })
    try {
      await cron.setJobEnabled(a, false)
      await new Promise(resolve => setTimeout(resolve, 1200))
      assert.equal(calls.get(a), undefined)
      assert.ok((calls.get(b) ?? 0) > 0)
      await cron.setJobEnabled(a, true)
      await new Promise(resolve => setTimeout(resolve, 1200))
      assert.ok((calls.get(a) ?? 0) > 0)
      await cron.setJobEnabled(a, false)
      const count = calls.get(a)
      await new Promise(resolve => setTimeout(resolve, 1200))
      assert.equal(calls.get(a), count)
    } finally { await cron.stop() }
  })
})


test('system controls are stable, authorized, independent and persist per project', async () => withTempWorkspace(async workspace => {
  const options = { configPath: join(workspace, 'project.json'), home: workspace, getSharedConfig: () => ConfigSchema.parse({}) }
  const store = new ProjectConfigStore(options); await store.init()
  const app = new Hono(), cron = new CronService(workspace)
  registerAutomationRoutes(app, cron, sessions, 'fixture', undefined, undefined, undefined, {
    authorize: request => request.headers.get('x-owner') === 'yes',
    preference: () => store.current().organization.enabled,
    update: async (id, enabled) => { await store.update(raw => ({ ...raw, organization: { ...(raw.organization as object), enabled } })) },
  })
  const patch = (body: unknown, owner = 'yes') => app.request('/api/automations/system:work-organizer', { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'x-owner': owner }, body: JSON.stringify(body) })
  assert.equal((await patch({ enabled: false }, 'no')).status, 403)
  assert.equal((await patch({ enabled: 'false' })).status, 400)
  assert.equal((await patch({ enabled: false })).status, 200)
  const inventory = (await (await app.request('/api/automations')).json()).automations
  assert.equal(inventory.find((job: { id: string }) => job.id === 'system:work-organizer').enabled, false)
  assert.equal(inventory.find((job: { id: string }) => job.id === 'system:work-observer'), undefined)
  assert.equal((await app.request('/api/automations/system:work-observer', { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'x-owner': 'yes' }, body: '{"enabled":true}' })).status, 404)
  assert.equal((await app.request('/api/automations/system:work-organizer/runs')).status, 200)
  const restored = new ProjectConfigStore(options); await restored.init()
  assert.equal(restored.current().organization.enabled, false)
}))


test('historical system snapshots expose authorized controller capability without changing definition or runtime state', async () => {
  const states = [
    { sessionId: 'history', automation: { jobId: 'old-organizer', name: 'Old organizer', runId: 'history', startedAt: '2026-01-01T00:00:00Z', contextMode: 'fresh', config: { source: 'system', schedule: 'Historical', agentType: 'work-organizer' } } },
    { sessionId: 'custom', automation: { jobId: 'custom-organizer', name: '话题整理', runId: 'custom', startedAt: '2026-01-01T00:00:00Z', contextMode: 'fresh', config: { source: 'cron', schedule: 'Historical', agentType: 'work-organizer' } } },
  ]
  const history = { automationFeatureStates: async () => states, listHistoryStates: async () => states, listSessions: () => states, getSessionState: (id: string) => states.find(state => state.sessionId === id) } as unknown as SessionManager
  const app = new Hono()
  registerAutomationRoutes(app, { listJobs: () => [] } as unknown as CronService, history, 'fixture', undefined, undefined, undefined, {
    authorize: request => request.headers.get('x-owner') === 'yes', preference: () => true, update: async () => {},
  })
  const authorized = (await (await app.request('/api/automations', { headers: { 'x-owner': 'yes' } })).json()).automations
  const old = authorized.find((job: { id: string }) => job.id === 'old-organizer')
  assert.equal(old.enabled, false)
  assert.equal(old.editable, false)
  assert.equal(old.canToggle, true)
  assert.equal(old.toggleId, 'system:work-organizer')
  assert.equal(old.toggleEnabled, true)
  assert.equal(authorized.find((job: { id: string }) => job.id === 'custom-organizer').toggleId, undefined)
  const denied = (await (await app.request('/api/automations')).json()).automations
  for (const job of denied) { assert.equal(job.canToggle, false); assert.equal(job.toggleId, undefined); assert.equal(job.toggleEnabled, undefined) }
})

 test('automation model API persists dispatch overrides and resets without editing saved runs', async () => withTempWorkspace(async workspace => {
  const options = { configPath: join(workspace, 'project.json'), home: workspace, getSharedConfig: () => ConfigSchema.parse({}) }
  const store = new ProjectConfigStore(options); await store.init()
  const app = new Hono(), cron = new CronService(workspace)
  registerAutomationRoutes(app, cron, sessions, 'fixture', undefined, undefined, undefined, {
    authorize: request => request.headers.get('x-owner') === 'yes', preference: () => true, update: async () => {},
    modelSettings: id => automationModelSettings(store.current(), id),
    updateModel: async (id, model) => { await store.update(raw => {
      const organization = { ...(raw.organization as Record<string, unknown>) }
      const key = 'model'
      if (model === null) delete organization[key]; else organization[key] = model
      return { ...raw, organization }
    }) },
  })
  const patch = (id: string, model: unknown, owner = 'yes') => app.request('/api/automations/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'x-owner': owner }, body: JSON.stringify({ model }) })
  assert.equal((await patch('system:work-observer', 'chosen', 'no')).status, 403)
  for (const model of ['', '   ', 2, 'x'.repeat(513)]) assert.equal((await patch('system:work-organizer', model)).status, 400)
  assert.equal((await patch('system:work-observer', 'observer@provider')).status, 404)
  const result = await patch('system:work-organizer', 'organizer@provider')
  assert.equal(result.status, 200)
  assert.equal((await result.json()).automation.model, 'organizer@provider')
  const restored = new ProjectConfigStore(options); await restored.init()
  assert.throws(() => automationDispatchModel(restored.current(), 'system:work-observer'), /Unknown system automation/)
  assert.equal(automationDispatchModel(restored.current(), 'system:work-organizer'), 'organizer@provider')
  assert.equal((await patch('system:work-organizer', null)).status, 200)
  assert.equal(automationDispatchModel(store.current(), 'system:work-organizer'), store.current().agent.quickModel ?? store.current().agent.model)
  assert.equal((await patch('system:work-observer', null)).status, 404)
  const publicJobs = (await (await app.request('/api/automations')).json()).automations
  assert.equal(publicJobs.find((job: { id: string }) => job.id === 'system:work-organizer').canConfigureModel, false)
}))


test('Workflow controls persist config-owned preferences and schedule state together across reconstruction', async () => withTempWorkspace(async workspace => {
  const { registerWorkflowRoutes } = await import('../workflows/management.ts')
  const options = { configPath: join(workspace, 'project.json'), home: workspace, getSharedConfig: () => ConfigSchema.parse({}) }
  const store = new ProjectConfigStore(options); await store.init()
  let cron = new CronService(workspace), globallyEnabled = true
  const registerLearning = () => cron.registerManagedJob('learning:reflector', { session: 'fresh', source: 'learning', schedule: 'every 1h', enabled: globallyEnabled && store.current().learning.pipelines?.reflector !== false }, 3600000, async () => {})
  await cron.start(); registerLearning()
  const ordinary = cron.addJob({ session: 'existing', target: { sessionId: 'web:fixed' }, schedule: 'every 1h', task: 'fixed delivery' })
  let fail = false
  const app = new Hono()
  const setFeature = registerAutomationRoutes(app, cron, sessions, 'fixture', undefined, undefined, {
    preference: () => store.current().learning.pipelines?.reflector !== false, globallyEnabled: () => globallyEnabled,
    update: async (_id, enabled) => {
      if (fail) throw new Error('synthetic config write failure')
      await store.update(raw => ({ ...raw, learning: { ...(raw.learning as object), pipelines: { reflector: enabled } } }))
      registerLearning()
    },
  }, { authorize: request => request.headers.get('x-owner') === 'yes', preference: () => true, update: async () => {} })
  registerWorkflowRoutes(app, cron.workflow, request => request.headers.get('x-owner') === 'yes', setFeature)
  const control = (id: string, action: string, owner = 'yes') => app.request('/api/workflows/control', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-owner': owner }, body: JSON.stringify({ id, action }) })
  const flow = 'schedule:learning:reflector'
  try {
    assert.equal((await control(flow, 'pause', 'no')).status, 403)
    assert.equal(store.current().learning.pipelines?.reflector, undefined)
    fail = true
    assert.equal((await control(flow, 'pause')).status, 409)
    assert.equal(cron.workflow.enabled(flow), true)
    assert.notEqual(cron.listJobs().find(job => job.id === 'learning:reflector')!.enabled, false)
    fail = false
    assert.equal((await control(flow, 'pause')).status, 200)
    assert.equal(store.current().learning.pipelines?.reflector, false)
    assert.equal(cron.workflow.enabled(flow), false)
    assert.equal(cron.listJobs().find(job => job.id === 'learning:reflector')!.enabled, false)
    assert.equal((await control(`schedule:${ordinary}`, 'pause')).status, 200)
    assert.equal(cron.listJobs().find(job => job.id === ordinary)!.enabled, false)
    assert.equal(cron.workflow.enabled(`schedule:${ordinary}`), false)
    assert.equal((await control(flow, 'resume')).status, 200)
    assert.equal(store.current().learning.pipelines?.reflector, true)
    assert.equal(cron.workflow.enabled(flow), true)
    assert.equal(cron.listJobs().find(job => job.id === 'learning:reflector')!.enabled, true)
    globallyEnabled = false; registerLearning()
    assert.equal((await control(flow, 'resume')).status, 200)
    assert.equal(store.current().learning.pipelines?.reflector, true, 'Preference saves without overriding the master switch')
    assert.equal(cron.workflow.enabled(flow), true)
    assert.equal(cron.listJobs().find(job => job.id === 'learning:reflector')!.enabled, false)
    globallyEnabled = true; registerLearning()
    assert.equal(cron.listJobs().find(job => job.id === 'learning:reflector')!.enabled, true)
    assert.equal((await control(flow, 'pause')).status, 200)
    await cron.stop()
    const restored = new ProjectConfigStore(options); await restored.init()
    assert.equal(restored.current().learning.pipelines?.reflector, false)
    cron = new CronService(workspace); await cron.start(); registerLearning()
    assert.equal(cron.workflow.enabled(flow), false)
    assert.equal(cron.listJobs().find(job => job.id === 'learning:reflector')!.enabled, false)
    assert.equal(cron.listJobs().find(job => job.id === ordinary)!.enabled, false)
  } finally { await cron.stop() }
}))


test('Workflow host controls use the authorized system config owner and retain failures without false success', async () => withTempWorkspace(async workspace => {
  const { registerWorkflowRoutes } = await import('../workflows/management.ts')
  const cron = new CronService(workspace)
  const options = { configPath: join(workspace, 'project.json'), home: workspace, getSharedConfig: () => ConfigSchema.parse({}) }
  const store = new ProjectConfigStore(options); await store.init()
  const id = 'internal:work-organizer'
  cron.workflow.define({ id, revision: 1, source: { kind: 'internal', id: 'organizer' }, nodes: [{ kind: 'host-action', handler: 'organizer', replay: 'confirm' }], enabled: true })
  const app = new Hono(), calls: string[] = []
  const feature = registerAutomationRoutes(app, cron, sessions, 'fixture', undefined, undefined, undefined, {
    authorize: request => request.headers.get('x-owner') === 'yes', preference: () => store.current().organization.enabled,
    update: async (job, enabled) => { calls.push(job); await store.update(raw => ({ ...raw, organization: { ...(raw.organization as object), enabled } })) },
  })
  registerWorkflowRoutes(app, cron.workflow, () => true, feature)
  const control = (action: string, owner: string) => app.request('/api/workflows/control', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-owner': owner }, body: JSON.stringify({ id, action }) })
  try {
    assert.equal((await control('pause', 'no')).status, 409, 'Feature owner authorization cannot be bypassed by the Workflow adapter')
    assert.deepEqual(calls, [])
    assert.equal(cron.workflow.enabled(id), true)
    assert.equal((await control('pause', 'yes')).status, 200)
    assert.deepEqual(calls, ['system:work-organizer'])
    assert.equal(cron.workflow.enabled(id), false)
    const restored = new ProjectConfigStore(options); await restored.init()
    assert.equal(restored.current().organization.enabled, false)
    assert.equal((await control('resume', 'yes')).status, 200)
    assert.equal(store.current().organization.enabled, true)
    assert.equal(cron.workflow.enabled(id), true)
  } finally { await cron.stop() }
}))
