import { projectStoragePath } from '../utils/data-paths.ts'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { absoluteDirectoryPath, FolderRegistry } from './registry.ts'
import { folderFixture } from './test-fixtures.ts'

test('absolute directory paths reject control characters and lengths over 10000', () => {
  const prefix = join(process.cwd(), 'folder-')
  for (const code of [...Array.from({ length: 32 }, (_, index) => index), 127]) {
    assert.throws(() => absoluteDirectoryPath(`${prefix}${String.fromCharCode(code)}`), /absolute/)
  }
  const boundary = prefix + 'a'.repeat(10_000 - prefix.length)
  assert.equal(absoluteDirectoryPath(boundary), boundary)
  assert.throws(() => absoluteDirectoryPath(`${boundary}a`), /absolute/)
})

test('registers empty folders, normalizes aliases, serializes writes, and preserves IDs on restart', async (t) => {
  const { root, workspace, folders } = await folderFixture(t)
  const first = join(folders, 'An Empty Folder')
  const second = join(folders, 'Second')
  await Promise.all([mkdir(first), mkdir(second)])
  const registry = new FolderRegistry(workspace)
  await registry.init()
  assert.deepEqual(registry.list(), [])
  const [folder, duplicate, other] = await Promise.all([
    registry.register(first),
    registry.register(join(first, '..', 'An Empty Folder', '.')),
    registry.register(second),
  ])
  assert.deepEqual(folder, duplicate)
  assert.equal(folder.name, 'An Empty Folder')
  assert.equal(folder.path, await realpath(first))
  assert.notEqual(other.id, folder.id)
  assert.equal(registry.list().length, 2)
  assert.deepEqual(await readdir(first), [])
  const alias = join(root, 'folder-alias')
  await symlink(first, alias, process.platform === 'win32' ? 'junction' : 'dir')
  assert.deepEqual(await registry.register(alias), folder)
  if (process.platform === 'win32') {
    assert.deepEqual(await registry.register(first.toUpperCase()), folder)
  }
  const restarted = new FolderRegistry(workspace)
  await restarted.init()
  assert.deepEqual(restarted.list(), registry.list())
  assert.deepEqual(await restarted.register(first), folder)
  const copy = registry.get(folder.id)!
  copy.path = 'tampered'
  assert.equal(registry.get(folder.id)?.path, folder.path)
  assert.deepEqual(await readdir(workspace), ['state'])
  assert.deepEqual(await readdir(join(workspace, 'state')), ['folders.v2.json'])
})

test('unavailable registered folders remain in the registry without recreation or display-path trust', async (t) => {
  const { workspace, folders } = await folderFixture(t)
  const path = join(folders, 'Folder')
  await mkdir(path)
  const registry = new FolderRegistry(workspace)
  await registry.init()
  const folder = await registry.register(path)
  const ref = {
    version: 1 as const,
    nodeId: 'local',
    capabilityId: `local-project-v1:${folder.id}`,
    displayPathSnapshot: workspace,
  }
  assert.deepEqual(registry.lookupWorkdir(ref), {
    node: 'online', capability: { kind: 'workdir', online: true, path: folder.path },
  })
  assert.equal(registry.lookupWorkdir({ ...ref, nodeId: 'other' }), undefined)
  assert.equal(registry.lookupWorkdir({ ...ref, capabilityId: 'managed-session-v1:a' }), undefined)
  assert.deepEqual(registry.lookupWorkdir({ ...ref, capabilityId: `local-project-v1:${randomUUID()}` }), { node: 'online' })
  await rm(path, { recursive: true })
  await assert.rejects(registry.requireAvailable(folder.id), /unavailable/)
  await assert.rejects(registry.requireAvailable(randomUUID()), /not found/)
  assert.deepEqual(registry.lookupWorkdir(ref), {
    node: 'online', capability: { kind: 'workdir', online: false },
  })
  const restarted = new FolderRegistry(workspace)
  await restarted.init()
  assert.deepEqual(restarted.get(folder.id), folder)
  assert.deepEqual(await readdir(folders), [])
})

test('registry validates malformed data rather than silently resetting or overwriting it', async (t) => {
  const { workspace, folders } = await folderFixture(t)
  const valid = { id: randomUUID(), name: 'Custom name', path: folders, createdAt: new Date().toISOString() }
  const file = projectStoragePath(workspace, 'folders.v2.json')
  await mkdir(dirname(file), { recursive: true })
  for (const content of [
    '{',
    JSON.stringify([]),
    JSON.stringify({ version: 3, folders: [] }),
    JSON.stringify({ version: 2, folders: [{ ...valid, id: 'unstable' }] }),
    JSON.stringify({ version: 2, folders: [{ ...valid, path: 'relative' }] }),
    JSON.stringify({ version: 2, folders: [{ ...valid, createdAt: 'yesterday' }] }),
    JSON.stringify({ version: 2, folders: [{ ...valid, createdAt: '2026-02-30T00:00:00.000Z' }] }),
    JSON.stringify({ version: 2, folders: [valid, valid] }),
  ]) {
    await writeFile(file, content)
    const registry = new FolderRegistry(workspace)
    await assert.rejects(registry.init(), /invalid/)
    assert.equal(await readFile(file, 'utf8'), content)
  }
  await writeFile(file, JSON.stringify({ version: 2, folders: [valid] }))
  const registry = new FolderRegistry(workspace)
  await registry.init()
  assert.deepEqual(await registry.register(folders), valid)
})

test('rejects relative, missing, and file paths; abort and failed persistence do not create records', async (t) => {
  const { workspace, folders } = await folderFixture(t)
  const registry = new FolderRegistry(workspace)
  await registry.init()
  await assert.rejects(registry.register('relative'), /absolute/)
  await assert.rejects(registry.register(join(folders, 'missing')), /unavailable/)
  const file = join(folders, 'file')
  await writeFile(file, 'keep')
  await assert.rejects(registry.register(file), /unavailable/)
  if (process.platform === 'win32') {
    await assert.rejects(registry.register('\\drive-relative'), /absolute/)
    await assert.rejects(registry.register('/drive-relative'), /absolute/)
  }
  const controller = new AbortController()
  const pending = registry.register(folders, controller.signal)
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  assert.deepEqual(registry.list(), [])
  assert.deepEqual(await readdir(workspace), [])
  await mkdir(registry.filePath, { recursive: true })
  await assert.rejects(registry.register(folders))
  assert.deepEqual(registry.list(), [])
  assert.deepEqual(await readdir(workspace), ['state'])
  assert.deepEqual(await readdir(join(workspace, 'state')), ['folders.v2.json'])
  const inaccessible = new FolderRegistry(workspace)
  await assert.rejects(inaccessible.init())
  await rm(registry.filePath, { recursive: true })
  assert.equal((await registry.register(folders)).path, await realpath(folders))
})
