import assert from 'node:assert/strict'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { Hono } from 'hono'
import { Bus } from '../bus/bus.ts'
import { WebChannel } from '../channels/web.ts'
import { OrganizationCatalog } from '../organizations/catalog.ts'
import { ProjectRegistry, ProjectError } from '../projects/registry.ts'
import { projectFixture } from '../projects/test-fixtures.ts'
import { projectAccessMiddleware } from '../projects/access.ts'
import type { LLMProvider, LLMResponse } from '../providers/provider.ts'
import { Tools } from '../tools/registry.ts'
import { SessionManager, type SessionManagerDeps } from './session-manager.ts'
import { JsonlSessionStore } from './session-store-jsonl.ts'
import { SqliteSessionStore } from './session-store-sqlite.ts'
import { localProjectWorkdirRef, type WorkdirRefV1 } from './locality.ts'
import { sessionsApiPlugin } from './routes.ts'
import type { SessionMessageInput } from './input.ts'
import type { SessionState, SessionStore } from './session-store.ts'

const input = (id: string): SessionMessageInput => ({
  id, kind: 'message', content: 'Fixture', timestamp: new Date().toISOString(), policy: 'queue',
  source: { kind: 'event', eventId: id, type: 'fixture', source: 'system' },
})

for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  test(`${Store.name}: busy admission is rejected, idle history moves, descendants and cached sessions lose access after restart`, async t => {
    const { root, workspace, folders } = await projectFixture(t)
    const catalog = new OrganizationCatalog(join(root, 'host'))
    await catalog.init()
    const target = await catalog.create('Target')
    const registry = new ProjectRegistry(workspace, { catalog, organizationId: 'default' })
    await registry.init()
    const project = await registry.register(folders)
    const bus = new Bus()
    const called = Promise.withResolvers<void>()
    const answer = Promise.withResolvers<LLMResponse>()
    const provider: LLMProvider = {
      name: 'fixture', listModels: () => ['fixture'],
      chat: async () => { called.resolve(); return answer.promise },
    }
    const llm = { model: 'fixture', contextWindow: 100000, temperature: 0 }
    let store: SessionStore = new Store(join(workspace, '.sessions'))
    await store.init()
    const create = () => new SessionManager({
      organizationId: 'default', workspace, store, bus, provider, tools: new Tools(workspace),
      ownsProject: (id: string) => !!registry.get(id), ownsWorkdir: () => true,
      assertSessionProject: (state: SessionState) => registry.assertSessionProject(state),
      acquireProjectAccess: () => registry.acquireAccess(),
      workdirCapabilityLookup: (ref: WorkdirRefV1) => registry.lookupWorkdir(ref) ?? { node: 'online' },
      getLlmRuntimeConfig: () => llm,
      handoffManager: { shouldHandoff: () => false },
      context: { buildSystemPrompt: async () => 'Organization fixture context' },
      agentTypes: { resolve: () => ({ name: 'fixture', prompt: '', description: '', defaultMode: 'session' }) },
    } as unknown as SessionManagerDeps)
    let sessions = create()
    await sessions.start()
    let invalidated = 0
    const unregister = catalog.configureProjectLifecycle('default', {
      assertIdle: () => { if (sessions.hasProjectWork) throw new ProjectError('project_busy', 'Busy', 409) },
      invalidate: () => { invalidated++; sessions.invalidateProjectSessions() },
      sessionsToRetire: project => sessions.projectDependentSessions(project.id, [localProjectWorkdirRef(project.id)]),
    })
    const channel = new WebChannel(bus, { workspace, sessionManager: sessions })
    try {
      await sessions.buildSession('web:root', undefined, { projectId: project.id, workdir: localProjectWorkdirRef(project.id) })
      await sessions.buildSession('web:child', { id: 'web:root' })
      await sessions.buildSession('web:workspace-child', undefined, { workspaceRoot: 'web:root' })
      await sessions.buildSession('web:scratch')
      const admission = sessions.deliver('web:root', input('first'))
      await assert.rejects(registry.changeOrganization(project.id, target.id), { code: 'project_busy' })
      await admission
      await called.promise
      await sessions.deliver('web:root', input('queued'))
      await assert.rejects(registry.changeOrganization(project.id), { code: 'project_busy' })
      answer.resolve({ content: 'Finished', toolCalls: [] })
      const until = Date.now() + 5000
      while (sessions.hasProjectWork) {
        assert(Date.now() < until, 'session did not become idle')
        await delay(1)
      }
      assert(sessions.getActiveSession('web:root'))
      const history = async () => JSON.parse(JSON.stringify((await sessions.getHistory('web:root')).messages.filter(message => message.role !== 'system')))
      const historyBefore = await history()
      const stateBefore = await store.getState('web:root')
      const records = () => Array.fromAsync(store.readSessionLog(SessionManager.currentPhysicalId(stateBefore!)))
      const persistedBefore = await records()
      const moved = await registry.changeOrganization(project.id, target.id)
      assert(moved)
      assert.equal(invalidated, 1)
      for (const id of ['web:root', 'web:child', 'web:workspace-child']) {
        assert.throws(() => sessions.assertProjectAccess(id), { code: 'project_access_revoked' })
        await assert.rejects(sessions.deliver(id, input(`revoked-${id}`)), { code: 'project_access_revoked' })
      }
      await assert.rejects(sessions.buildSession('web:new-child', { id: 'web:root' }), { code: 'project_access_revoked' })
      sessions.assertProjectAccess('web:scratch')
      assert.deepEqual(await history(), historyBefore)
      assert.deepEqual(await records(), persistedBefore)
      assert.deepEqual(await store.getState('web:root'), stateBefore)
      const app = new Hono()
      app.use('*', projectAccessMiddleware(registry))
      sessionsApiPlugin(sessions)(app)
      await channel.start(app)
      for (const operation of ['files', 'preview', 'raw', 'git/status', 'context']) {
        const response = await app.request(`/api/sessions/web%3Aroot/${operation}`)
        assert.equal(response.status, 409, operation)
        assert.equal((await response.json()).error, 'project_access_revoked')
      }
      assert.equal((await app.request('/api/sessions/web%3Aroot')).status, 200)
      assert.equal((await app.request('/api/media?chatId=root&path=image.png')).status, 409)
      for (const content of ['Continue', '/compact']) {
        const response = await app.request('/api/chat/send', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chatId: 'root', content, stream: false }) })
        assert.equal(response.status, 409)
      }
      await channel.stop()
      await sessions.stop()
      await store.close?.()
      store = new Store(join(workspace, '.sessions'))
      await store.init()
      sessions = create()
      await sessions.start()
      assert.throws(() => sessions.assertProjectAccess('web:root'), { code: 'project_access_revoked' })
      assert.throws(() => sessions.assertProjectAccess('web:workspace-child'), { code: 'project_access_revoked' })
      assert.deepEqual(await history(), historyBefore)
      assert.deepEqual(await records(), persistedBefore)
      const returned = await catalog.changeProjectOrganization(target.id, moved.id, 'default')
      assert(returned)
      await sessions.buildSession('web:fresh', undefined, { projectId: returned.id, workdir: localProjectWorkdirRef(returned.id) })
      sessions.assertProjectAccess('web:fresh')
      assert.throws(() => sessions.assertProjectAccess('web:root'), { code: 'project_access_revoked' })
      await sessions.deleteSession('web:root')
      assert.throws(() => sessions.assertProjectAccess('web:workspace-child'), { code: 'project_access_revoked' })
    } finally {
      answer.resolve({ content: 'Cleanup', toolCalls: [] })
      unregister()
      await channel.stop()
      await sessions.stop()
      await store.close?.()
      bus.stopAll()
    }
  })
}
