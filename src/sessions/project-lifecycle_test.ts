import assert from 'node:assert/strict'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { Hono } from 'hono'
import { Bus } from '../bus/bus.ts'
import { WebChannel } from '../channels/web.ts'
import { ProjectCatalog } from '../projects/catalog.ts'
import { FolderRegistry, FolderError } from '../folders/registry.ts'
import { folderFixture } from '../folders/test-fixtures.ts'
import { folderAccessMiddleware } from '../folders/access.ts'
import type { LLMProvider, LLMResponse } from '../providers/provider.ts'
import { Tools } from '../tools/registry.ts'
import { SessionManager, type SessionManagerDeps } from './session-manager.ts'
import { JsonlSessionStore } from './session-store-jsonl.ts'
import { SqliteSessionStore } from './session-store-sqlite.ts'
import { localFolderWorkdirRef, type WorkdirRefV2 } from './locality.ts'
import { sessionsApiPlugin } from './routes.ts'
import type { SessionMessageInput } from './input.ts'
import type { SessionState, SessionStore } from './session-store.ts'

const input = (id: string): SessionMessageInput => ({
  id, kind: 'message', content: 'Fixture', timestamp: new Date().toISOString(), policy: 'queue',
  source: { kind: 'event', eventId: id, type: 'fixture', source: 'system' },
})

for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  test(`${Store.name}: folder dependents lose access but independent managed topics retain their directory`, async t => {
    const { root, workspace, folders } = await folderFixture(t)
    const catalog = new ProjectCatalog(join(root, 'host'))
    await catalog.init()
    const target = await catalog.create('Target')
    const registry = new FolderRegistry(workspace, { catalog, projectId: 'default' })
    await registry.init()
    const folder = await registry.register(folders)
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
      projectId: 'default', workspace, store, bus, provider, tools: new Tools(workspace),
      ownsFolder: (id: string) => !!registry.get(id), ownsWorkdir: () => true,
      assertSessionFolder: (state: SessionState) => registry.assertSessionFolder(state),
      acquireFolderAccess: () => registry.acquireAccess(),
      workdirLookup: (ref: WorkdirRefV2) => registry.lookupWorkdir(ref) ?? { node: 'online' },
      getLlmRuntimeConfig: () => llm,
      handoffManager: { shouldHandoff: () => false },
      context: { buildSystemPrompt: async () => 'Project fixture context' },
      agentTypes: { resolve: () => ({ name: 'fixture', prompt: '', description: '', defaultMode: 'session' }) },
    } as unknown as SessionManagerDeps)
    let sessions = create()
    await sessions.start()
    let invalidated = 0
    const unregister = catalog.configureFolderLifecycle('default', {
      assertIdle: () => { if (sessions.hasFolderWork) throw new FolderError('folder_busy', 'Busy', 409) },
      invalidate: () => { invalidated++; sessions.invalidateFolderSessions() },
      sessionsToRetire: folder => sessions.folderDependentSessions(folder.id, [localFolderWorkdirRef(folder.id)]),
    })
    const channel = new WebChannel(bus, { workspace, sessionManager: sessions })
    try {
      await sessions.buildSession('web:root', undefined, { folderId: folder.id, workdir: localFolderWorkdirRef(folder.id) })
      await sessions.buildSession('web:child', { id: 'web:root' })
      await sessions.buildSession('web:workspace-child', undefined, { workspaceRoot: 'web:root' })
      await sessions.buildSession('web:scratch')
      const admission = sessions.deliver('web:root', input('first'))
      await assert.rejects(registry.changeProject(folder.id, target.id), { code: 'folder_busy' })
      await admission
      await called.promise
      await sessions.deliver('web:root', input('queued'))
      await assert.rejects(registry.changeProject(folder.id), { code: 'folder_busy' })
      answer.resolve({ content: 'Finished', toolCalls: [] })
      const until = Date.now() + 5000
      while (sessions.hasFolderWork) {
        assert(Date.now() < until, 'session did not become idle')
        await delay(1)
      }
      assert(sessions.getActiveSession('web:root'))
      const history = async () => JSON.parse(JSON.stringify((await sessions.getHistory('web:root')).messages.filter(message => message.role !== 'system')))
      const historyBefore = await history()
      const stateBefore = await store.getState('web:root')
      const records = () => Array.fromAsync(store.readSessionLog(SessionManager.currentPhysicalId(stateBefore!)))
      const persistedBefore = await records()
      const moved = await registry.changeProject(folder.id, target.id)
      assert(moved)
      assert.equal(invalidated, 1)
      for (const id of ['web:root', 'web:child']) {
        assert.throws(() => sessions.assertFolderAccess(id), { code: 'folder_access_revoked' })
        await assert.rejects(sessions.deliver(id, input(`revoked-${id}`)), { code: 'folder_access_revoked' })
      }
      await assert.rejects(sessions.buildSession('web:new-child', { id: 'web:root' }), { code: 'folder_access_revoked' })
      sessions.assertFolderAccess('web:scratch')
      sessions.assertFolderAccess('web:workspace-child')
      assert.deepEqual(await history(), historyBefore)
      assert.deepEqual(await records(), persistedBefore)
      assert.deepEqual(await store.getState('web:root'), stateBefore)
      const app = new Hono()
      app.use('*', folderAccessMiddleware(registry))
      sessionsApiPlugin(sessions)(app)
      await channel.start(app)
      for (const operation of ['files', 'preview', 'raw', 'git/status', 'context']) {
        const response = await app.request(`/api/sessions/web%3Aroot/${operation}`)
        assert.equal(response.status, 409, operation)
        assert.equal((await response.json()).error, 'folder_access_revoked')
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
      assert.throws(() => sessions.assertFolderAccess('web:root'), { code: 'folder_access_revoked' })
      sessions.assertFolderAccess('web:workspace-child')
      assert.deepEqual(await history(), historyBefore)
      assert.deepEqual(await records(), persistedBefore)
      const returned = await catalog.changeFolderProject(target.id, moved.id, 'default')
      assert(returned)
      await sessions.buildSession('web:fresh', undefined, { folderId: returned.id, workdir: localFolderWorkdirRef(returned.id) })
      sessions.assertFolderAccess('web:fresh')
      assert.throws(() => sessions.assertFolderAccess('web:root'), { code: 'folder_access_revoked' })
      await sessions.deleteSession('web:root')
      sessions.assertFolderAccess('web:workspace-child')
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
