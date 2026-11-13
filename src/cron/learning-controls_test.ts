import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'
import { ConfigSchema } from '../config/schema.ts'
import { learningInterval, updateLearningEnabled, updateLearningInterval } from './learning-controls.ts'
import { registerAutomationRoutes } from './routes.ts'
import type { CronService } from './service.ts'
import type { SessionManager } from '../sessions/session-manager.ts'
import { ProjectConfigStore } from '../projects/config-store.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { join } from 'node:path'

test('explicit enable converts legacy pause without enabling siblings; interval writes preserve all enable state and survive restart', async () => withTempWorkspace(async workspace => {
  const options = { configPath: join(workspace, 'project.json'), home: workspace, getSharedConfig: () => ConfigSchema.parse({}) }
  const store = new ProjectConfigStore(options)
  await store.init()
  await store.update(raw => ({ ...raw, learning: { ...(raw.learning as object), enabled: false } }))
  const initial = store.current().learning
  const cron = { workflowStatus: () => undefined, listJobs: () => ['reflector', 'encapsulator', 'soul-reflector'].map(name => ({ id: `learning:${name}`, source: 'learning', session: 'fresh', schedule: 'every 1h', enabled: false })) } as unknown as CronService
  const sessions = { automationFeatureStates: async () => [] } as unknown as SessionManager
  const app = new Hono()
  registerAutomationRoutes(app, cron, sessions, 'fixture', undefined, undefined, {
    preference: () => true, globallyEnabled: () => true,
    interval: id => learningInterval(store.current().learning, id),
    update: async (id, enabled) => { await store.update(raw => ({ ...raw, learning: updateLearningEnabled(raw.learning as typeof initial, id, enabled) })) },
    updateInterval: async (id, interval) => { await store.update(raw => ({ ...raw, learning: updateLearningInterval(raw.learning as typeof initial, id, interval) })) },
  })
  const patch = (body: unknown, id = 'learning:reflector') => app.request('/api/automations/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  for (const intervalMs of [0, -60000, 1, 60001, 35792 * 60000, '60000', null]) assert.equal((await patch({ intervalMs })).status, 400)
  assert.equal((await patch({ intervalMs: 60000, enabled: true })).status, 400)
  assert.equal((await patch({ intervalMs: 60000 }, 'unknown')).status, 404)
  assert.equal((await patch({ intervalMs: 60000 })).status, 200)
  assert.deepEqual(store.current().learning, { ...initial, reflectIntervalMs: 60000 })
  assert.equal((await patch({ enabled: false })).status, 200)
  assert.equal((store.current().learning as { enabled?: boolean }).enabled, false)
  assert.equal((await patch({ enabled: true })).status, 200)
  assert.deepEqual(store.current().learning.pipelines, { reflector: true, encapsulator: false, soulReflector: false })
  assert.equal((store.current().learning as { enabled?: boolean }).enabled, true)
  const normalized = store.current().learning
  const saved = await patch({ intervalMs: 35791 * 60000 }, 'learning:encapsulator')
  assert.equal(saved.status, 200)
  assert.equal((await saved.json()).automation.intervalMs, 35791 * 60000)
  assert.deepEqual(store.current().learning, { ...normalized, encapsulateIntervalMs: 35791 * 60000 })
  const restored = new ProjectConfigStore(options); await restored.init()
  assert.deepEqual(restored.current().learning, store.current().learning)
  assert.deepEqual(updateLearningEnabled(restored.current().learning, 'learning:encapsulator', true).pipelines, { reflector: true, encapsulator: true, soulReflector: false })
  assert.throws(() => learningInterval(initial, 'learning:unknown'), /Unknown/)
}))
