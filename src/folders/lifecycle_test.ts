import assert from 'node:assert/strict'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { Hono } from 'hono'
import { ProjectCatalog } from '../projects/catalog.ts'
import { FolderError, FolderRegistry } from './registry.ts'
import { folderFixture } from './test-fixtures.ts'
import { FolderService } from './routes.ts'
import { folderAccessMiddleware } from './access.ts'

test('folder lifecycle is membership-only and creates fresh identities across restarts', async t => {
  const { root, folders, workspace } = await folderFixture(t)
  const file = join(folders, 'kept.txt')
  await writeFile(file, 'original bytes')
  const catalog = new ProjectCatalog(join(root, 'host'))
  await catalog.init()
  const target = await catalog.create('Target')
  const registry = new FolderRegistry(workspace, { catalog, projectId: 'default' })
  await registry.init()
  const original = await registry.register(folders)
  const service = new FolderService({ registry, createSession: async () => { throw new Error('No chat creation') } })
  const app = new Hono()
  app.use('*', folderAccessMiddleware(registry))
  service.plugin(app)
  const move = (body: unknown) => app.request(`/api/folders/${original.id}/move`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  for (const body of [{}, { targetProjectId: 3 }, { targetProjectId: target.id, path: folders }, []]) {
    assert.equal((await move(body)).status, 400)
  }
  assert.equal((await move({ targetProjectId: 'default' })).status, 409)
  assert.equal((await move({ targetProjectId: 'missing' })).status, 404)
  const response = await move({ targetProjectId: target.id })
  assert.equal(response.status, 200, await response.clone().text())
  const moved = (await response.json()).folder
  assert.notEqual(moved.id, original.id)
  assert.equal(moved.projectId, target.id)
  assert.equal(moved.path, original.path)
  assert.equal(registry.get(original.id), undefined)
  assert.throws(() => registry.assertSessionFolder({ folderId: original.id }), { code: 'folder_access_revoked' })
  assert.equal((await app.request(`/api/folders/${original.id}/files`)).status, 404)
  const reloaded = new ProjectCatalog(join(root, 'host'))
  await reloaded.init()
  assert.deepEqual(reloaded.folders('default'), [])
  const returned = await reloaded.changeFolderProject(target.id, moved.id, 'default')
  assert(returned)
  assert.notEqual(returned.id, original.id)
  assert.notEqual(returned.id, moved.id)
  await reloaded.changeFolderProject('default', returned.id)
  assert.deepEqual(reloaded.folders(), [])
  const final = new ProjectCatalog(join(root, 'host'))
  await final.init()
  assert.deepEqual(final.folders(), [])
  assert.equal(await readFile(file, 'utf8'), 'original bytes')
  await service.dispose()
})

test('membership commits fail atomically on busy work, reservations, overlap, abort and persistence errors', async t => {
  const { root, folders } = await folderFixture(t)
  const catalog = new ProjectCatalog(join(root, 'host'))
  await catalog.init()
  const target = await catalog.create('Target')
  const folder = await catalog.registerFolder('default', folders)
  const before = await readFile(catalog.filePath, 'utf8')
  const release = catalog.acquireFolderAccess('default')
  await assert.rejects(catalog.changeFolderProject('default', folder.id, target.id), { code: 'folder_busy' })
  release()
  let busy = true
  let invalidated = 0
  const unregister = catalog.configureFolderLifecycle('default', {
    assertIdle: () => { if (busy) throw new FolderError('folder_busy', 'Busy', 409) },
    invalidate: () => { invalidated++ },
  })
  await assert.rejects(catalog.changeFolderProject('default', folder.id), { code: 'folder_busy' })
  busy = false
  const releaseClone = await catalog.reserveDestination('default', join(folders, 'clone'))
  await assert.rejects(catalog.changeFolderProject('default', folder.id), { code: 'folder_busy' })
  releaseClone()
  await assert.rejects(catalog.changeFolderProject('default', folder.id, target.id, AbortSignal.abort()), { name: 'AbortError' })
  assert.equal(await readFile(catalog.filePath, 'utf8'), before)
  const backup = `${catalog.filePath}.backup`
  await rename(catalog.filePath, backup)
  await mkdir(catalog.filePath)
  try {
    await assert.rejects(catalog.changeFolderProject('default', folder.id, target.id))
    assert.deepEqual(catalog.folders(), [folder])
    assert.equal(invalidated, 0)
  } finally {
    await rm(catalog.filePath, { recursive: true })
    await rename(backup, catalog.filePath)
  }
  const child = join(folders, 'nested')
  await mkdir(child)
  await catalog.registerFolder('default', child)
  await assert.rejects(catalog.changeFolderProject('default', folder.id, target.id), { code: 'folder_overlap_conflict' })
  await catalog.changeFolderProject('default', folder.id)
  assert.deepEqual(catalog.folders('default').map(item => item.path), [child])
  unregister()
})

test('raw responses hold the ownership lease through consumption, while DELETE itself is not leased', async t => {
  const { root, workspace, folders } = await folderFixture(t)
  const catalog = new ProjectCatalog(join(root, 'host'))
  await catalog.init()
  const registry = new FolderRegistry(workspace, { catalog, projectId: 'default' })
  await registry.init()
  const folder = await registry.register(folders)
  await writeFile(join(folders, 'kept.txt'), 'kept')
  const app = new Hono()
  app.use('*', folderAccessMiddleware(registry))
  const service = new FolderService({ registry, createSession: async () => { throw new Error('Unused') } })
  service.plugin(app)
  const stream = await app.request(`/api/folders/${folder.id}/raw?path=kept.txt`)
  assert.equal(stream.status, 200)
  const blocked = await app.request(`/api/folders/${folder.id}`, { method: 'DELETE' })
  assert.equal(blocked.status, 409)
  assert.equal((await blocked.json()).error, 'folder_busy')
  assert.equal(await stream.text(), 'kept')
  const removed = await app.request(`/api/folders/${folder.id}`, { method: 'DELETE' })
  assert.equal(removed.status, 200)
  assert.deepEqual(await removed.json(), { removed: true, folderId: folder.id })
  assert.equal(await readFile(join(folders, 'kept.txt'), 'utf8'), 'kept')
  assert.equal((await app.request(`/api/folders/${folder.id}`, { method: 'DELETE' })).status, 404)
  await service.dispose()
})

test('unsettled remote work remains a mutation blocker after a host restart', async t => {
  const { root, folders } = await folderFixture(t)
  const home = join(root, 'host')
  const catalog = new ProjectCatalog(home)
  await catalog.init()
  const folder = await catalog.registerFolder('default', folders)
  catalog.recordRemoteJob('default', 'unconfirmed', true)
  const restarted = new ProjectCatalog(home)
  await restarted.init()
  await assert.rejects(restarted.changeFolderProject('default', folder.id), { code: 'folder_busy' })
  restarted.recordRemoteJob('default', 'unconfirmed', false)
  await restarted.changeFolderProject('default', folder.id)
  assert.deepEqual(restarted.folders(), [])
})

test('Home cannot be registered as a folder', async t => {
  const { root } = await folderFixture(t)
  const home = join(root, 'host')
  const catalog = new ProjectCatalog(home)
  await catalog.init()
  await assert.rejects(catalog.registerFolder('default', home), { code: 'folder_overlaps_home' })
  assert.deepEqual(catalog.folders(), [])
})

for (const removeParentFirst of [true, false]) {
  test(`overlapping folder registrations can be removed ${removeParentFirst ? 'parent' : 'child'} first through DELETE`, async t => {
    const { root, workspace, folders } = await folderFixture(t)
    const childPath = join(folders, 'nested')
    await mkdir(childPath)
    const file = join(childPath, 'kept.txt')
    await writeFile(file, 'original bytes')
    const home = join(root, 'host')
    const catalog = new ProjectCatalog(home)
    await catalog.init()
    const registry = new FolderRegistry(workspace, { catalog, projectId: 'default' })
    await registry.init()
    const parent = await registry.register(folders)
    const child = await registry.register(childPath)
    const app = new Hono()
    app.use('*', folderAccessMiddleware(registry))
    const service = new FolderService({ registry, createSession: async () => { throw new Error('Unused') } })
    service.plugin(app)
    t.after(() => service.dispose())
    const [first, second] = removeParentFirst ? [parent, child] : [child, parent]
    const removed = await app.request(`/api/folders/${first.id}`, { method: 'DELETE' })
    assert.equal(removed.status, 200, await removed.clone().text())
    assert.equal(registry.get(first.id), undefined)
    assert.equal(registry.get(second.id)?.id, second.id)
    const restarted = new ProjectCatalog(home)
    await restarted.init()
    assert.deepEqual(restarted.folders('default').map(item => item.id), [second.id])
    const last = await app.request(`/api/folders/${second.id}`, { method: 'DELETE' })
    assert.equal(last.status, 200, await last.clone().text())
    const final = new ProjectCatalog(home)
    await final.init()
    assert.deepEqual(final.folders('default'), [])
    assert.equal(await readFile(file, 'utf8'), 'original bytes')
  })
}
