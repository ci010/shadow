import assert from 'node:assert/strict'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { Hono } from 'hono'
import { OrganizationCatalog } from '../organizations/catalog.ts'
import { ProjectError, ProjectRegistry } from './registry.ts'
import { projectFixture } from './test-fixtures.ts'
import { ProjectService } from './routes.ts'
import { projectAccessMiddleware } from './access.ts'

test('folder lifecycle is membership-only, creates fresh identities, and cannot resurrect from legacy imports', async t => {
  const { root, folders, workspace } = await projectFixture(t)
  const file = join(folders, 'kept.txt')
  await writeFile(file, 'original bytes')
  const catalog = new OrganizationCatalog(join(root, 'host'))
  await catalog.init()
  const target = await catalog.create('Target')
  const registry = new ProjectRegistry(workspace, { catalog, organizationId: 'default' })
  await registry.init()
  const original = await registry.register(folders)
  const service = new ProjectService({ registry, createSession: async () => { throw new Error('No chat creation') } })
  const app = new Hono()
  app.use('*', projectAccessMiddleware(registry))
  service.plugin(app)
  const move = (body: unknown) => app.request(`/api/projects/${original.id}/move`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  for (const body of [{}, { targetOrganizationId: 3 }, { targetOrganizationId: target.id, path: folders }, []]) {
    assert.equal((await move(body)).status, 400)
  }
  assert.equal((await move({ targetOrganizationId: 'default' })).status, 409)
  assert.equal((await move({ targetOrganizationId: 'missing' })).status, 404)
  const response = await move({ targetOrganizationId: target.id })
  assert.equal(response.status, 200, await response.clone().text())
  const moved = (await response.json()).project
  assert.notEqual(moved.id, original.id)
  assert.equal(moved.organizationId, target.id)
  assert.equal(moved.path, original.path)
  assert.equal(registry.get(original.id), undefined)
  assert.throws(() => registry.assertSessionProject({ projectId: original.id }), { code: 'project_access_revoked' })
  assert.equal((await app.request(`/api/projects/${original.id}/files`)).status, 404)
  const reloaded = new OrganizationCatalog(join(root, 'host'))
  await reloaded.init()
  await reloaded.importProjects('default', [original])
  assert.deepEqual(reloaded.projects('default'), [])
  const returned = await reloaded.changeProjectOrganization(target.id, moved.id, 'default')
  assert(returned)
  assert.notEqual(returned.id, original.id)
  assert.notEqual(returned.id, moved.id)
  await reloaded.changeProjectOrganization('default', returned.id)
  await reloaded.importProjects('default', [original])
  assert.deepEqual(reloaded.projects(), [])
  const final = new OrganizationCatalog(join(root, 'host'))
  await final.init()
  await final.importProjects('default', [original])
  assert.deepEqual(final.projects(), [])
  assert.equal(await readFile(file, 'utf8'), 'original bytes')
  await service.dispose()
})

test('membership commits fail atomically on busy work, reservations, overlap, abort and persistence errors', async t => {
  const { root, folders } = await projectFixture(t)
  const catalog = new OrganizationCatalog(join(root, 'host'))
  await catalog.init()
  const target = await catalog.create('Target')
  const project = await catalog.registerProject('default', folders)
  const before = await readFile(catalog.filePath, 'utf8')
  const release = catalog.acquireProjectAccess('default')
  await assert.rejects(catalog.changeProjectOrganization('default', project.id, target.id), { code: 'project_busy' })
  release()
  let busy = true
  let invalidated = 0
  const unregister = catalog.configureProjectLifecycle('default', {
    assertIdle: () => { if (busy) throw new ProjectError('project_busy', 'Busy', 409) },
    invalidate: () => { invalidated++ },
  })
  await assert.rejects(catalog.changeProjectOrganization('default', project.id), { code: 'project_busy' })
  busy = false
  const releaseClone = await catalog.reserveDestination('default', join(folders, 'clone'))
  await assert.rejects(catalog.changeProjectOrganization('default', project.id), { code: 'project_busy' })
  releaseClone()
  await assert.rejects(catalog.changeProjectOrganization('default', project.id, target.id, AbortSignal.abort()), { name: 'AbortError' })
  assert.equal(await readFile(catalog.filePath, 'utf8'), before)
  const backup = `${catalog.filePath}.backup`
  await rename(catalog.filePath, backup)
  await mkdir(catalog.filePath)
  try {
    await assert.rejects(catalog.changeProjectOrganization('default', project.id, target.id))
    assert.deepEqual(catalog.projects(), [project])
    assert.equal(invalidated, 0)
  } finally {
    await rm(catalog.filePath, { recursive: true })
    await rename(backup, catalog.filePath)
  }
  const child = join(folders, 'nested')
  await mkdir(child)
  await catalog.registerProject('default', child)
  await assert.rejects(catalog.changeProjectOrganization('default', project.id, target.id), { code: 'project_overlap_conflict' })
  await assert.rejects(catalog.changeProjectOrganization('default', project.id), { code: 'project_overlap_conflict' })
  unregister()
})

test('raw responses hold the ownership lease through consumption, while DELETE itself is not leased', async t => {
  const { root, workspace, folders } = await projectFixture(t)
  const catalog = new OrganizationCatalog(join(root, 'host'))
  await catalog.init()
  const registry = new ProjectRegistry(workspace, { catalog, organizationId: 'default' })
  await registry.init()
  const project = await registry.register(folders)
  await writeFile(join(folders, 'kept.txt'), 'kept')
  const app = new Hono()
  app.use('*', projectAccessMiddleware(registry))
  const service = new ProjectService({ registry, createSession: async () => { throw new Error('Unused') } })
  service.plugin(app)
  const stream = await app.request(`/api/projects/${project.id}/raw?path=kept.txt`)
  assert.equal(stream.status, 200)
  const blocked = await app.request(`/api/projects/${project.id}`, { method: 'DELETE' })
  assert.equal(blocked.status, 409)
  assert.equal((await blocked.json()).error, 'project_busy')
  assert.equal(await stream.text(), 'kept')
  const removed = await app.request(`/api/projects/${project.id}`, { method: 'DELETE' })
  assert.equal(removed.status, 200)
  assert.deepEqual(await removed.json(), { removed: true, projectId: project.id })
  assert.equal(await readFile(join(folders, 'kept.txt'), 'utf8'), 'kept')
  assert.equal((await app.request(`/api/projects/${project.id}`, { method: 'DELETE' })).status, 404)
  await service.dispose()
})

test('unsettled remote work remains a mutation blocker after a host restart', async t => {
  const { root, folders } = await projectFixture(t)
  const home = join(root, 'host')
  const catalog = new OrganizationCatalog(home)
  await catalog.init()
  const project = await catalog.registerProject('default', folders)
  catalog.recordRemoteJob('default', 'unconfirmed', true)
  const restarted = new OrganizationCatalog(home)
  await restarted.init()
  await assert.rejects(restarted.changeProjectOrganization('default', project.id), { code: 'project_busy' })
  restarted.recordRemoteJob('default', 'unconfirmed', false)
  await restarted.changeProjectOrganization('default', project.id)
  assert.deepEqual(restarted.projects(), [])
})

test('legacy Home registrations cannot be moved or removed as folder projects', async t => {
  const { root } = await projectFixture(t)
  const home = join(root, 'host')
  const catalog = new OrganizationCatalog(home)
  await catalog.init()
  const target = await catalog.create('Target')
  const legacy = { id: crypto.randomUUID(), name: 'Old Home', path: home, createdAt: new Date().toISOString() }
  await catalog.importProjects('default', [legacy])
  for (const targetId of [undefined, target.id]) {
    await assert.rejects(catalog.changeProjectOrganization('default', legacy.id, targetId), { code: 'folder_overlaps_home' })
  }
  assert.equal(catalog.projects()[0].id, legacy.id)
})
