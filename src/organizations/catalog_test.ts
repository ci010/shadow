import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, stat, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { withTempWorkspace } from '../testing/workspace.ts'
import { OrganizationCatalog } from './catalog.ts'
import { ProjectRegistry } from '../projects/registry.ts'
import { DEFAULT_ORGANIZATION_ID, organizationPaths } from './contracts.ts'

test('organization catalog persists names and transactionally rejects aliases and cross-org folder overlap', async () => {
  await withTempWorkspace(async root => {
    const hostHome = join(root, 'home')
    const folder = join(root, 'project')
    const child = join(folder, 'child')
    const alias = join(root, 'alias')
    await mkdir(child, { recursive: true })
    await symlink(folder, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const catalog = new OrganizationCatalog(hostHome)
    await catalog.init()
    const other = await catalog.create('Other')
    const defaultRegistry = new ProjectRegistry(hostHome, { catalog, organizationId: DEFAULT_ORGANIZATION_ID })
    const otherRegistry = new ProjectRegistry(hostHome, { catalog, organizationId: other.id })
    await Promise.all([defaultRegistry.init(), otherRegistry.init()])
    const project = await defaultRegistry.register(folder)
    assert.equal(project.organizationId, DEFAULT_ORGANIZATION_ID)
    assert.deepEqual(await defaultRegistry.register(alias), project)
    await assert.rejects(otherRegistry.register(child), /another organization/)
    await assert.rejects(otherRegistry.register(alias), /another organization/)
    assert.deepEqual(otherRegistry.list(), [])
    assert.equal(otherRegistry.get(project.id), undefined)
    await catalog.rename(other.id, 'Renamed')
    const reloaded = new OrganizationCatalog(hostHome)
    await reloaded.init()
    assert.equal(reloaded.get(other.id)?.name, 'Renamed')
    assert.deepEqual(reloaded.projects(DEFAULT_ORGANIZATION_ID), [project])
    await assert.rejects(otherRegistry.register(hostHome), /Home/)
    assert.throws(() => organizationPaths(root, '../escape'), /Invalid/)
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
    const catalog = new OrganizationCatalog(hostAlias, [legacyAlias])
    await catalog.init()
    const org = await catalog.create('Other')
    for (const path of [host, hostAlias, legacy, legacyAlias, join(root, 'host-parent'), join(root, 'legacy-parent')]) {
      await assert.rejects(catalog.registerProject(org.id, path), /Home/)
      await assert.rejects(catalog.reserveDestination(org.id, path), /Home/)
    }
    for (const home of [host, hostAlias, legacy, legacyAlias]) {
      await assert.rejects(catalog.registerProject(org.id, join(home, 'child')), /Home/)
      const destination = join(home, 'new-clone')
      await assert.rejects(catalog.reserveDestination(org.id, destination), /Home/)
      await assert.rejects(stat(destination), { code: 'ENOENT' })
    }
    assert.deepEqual(catalog.projects(org.id), [])
    const unrelated = join(root, 'unrelated')
    await mkdir(unrelated)
    assert.equal((await catalog.registerProject(org.id, unrelated)).organizationId, org.id)
  })
})

test('future protected Homes and clone reservations resolve existing parent aliases', async () => {
  await withTempWorkspace(async root => {
    const parent = join(root, 'actual-parent')
    const alias = join(root, 'alias-parent')
    await mkdir(parent)
    await symlink(parent, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const catalog = new OrganizationCatalog(join(root, 'host'), [join(alias, 'future-home')])
    await catalog.init()
    const org = await catalog.create('Other')
    await assert.rejects(catalog.reserveDestination(org.id, join(parent, 'future-home', 'clone')), /Home/)
    await assert.rejects(catalog.registerProject(org.id, parent), /Home/)
    await assert.rejects(stat(join(parent, 'future-home')), { code: 'ENOENT' })
    const release = await catalog.reserveDestination(DEFAULT_ORGANIZATION_ID, join(alias, 'project'))
    try {
      await assert.rejects(catalog.reserveDestination(org.id, join(parent, 'project', 'child')), /another organization/)
    } finally { release() }
    const released = await catalog.reserveDestination(org.id, join(parent, 'project'))
    released()
  })
})
