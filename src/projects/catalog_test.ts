import { readFileSync as requireRead } from 'node:fs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withTempWorkspace } from '../testing/workspace.ts'
import { ProjectCatalog } from './catalog.ts'
import { FolderRegistry } from '../folders/registry.ts'
import { DEFAULT_PROJECT_ID, projectPaths } from './contracts.ts'
import { projectExecutionKey } from '../execution/managed-workdir.ts'

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

test('project deletion removes owned Home and metadata, preserves working folders and releases ownership durably', async () => {
  await withTempWorkspace(async root => {
    const catalog = new ProjectCatalog(join(root, 'host'))
    await catalog.init()
    const project = await catalog.create('Disposable')
    const paths = projectPaths(catalog.hostHome, project.id)
    const folder = join(root, 'work')
    await mkdir(folder)
    await writeFile(join(folder, 'keep.txt'), 'User files')
    await catalog.registerFolder(project.id, folder)
    await mkdir(paths.home, { recursive: true })
    await writeFile(join(paths.home, 'history.jsonl'), 'Project history')
    await catalog.reserveRemoteWorkdirs(project.id, [{ version: 2, nodeId: 'child', workdirId: 'work' }])
    let stopped = false
    await catalog.remove(project.id, async () => {
      stopped = true
      assert.equal(catalog.isDeleting(project.id), true)
      assert.equal(await readFile(join(paths.home, 'history.jsonl'), 'utf8'), 'Project history')
      assert.throws(() => catalog.acquireFolderAccess(project.id), /unavailable/)
    })
    assert.equal(stopped, true)
    assert.equal(catalog.get(project.id), undefined)
    assert.deepEqual(catalog.remoteClaims(), [])
    assert.deepEqual(catalog.folders(project.id), [])
    await assert.rejects(stat(paths.root), { code: 'ENOENT' })
    assert.equal(await readFile(join(folder, 'keep.txt'), 'utf8'), 'User files')
    const reloaded = new ProjectCatalog(catalog.hostHome)
    await reloaded.init()
    assert.equal(reloaded.get(project.id), undefined)
    assert.equal((await reloaded.registerFolder('default', folder)).projectId, 'default')
  })
})

test('deletion rejects Default, active requests, clones and uncertain remote work before touching Home', async () => {
  await withTempWorkspace(async root => {
    const catalog = new ProjectCatalog(join(root, 'host'))
    await catalog.init()
    const project = await catalog.create('Busy')
    await assert.rejects(catalog.remove('default'), /Default/)
    await assert.rejects(catalog.remove('missing'), /not found/)
    const release = catalog.acquireFolderAccess(project.id)
    await assert.rejects(catalog.remove(project.id), /requests/)
    release()
    const releaseClone = await catalog.reserveDestination(project.id, join(root, 'clone'))
    await assert.rejects(catalog.remove(project.id), /clones/)
    releaseClone()
    catalog.recordRemoteJob(project.id, 'job', true)
    await assert.rejects(catalog.remove(project.id), /terminal receipt/)
    catalog.recordRemoteJob(project.id, 'job', false)
    const unbind = catalog.configureFolderLifecycle(project.id, {
      assertIdle: () => { throw new Error('Synthetic active session') }, invalidate() {},
    })
    await assert.rejects(catalog.remove(project.id), /active session/)
    assert.equal(catalog.isDeleting(project.id), false)
    unbind()
    await catalog.remove(project.id)
  })
})

test('interrupted deletion stays revoked on disk and can finish after restart without resurrecting history', async () => {
  await withTempWorkspace(async root => {
    const catalog = new ProjectCatalog(join(root, 'host'))
    await catalog.init()
    const project = await catalog.create('Interrupted')
    const paths = projectPaths(catalog.hostHome, project.id)
    await mkdir(paths.home, { recursive: true })
    await writeFile(join(paths.home, 'memory.md'), 'Private project data')
    await assert.rejects(catalog.remove(project.id, async () => { throw new Error('Synthetic shutdown failure') }), /shutdown failure/)
    assert.equal(catalog.isDeleting(project.id), true)
    assert.equal(await readFile(join(paths.home, 'memory.md'), 'utf8'), 'Private project data')
    await assert.rejects(catalog.rename(project.id, 'Resurrected'), /deletion/)
    const reloaded = new ProjectCatalog(catalog.hostHome)
    await reloaded.init()
    assert.equal(reloaded.isDeleting(project.id), true)
    await reloaded.remove(project.id)
    await assert.rejects(stat(paths.root), { code: 'ENOENT' })
  })
})

test('project deletion refuses linked storage rather than deleting another directory', async () => {
  await withTempWorkspace(async root => {
    const catalog = new ProjectCatalog(join(root, 'host'))
    await catalog.init()
    const project = await catalog.create('Linked')
    const paths = projectPaths(catalog.hostHome, project.id)
    const target = join(root, 'user-data')
    await mkdir(target)
    await mkdir(join(catalog.hostHome, 'projects'))
    await writeFile(join(target, 'keep.txt'), 'Keep')
    await symlink(target, paths.root, process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(catalog.remove(project.id), /linked/)
    assert.equal(catalog.isDeleting(project.id), false)
    assert.equal(await readFile(join(target, 'keep.txt'), 'utf8'), 'Keep')
  })
})


test('canonical catalog reopens without rewriting persisted project data', async () => {
  await withTempWorkspace(async root => {
    const catalog = new ProjectCatalog(root)
    assert.equal(catalog.filePath, join(root, 'projects.json'))
    await catalog.init()
    await catalog.create('Existing')
    const before = await readFile(catalog.filePath, 'utf8')
    const reopened = new ProjectCatalog(root)
    await reopened.init()
    assert.equal(reopened.list().some(project => project.name === 'Existing'), true)
    assert.equal(await readFile(catalog.filePath, 'utf8'), before)
  })
})

test('folder observers follow committed project views, including agent registration, move and detach', async () => {
  await withTempWorkspace(async root => {
    const catalog = new ProjectCatalog(join(root, 'host'))
    await catalog.init()
    const other = await catalog.create('Other')
    const folderPath = join(root, 'code')
    await mkdir(folderPath)
    const events: string[] = []
    const observe = (projectId: string) => catalog.observeFolders(projectId, () => {
      events.push(projectId)
      // Notification is after both the durable write and in-memory commit.
      assert.deepEqual(JSON.parse(requireRead(catalog.filePath, 'utf8')).folders.filter((f: {projectId: string}) => f.projectId === projectId), catalog.folders(projectId))
    })
    const stopThrowing = catalog.observeFolders(DEFAULT_PROJECT_ID, () => { throw new Error('test observer failure') })
    const stopDefault = observe(DEFAULT_PROJECT_ID), stopOther = observe(other.id)
    const registry = new FolderRegistry(catalog.hostHome, { catalog, projectId: DEFAULT_PROJECT_ID })
    await registry.init()
    const folder = await registry.register(folderPath)
    assert.deepEqual(events.splice(0), [DEFAULT_PROJECT_ID])
    await registry.register(folderPath)
    await assert.rejects(catalog.registerFolder(other.id, folderPath), /another project/)
    await catalog.rename(other.id, 'New name')
    assert.deepEqual(events, [], 'No-op, rejected and unrelated writes do not notify folders')
    const failedPath = join(root, 'failed-write')
    await mkdir(failedPath)
    const catalogPath = catalog.filePath
    Object.defineProperty(catalog, 'filePath', { value: root, configurable: true })
    try { await assert.rejects(registry.register(failedPath)) }
    finally { Object.defineProperty(catalog, 'filePath', { value: catalogPath, configurable: true }) }
    assert.deepEqual(events, [], 'Failed durable writes do not publish notifications')
    assert.deepEqual(catalog.folders(DEFAULT_PROJECT_ID), [folder])
    const moved = await catalog.changeFolderProject(DEFAULT_PROJECT_ID, folder.id, other.id)
    assert.deepEqual(events.splice(0), [DEFAULT_PROJECT_ID, other.id])
    await catalog.changeFolderProject(other.id, moved!.id)
    assert.deepEqual(events.splice(0), [other.id])
    stopDefault(); stopOther(); stopThrowing()
    await registry.register(folderPath)
    assert.deepEqual(events, [], 'Released runtime observers do not receive writes')
  })
})

test('journal reconciliation settles only the exact original Project job durably after restart', async () => {
  await withTempWorkspace(async root => {
    const home = join(root, 'host')
    const writer = new ProjectCatalog(home)
    await writer.init()
    const other = await writer.create('Other')
    const folderPath = join(root, 'folder')
    await mkdir(folderPath)
    const folder = await writer.registerFolder(DEFAULT_PROJECT_ID, folderPath)
    const original = 'original/job%2F原字节'
    const second = 'still-unknown'
    writer.recordRemoteJob(DEFAULT_PROJECT_ID, original, true)
    writer.recordRemoteJob(DEFAULT_PROJECT_ID, second, true)
    writer.recordRemoteJob(other.id, original, true)

    // New Catalog instance has only the pre-existing logical IDs on disk, not
    // an executor's in-memory execution keys or the original wire request.
    const restarted = new ProjectCatalog(home)
    await restarted.init()
    const before = await readFile(restarted.filePath, 'utf8')
    const expected = JSON.parse(before)
    const originalScoped = projectExecutionKey(DEFAULT_PROJECT_ID, 'job', original)
    for (const unproven of ['', original, 'unknown',
      projectExecutionKey(DEFAULT_PROJECT_ID, 'job', 'rejected-reconcile-query'),
      projectExecutionKey(DEFAULT_PROJECT_ID, 'session', original),
      projectExecutionKey(other.id, 'job', original),
      projectExecutionKey('unknown-project', 'job', original)]) {
      restarted.settleReconciledRemoteJob(DEFAULT_PROJECT_ID, unproven)
      assert.equal(await readFile(restarted.filePath, 'utf8'), before, 'unmatched proof must not rewrite or clear pending jobs')
    }
    restarted.settleReconciledRemoteJob(other.id, originalScoped)
    restarted.settleReconciledRemoteJob('unknown-project', originalScoped)
    assert.equal(await readFile(restarted.filePath, 'utf8'), before)
    await assert.rejects(restarted.changeFolderProject(DEFAULT_PROJECT_ID, folder.id), /remote job.*terminal receipt/)

    restarted.settleReconciledRemoteJob(DEFAULT_PROJECT_ID, originalScoped)
    expected.pendingRemoteJobs = expected.pendingRemoteJobs.filter((job: { projectId: string; jobId: string }) =>
      !(job.projectId === DEFAULT_PROJECT_ID && job.jobId === original))
    assert.deepEqual(JSON.parse(await readFile(restarted.filePath, 'utf8')), expected, 'only the exact pending record changes; no new storage layout')
    const reloaded = new ProjectCatalog(home)
    await reloaded.init()
    await assert.rejects(reloaded.changeFolderProject(DEFAULT_PROJECT_ID, folder.id), /remote job.*terminal receipt/)
    reloaded.settleReconciledRemoteJob(DEFAULT_PROJECT_ID, projectExecutionKey(DEFAULT_PROJECT_ID, 'job', second))
    await reloaded.changeFolderProject(DEFAULT_PROJECT_ID, folder.id)
    await assert.rejects(reloaded.remove(other.id), /remote job.*terminal receipt/)
    reloaded.settleReconciledRemoteJob(other.id, projectExecutionKey(other.id, 'job', original))
    const settled = await readFile(reloaded.filePath, 'utf8')
    assert.deepEqual(JSON.parse(settled).pendingRemoteJobs, [])
    reloaded.settleReconciledRemoteJob(DEFAULT_PROJECT_ID, originalScoped)
    assert.equal(await readFile(reloaded.filePath, 'utf8'), settled, 'duplicate proof is a read-only no-op')
    const final = new ProjectCatalog(home)
    await final.init()
    assert.deepEqual(JSON.parse(await readFile(final.filePath, 'utf8')).pendingRemoteJobs, [])
  })
})
