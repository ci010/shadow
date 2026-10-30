import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { join } from 'node:path'
import { folderFixture } from '../folders/test-fixtures.ts'
import { JsonlSessionStore } from './session-store-jsonl.ts'
import { SqliteSessionStore } from './session-store-sqlite.ts'
import type { SessionManager } from './session-manager.ts'
import type { WorkdirState } from './locality.ts'
import { remoteSessionPlugin } from './remote-session-routes.ts'
import type { Executor } from '../execution/executor.ts'
import type { SessionStore } from './session-store.ts'
import { randomUUID } from 'node:crypto'
import type { NodeInventoryEntry } from '../cluster/node-inventory.ts'

for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  test(`${Store.name}: remote conversation creation checks Main authority and persists only capability references`, async t => {
    const { workspace } = await folderFixture(t)
    const store: SessionStore = new Store(join(workspace, 'sessions'))
    await store.init()
    let created = 0
    let authority = false
    let capability: WorkdirState = { node: 'online', workdir: { online: true } }
    const executor: Executor = {
      execute: () => { throw new Error('Creation must not execute a job') },
      getStatus: async () => null,
      cancel: async () => { throw new Error('Creation must not cancel a job') },
    }

    const sessions: Pick<SessionManager, 'workspace' | 'workdirLookup' | 'remoteExecutor' | 'buildSession'> = {
      workspace, remoteExecutor: executor,
      workdirLookup: ref => ref.nodeId === 'wsl' && ref.workdirId === 'test-dir' ? capability : { node: 'missing' },
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
    const selection = { nodeId: 'wsl', workdirId: 'test-dir' }
    try {
      assert.equal((await request(selection)).status, 401)
      authority = true
      for (const bad of [null, [], {}, { ...selection, nodeId: 'local' }, { ...selection, path: '/etc' },
        { ...selection, displayPathSnapshot: '/home/user' }, { ...selection, workdirId: '' }]) {
        assert.equal((await request(bad)).status, 400)
      }
      capability = { node: 'offline' }
      assert.equal((await request(selection)).status, 409)
      capability = { node: 'online', incompatible: true, workdir: { online: true } }
      assert.equal((await request(selection)).status, 409)
      capability = { node: 'online', workdir: { online: true } }
      assert.equal((await request({ ...selection, nodeId: 'unpaired' })).status, 409)
      assert.equal(created, 0)
      const response = await request(selection)
      assert.equal(response.status, 201)
      const result = await response.json()
      assert.match(result.sessionId, /^web:chat-/)
      assert.equal(result.sessionId, `web:${result.chatId}`)
      assert.deepEqual((await store.getState(result.sessionId))?.workdir, { version: 2, ...selection })
      assert.equal(created, 1)
      assert.equal((await request({ ...selection, extra: 'x'.repeat(4100) })).status, 413)
    } finally { store.close?.() }
  })
}

test('rootless creation requires a live allocation grant and never falls back to an existing workdir', async () => {
  let executed = 0
  let node: NodeInventoryEntry = {
    nodeId: 'child', displayName: 'Old Child', role: 'child', connection: 'connected',
    executionProtocol: 'compatible', support: { operations: [] }, workdirs: [{ version: 2 as const, nodeId: 'child', workdirId: 'arbitrary-folder', displayName: 'Existing folder', online: true, support: { operations: ['filesystem.read','filesystem.write','workdir.git.status','workdir.git.diff','workdir.identity','workdir.process.execute','workdir.process.execute-once','workdir.process.reconcile'] } }],
  }
  const executor: Executor = {
    execute: () => { executed++; throw new Error('Must not execute') },
    getStatus: async () => null, cancel: async () => { throw new Error('Must not cancel') },
  }
  const app = new Hono()
  remoteSessionPlugin({
    authorize: () => true,
    sessions: {
      workspace: process.cwd(), remoteExecutor: executor, workdirLookup: undefined,
      buildSession: async () => { throw new Error('Must not create') },
    },
    managedSessions: { executor, projectId: 'default', inventory: () => ({ version: 1, nodes: [node] }) },
  })(app)
  const request = () => app.request('/api/sessions/remote', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nodeId: 'child', requestId: randomUUID() }),
  })
  const unsupported = await request()
  assert.equal(unsupported.status, 409)
  assert.deepEqual(await unsupported.json(), {
    error: 'managed_sessions_unsupported', message: 'Update the selected node to support managed sessions, then reconnect.', action: 'upgrade_node',
  })
  node = { ...node, connection: 'offline', supportsManagedSessions: true }
  assert.equal((await request()).status, 503)
  node = { ...node, connection: 'revoked' }
  assert.equal((await request()).status, 503)
  node = { ...node, nodeId: 'another' }
  assert.equal((await request()).status, 503)
  assert.equal(executed, 0)
})
