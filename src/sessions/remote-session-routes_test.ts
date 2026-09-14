import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { join } from 'node:path'
import { projectFixture } from '../projects/test-fixtures.ts'
import { JsonlSessionStore } from './session-store-jsonl.ts'
import { SqliteSessionStore } from './session-store-sqlite.ts'
import type { SessionManager } from './session-manager.ts'
import type { WorkdirCapabilityState } from './locality.ts'
import { remoteSessionPlugin } from './remote-session-routes.ts'
import type { Executor } from '../execution/executor.ts'
import type { SessionStore } from './session-store.ts'

for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  test(`${Store.name}: remote conversation creation checks Main authority and persists only capability references`, async t => {
    const { workspace } = await projectFixture(t)
    const store: SessionStore = new Store(join(workspace, 'sessions'))
    await store.init()
    let created = 0
    let authority = false
    let capability: WorkdirCapabilityState = { node: 'online', capability: { kind: 'workdir', online: true } }
    const executor: Executor = {
      execute: () => { throw new Error('Creation must not execute a job') },
      getStatus: async () => null,
      cancel: async () => { throw new Error('Creation must not cancel a job') },
    }
    const sessions: Pick<SessionManager, 'workspace' | 'workdirCapabilityLookup' | 'remoteExecutor' | 'buildSession'> = {
      workspace, remoteExecutor: executor,
      workdirCapabilityLookup: ref => ref.nodeId === 'wsl' && ref.capabilityId === 'test-dir' ? capability : { node: 'missing' },
      buildSession: async (sessionId, _parent, fields) => {
        created++
        await store.saveState(sessionId, { sessionId, segmentIndex: 0, mode: fields?.mode, workdir: fields?.workdir })
      },
    }
    const app = new Hono()
    remoteSessionPlugin({ sessions, authorize: () => authority })(app)
    const request = (body: unknown) => app.request('/api/sessions/remote', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    const selection = { nodeId: 'wsl', capabilityId: 'test-dir' }
    try {
      assert.equal((await request(selection)).status, 401)
      authority = true
      for (const bad of [null, [], {}, { ...selection, nodeId: 'local' }, { ...selection, path: '/etc' },
        { ...selection, displayPathSnapshot: '/home/user' }, { ...selection, capabilityId: '' }]) {
        assert.equal((await request(bad)).status, 400)
      }
      capability = { node: 'offline' }
      assert.equal((await request(selection)).status, 409)
      capability = { node: 'online', capability: { kind: 'shell', online: true } }
      assert.equal((await request(selection)).status, 409)
      capability = { node: 'online', capability: { kind: 'workdir', online: true } }
      assert.equal((await request({ ...selection, nodeId: 'unpaired' })).status, 409)
      assert.equal(created, 0)
      const response = await request(selection)
      assert.equal(response.status, 201)
      const result = await response.json()
      assert.match(result.sessionId, /^web:chat-/)
      assert.equal(result.sessionId, `web:${result.chatId}`)
      assert.deepEqual((await store.getState(result.sessionId))?.workdir, { version: 1, ...selection })
      assert.equal(created, 1)
      assert.equal((await request({ ...selection, extra: 'x'.repeat(4100) })).status, 413)
    } finally { store.close?.() }
  })
}
