import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, stat, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { withTempWorkspace } from '../testing/workspace.ts'
import { ProjectCatalog } from './catalog.ts'
import { FolderRegistry } from '../folders/registry.ts'
import { DEFAULT_PROJECT_ID, projectPaths } from './contracts.ts'

test('project catalog persists names and transactionally rejects aliases and cross-org folder overlap', async () => {
  await withTempWorkspace(async root => {
    const hostHome = join(root, 'home')
    const folder = join(root, 'folder')
    const child = join(folder, 'child')
    const alias = join(root, 'alias')
    await mkdir(child, { recursive: true })
    await symlink(folder, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const catalog = new ProjectCatalog(hostHome)
    await catalog.init()
    const changes: string[][] = []
    const stop = catalog.observeProjects(() => changes.push(catalog.list().map(project => project.name)))
    const other = await catalog.create('Other')
    assert.deepEqual(changes, [['Default', 'Other']])
    const defaultRegistry = new FolderRegistry(hostHome, { catalog, projectId: DEFAULT_PROJECT_ID })
    const otherRegistry = new FolderRegistry(hostHome, { catalog, projectId: other.id })
    await Promise.all([defaultRegistry.init(), otherRegistry.init()])
    const registered = await defaultRegistry.register(folder)
    assert.equal(registered.projectId, DEFAULT_PROJECT_ID)
    assert.deepEqual(await defaultRegistry.register(alias), registered)
    await assert.rejects(otherRegistry.register(child), /another project/)
    await assert.rejects(otherRegistry.register(alias), /another project/)
    assert.deepEqual(otherRegistry.list(), [])
    assert.equal(otherRegistry.get(registered.id), undefined)
    assert.equal(changes.length, 1, 'Folder writes do not invalidate the project catalog')
    await catalog.rename(other.id, 'Renamed')
    assert.deepEqual(changes[1], ['Default', 'Renamed'])
    stop()
    const reloaded = new ProjectCatalog(hostHome)
    await reloaded.init()
    assert.equal(reloaded.get(other.id)?.name, 'Renamed')
    assert.deepEqual(reloaded.folders(DEFAULT_PROJECT_ID), [registered])
    await assert.rejects(otherRegistry.register(hostHome), /Home/)
    assert.throws(() => projectPaths(root, '../escape'), /Invalid/)
    const second = join(root, 'second')
    await mkdir(second)
    const races = await Promise.allSettled([defaultRegistry.register(second), otherRegistry.register(second)])
    assert.equal(races.filter(result => result.status === 'fulfilled').length, 1)
    assert.equal(races.filter(result => result.status === 'rejected').length, 1)
  })
})

test('protected host and legacy Homes reject canonical and aliased registration and clone destinations', async () => {
  await withTempWorkspace(async root => {
    const host = join(root, 'host-parent', 'home')
    const legacy = join(root, 'legacy-parent', 'home')
    const hostAlias = join(root, 'host-alias')
    const legacyAlias = join(root, 'legacy-alias')
    await mkdir(join(host, 'child'), { recursive: true })
    await mkdir(join(legacy, 'child'), { recursive: true })
    await symlink(host, hostAlias, process.platform === 'win32' ? 'junction' : 'dir')
    await symlink(legacy, legacyAlias, process.platform === 'win32' ? 'junction' : 'dir')
    const catalog = new ProjectCatalog(hostAlias, [legacyAlias])
    await catalog.init()
    const org = await catalog.create('Other')
    for (const path of [host, hostAlias, legacy, legacyAlias, join(root, 'host-parent'), join(root, 'legacy-parent')]) {
      await assert.rejects(catalog.registerFolder(org.id, path), /Home/)
      await assert.rejects(catalog.reserveDestination(org.id, path), /Home/)
    }
    for (const home of [host, hostAlias, legacy, legacyAlias]) {
      await assert.rejects(catalog.registerFolder(org.id, join(home, 'child')), /Home/)
      const destination = join(home, 'new-clone')
      await assert.rejects(catalog.reserveDestination(org.id, destination), /Home/)
      await assert.rejects(stat(destination), { code: 'ENOENT' })
    }
    assert.deepEqual(catalog.folders(org.id), [])
    const unrelated = join(root, 'unrelated')
    await mkdir(unrelated)
    assert.equal((await catalog.registerFolder(org.id, unrelated)).projectId, org.id)
  })
})

test('future protected Homes and clone reservations resolve existing parent aliases', async () => {
  await withTempWorkspace(async root => {
    const parent = join(root, 'actual-parent')
    const alias = join(root, 'alias-parent')
    await mkdir(parent)
    await symlink(parent, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const catalog = new ProjectCatalog(join(root, 'host'), [join(alias, 'future-home')])
    await catalog.init()
    const org = await catalog.create('Other')
    await assert.rejects(catalog.reserveDestination(org.id, join(parent, 'future-home', 'clone')), /Home/)
    await assert.rejects(catalog.registerFolder(org.id, parent), /Home/)
    await assert.rejects(stat(join(parent, 'future-home')), { code: 'ENOENT' })
    const release = await catalog.reserveDestination(DEFAULT_PROJECT_ID, join(alias, 'folder'))
    try {
      await assert.rejects(catalog.reserveDestination(org.id, join(parent, 'folder', 'child')), /another project/)
    } finally { release() }
    const released = await catalog.reserveDestination(org.id, join(parent, 'folder'))
    released()
  })
})
