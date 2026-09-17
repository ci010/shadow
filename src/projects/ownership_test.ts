import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { withTempWorkspace } from '../testing/workspace.ts'
import { safeSessionId } from '../utils/paths.ts'
import { JsonlSessionStore } from '../sessions/session-store-jsonl.ts'
import { SqliteSessionStore } from '../sessions/session-store-sqlite.ts'
import type { SessionStore } from '../sessions/session-store.ts'
import { localFolderWorkdirRef } from '../sessions/locality.ts'
import { FolderRegistry } from '../folders/registry.ts'
import { BotInstanceStore } from '../channels/bot-store.ts'
import { ProjectCatalog } from './catalog.ts'
import { projectPaths } from './contracts.ts'
import { assertSessionProjectOwnership } from './session-ownership.ts'
import { validateOwnership, OwnershipValidationError } from './ownership.ts'

for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  test(`${Store.name}: current ownership is durable, distinct and scope-fenced`, async () => {
    await withTempWorkspace(async root => {
      const dir = join(root, 'sessions')
      let store: SessionStore = new Store(dir)
      try {
        await store.init()
        await store.saveState('web:owned', {
          sessionId: 'web:owned', segmentIndex: 2, projectId: 'owner', folderId: 'directory',
          workdir: localFolderWorkdirRef('directory'), parent: { id: 'web:parent', physicalId: 'older-0', index: 4 },
        })
        await store.saveState('web:scope', { sessionId: 'web:scope', segmentIndex: 0, projectId: 'owner' })
        await assertSessionProjectOwnership(store, 'owner')
        await assert.rejects(assertSessionProjectOwnership(store, 'foreign'), /does not belong/)
        store.close?.()
        store = new Store(dir)
        const state = await store.getState('web:owned')
        assert.equal(state?.projectId, 'owner')
        assert.equal(state.folderId, 'directory')
        assert.equal(state.ownershipVersion, 2)
        assert.deepEqual(state.parent, { id: 'web:parent', physicalId: 'older-0', index: 4 })
        assert.deepEqual(state.workdir, localFolderWorkdirRef('directory'))
        assert.equal((await store.getState('web:scope'))?.folderId, undefined)
        assert.equal((await store.listSessions()).find(item => item.sessionId === 'web:owned')?.folderId, 'directory')
      } finally { store.close?.() }
    })
  })

  test(`${Store.name}: unsupported or invalid ownership cannot become an unowned session`, async () => {
    await withTempWorkspace(async dir => {
      for (const ownership of [
        { ownershipVersion: 3, projectId: 'owner' },
        { ownershipVersion: 1, projectId: 'owner' },
        { folderId: 'directory', projectId: 'owner' },
        { ownershipVersion: 2, projectId: '' },
        { ownershipVersion: 2, folderId: 3 },
      ]) {
        const store: SessionStore = new Store(dir)
        await store.init()
        try {
          const sessionId = 'web:invalid'
          if (Store === JsonlSessionStore) {
            await writeFile(join(dir, `${safeSessionId(sessionId)}.json`),
              JSON.stringify({ sessionId, segmentIndex: 0, ...ownership }))
          } else {
            const db = new DatabaseSync(join(dir, 'sessions.db'))
            try {
              db.prepare('INSERT OR REPLACE INTO session_states (key, segment_count, prototype) VALUES (?, 0, ?)')
                .run(sessionId, JSON.stringify({ version: 1, metadata: ownership }))
            } finally { db.close() }
          }
          await assert.rejects(store.getState(sessionId), OwnershipValidationError)
          await assert.rejects(store.listAllStates(), OwnershipValidationError)
          await assert.rejects(store.listSessions(), OwnershipValidationError)
        } finally { store.close?.() }
      }
    })
  })
}

test('current catalog retains reservations, retirements, jobs and exclusive folder ownership', async () => {
  await withTempWorkspace(async root => {
    const host = join(root, 'host.projects')
    const directory = join(root, 'directory')
    await mkdir(directory)
    const catalog = new ProjectCatalog(host)
    await catalog.init()
    const folder = await catalog.registerFolder('default', directory)
    const other = await catalog.create('Other')
    catalog.recordRemoteJob('default', 'pending-job', true)
    const ref = { version: 1 as const, nodeId: 'child', capabilityId: 'grant' }
    await catalog.reserveRemoteWorkdirs('default', [ref])
    const reload = new ProjectCatalog(host)
    await reload.init()
    assert.equal(reload.filePath, join(host, 'projects.v2.json'))
    assert.deepEqual(reload.folders(), [folder])
    assert.equal(reload.remoteClaims()[0].projectId, 'default')
    await assert.rejects(reload.reserveRemoteWorkdirs(other.id, [ref]), /another project/)
    await assert.rejects(reload.registerFolder(other.id, directory), /another project/)
    await mkdir(join(directory, 'nested'))
    await assert.rejects(reload.registerFolder(other.id, join(directory, 'nested')), /another project/)
    await assert.rejects(reload.changeFolderProject('default', folder.id), { code: 'folder_busy' })
    reload.recordRemoteJob('default', 'pending-job', false)
    await reload.changeFolderProject('default', folder.id)
    assert(reload.isRetiredWorkdir('default', localFolderWorkdirRef(folder.id)))
    const persisted = JSON.parse(await readFile(catalog.filePath, 'utf8'))
    assert.equal(persisted.version, 2)
    assert.equal(persisted.retiredFolders[0].id, folder.id)
    assert.deepEqual(projectPaths(host, 'default'), {
      root: join(host, 'projects', 'default'), home: join(host, 'projects', 'default', 'workspace'),
      configPath: join(host, 'projects', 'default', 'config', 'project.json'),
    })
  })
})

test('unsupported catalog formats and unknown ownership fields fail without overwriting data', async () => {
  await withTempWorkspace(async host => {
    for (const data of [
      { version: 1, projects: [], folders: [] },
      { version: 3, projects: [], folders: [] },
      { version: 2, projects: [], folders: [], unexpectedOwner: 'foreign' },
    ]) {
      const value = JSON.stringify(data)
      const file = join(host, 'projects.v2.json')
      await writeFile(file, value)
      await assert.rejects(new ProjectCatalog(host).init(), /Invalid/)
      assert.equal(await readFile(file, 'utf8'), value)
    }
  })
})

test('folder registries and bot records accept only current documents without converting them', async () => {
  await withTempWorkspace(async root => {
    const folder = { id: randomUUID(), name: 'Directory', path: root, createdAt: new Date().toISOString() }
    const file = join(root, 'folders.v2.json')
    await writeFile(file, JSON.stringify({ version: 1, folders: [folder] }))
    await assert.rejects(new FolderRegistry(root).init(), /invalid/)
    await writeFile(file, JSON.stringify({ version: 2, folders: [folder] }))
    const registry = new FolderRegistry(root)
    await registry.init()
    assert.deepEqual(registry.list(), [folder])
    const path = join(root, 'bots.json')
    const bot = { id: 'bot', projectId: 'owner', platform: 'discord', displayName: 'Bot', config: { enabled: false } }
    await writeFile(path, JSON.stringify({ version: 1, bots: [bot] }))
    assert.throws(() => new BotInstanceStore({ path, projectId: 'owner' }))
    assert.equal(JSON.parse(await readFile(path, 'utf8')).version, 1)
    await writeFile(path, JSON.stringify({ version: 2, bots: [bot] }))
    assert.throws(() => new BotInstanceStore({ path, projectId: 'foreign' }), /ownership/)
    assert.equal(new BotInstanceStore({ path, projectId: 'owner' }).get('bot').projectId, 'owner')
  })
  assert.equal(validateOwnership({ ownershipVersion: 2, projectId: 'owner' }).folderId, undefined)
})
