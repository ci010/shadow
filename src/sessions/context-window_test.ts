import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { Hono } from 'hono'
import { Bus } from '../bus/bus.ts'
import { ConfigSchema } from '../config/schema.ts'
import { ModelDefaultsPatchSchema } from '../config/model-defaults.ts'
import { CONTEXT_WINDOWS, resolveInferenceSettings } from '../agent/llm-config.ts'
import { ProjectConfigStore } from '../projects/config-store.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { SessionManager, type SessionManagerDeps } from './session-manager.ts'
import { JsonlSessionStore } from './session-store-jsonl.ts'
import { SqliteSessionStore } from './session-store-sqlite.ts'
import type { SessionStore } from './session-store.ts'
import { sessionsApiPlugin } from './routes.ts'
import { HandoffManager } from './handoff/manager.ts'

const defaults = { model: 'fixture', temperature: 0, contextWindow: 123456 }

test('only explicit three-tier choices are validated; unset leaves legacy runtime budgets intact', () => {
  for (const contextWindow of CONTEXT_WINDOWS) {
    assert.equal(ConfigSchema.parse({ agent: { contextWindow } }).agent.contextWindow, contextWindow)
    assert.equal(ModelDefaultsPatchSchema.parse({ contextWindow }).contextWindow, contextWindow)
    assert.equal(resolveInferenceSettings(defaults, undefined, { contextWindow }).contextWindow, contextWindow)
  }
  for (const contextWindow of [0, 256001, 262144, '400000', true, NaN]) {
    assert.equal(ModelDefaultsPatchSchema.safeParse({ contextWindow }).success, false)
    assert.equal(ConfigSchema.safeParse({ agent: { contextWindow } }).success, false)
  }
  assert.equal(resolveInferenceSettings(defaults).contextWindow, 123456)
  assert.equal(resolveInferenceSettings(defaults, { contextWindow: 400000 }).contextWindow, 123456, 'Agent metadata cannot create an extra context layer')
  assert.equal(ConfigSchema.parse({ providers: { fixture: { modelContextWindows: { fixture: 123456 } } } }).providers.fixture.modelContextWindows?.fixture, 123456)
})

test('Project overrides inherit live global defaults, persist without pinning inherited values and stay isolated', async () => {
  await withTempWorkspace(async root => {
    let shared = ConfigSchema.parse({ agent: { contextWindow: 256000 } })
    const options = (id: string) => ({ configPath: join(root, `${id}.json`), home: join(root, id), getSharedConfig: () => shared })
    const a = new ProjectConfigStore(options('a'))
    const b = new ProjectConfigStore(options('b'))
    await a.init(); await b.init()
    await a.updateModelDefaults({ contextWindow: 400000 })
    assert.equal(a.current().agent.contextWindow, 400000)
    assert.equal(b.current().agent.contextWindow, 256000)
    shared = ConfigSchema.parse({ agent: { contextWindow: 1000000 } })
    assert.equal(a.current().agent.contextWindow, 400000)
    assert.equal(b.current().agent.contextWindow, 1000000)
    const reopened = new ProjectConfigStore(options('a'))
    await reopened.init()
    assert.equal(reopened.current().agent.contextWindow, 400000)
    await reopened.updateModelDefaults({ contextWindow: null })
    assert.equal(reopened.current().agent.contextWindow, 1000000)
    const inherited = new ProjectConfigStore(options('a'))
    await inherited.init()
    assert.equal(inherited.current().agent.contextWindow, 1000000)
    assert.equal(inherited.modelDefaults().overrides.contextWindow, undefined)
  })
})

for (const Store of [JsonlSessionStore, SqliteSessionStore]) test(`${Store.name}: API budgets persist per conversation, reset to Project and expose matching handoff details`, async () => {
  await withTempWorkspace(async workspace => {
    const store: SessionStore = new Store(join(workspace, 'sessions'))
    await store.init()
    const handoff = new HandoffManager({} as never, 256000, { autoHandoff: true }, workspace, store)
    const make = () => new SessionManager({ workspace, store, bus: new Bus(), agentTypes: { resolve: () => ({ name: 'general' }) },
      getLlmRuntimeConfig: () => ({ ...defaults, contextWindow: 400000 }), handoffManager: handoff,
    } as unknown as SessionManagerDeps)
    let manager = make()
    try {
      for (const sessionId of ['web:a', 'web:b']) await store.saveState(sessionId, { sessionId, segmentIndex: 0 })
      await manager.start()
      let app = new Hono(); sessionsApiPlugin(manager)(app)
      const patch = (id: string, body: unknown) => app.request(`/api/sessions/${encodeURIComponent(id)}/config`, { method: 'PATCH', body: JSON.stringify(body) })
      for (const contextWindow of [123456, '256000', false, 262144]) assert.equal((await patch('web:a', { contextWindow })).status, 400)
      assert.equal((await patch('web:a', { contextWindow: 1000000 })).status, 200)
      assert.equal((await manager.getSessionDetails('web:a'))?.context.windowTokens, 1000000)
      assert.equal((await manager.getSessionDetails('web:a'))?.context.handoff?.windowTokens, 1000000)
      assert.equal((await manager.getSessionDetails('web:b'))?.context.windowTokens, 400000)
      assert.equal(manager.getSessionInferenceDefaults('web:a')?.contextWindow, 400000)
      assert.equal(resolveInferenceSettings({ ...defaults, contextWindow: 400000 }, undefined, manager.getSessionConfig('web:a')).contextWindow, 1000000)
      await manager.stop(); manager = make(); await manager.start()
      assert.equal(manager.getSessionConfig('web:a')?.contextWindow, 1000000)
      assert.equal(manager.getSessionConfig('web:b')?.contextWindow, undefined)
      app = new Hono(); sessionsApiPlugin(manager)(app)
      assert.equal((await patch('web:a', { contextWindow: null })).status, 200)
      assert.equal((await manager.getSessionDetails('web:a'))?.context.windowTokens, 400000)
      await manager.stop(); manager = make(); await manager.start()
      assert.equal(manager.getSessionConfig('web:a')?.contextWindow, undefined)
    } finally { await manager.stop(); await handoff.stop(); store.close?.() }
  })
})

test('a shared HandoffManager never mutates its budget for other sessions', () => {
  const manager = new HandoffManager({} as never, 123456, { autoHandoff: true }, '.', {} as never)
  const usage = { promptTokens: 250000, completionTokens: 0, totalTokens: 250000 }
  assert.equal(manager.shouldHandoff(usage, true, 0, 256000), true)
  assert.equal(manager.shouldHandoff(usage, true, 0, 1000000), false)
  assert.equal(manager.shouldHandoff(usage, false, 0, 400000), false)
  assert.equal(manager.getContextPolicy(1000000).windowTokens, 1000000)
  assert.equal(manager.getContextPolicy().windowTokens, 123456)
  assert.equal(manager.shouldHandoff(usage, true, 0, 256000), true)
})
