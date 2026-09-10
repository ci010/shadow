import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { absoluteDirectoryPath, ProjectRegistry } from './registry.ts'
import { projectFixture } from './test-fixtures.ts'

test('absolute directory paths reject control characters and lengths over 10000', () => {
  const prefix = join(process.cwd(), 'project-')
  for (const code of [...Array.from({ length: 32 }, (_, index) => index), 127]) {
    assert.throws(() => absoluteDirectoryPath(`${prefix}${String.fromCharCode(code)}`), /absolute/)
  }
  const boundary = prefix + 'a'.repeat(10_000 - prefix.length)
  assert.equal(absoluteDirectoryPath(boundary), boundary)
  assert.throws(() => absoluteDirectoryPath(`${boundary}a`), /absolute/)
})

test('registers empty folders, normalizes aliases, serializes writes, and preserves IDs on restart', async (t) => {
  const { root, workspace, folders } = await projectFixture(t)
  const first = join(folders, 'An Empty Project')
  const second = join(folders, 'Second')
  await Promise.all([mkdir(first), mkdir(second)])
  const registry = new ProjectRegistry(workspace)
  await registry.init()
  assert.deepEqual(registry.list(), [])
  const [project, duplicate, other] = await Promise.all([
    registry.register(first),
    registry.register(join(first, '..', 'An Empty Project', '.')),
    registry.register(second),
  ])
  assert.deepEqual(project, duplicate)
  assert.equal(project.name, 'An Empty Project')
  assert.equal(project.path, await realpath(first))
  assert.notEqual(other.id, project.id)
  assert.equal(registry.list().length, 2)
  assert.deepEqual(await readdir(first), [])
  const alias = join(root, 'folder-alias')
  await symlink(first, alias, process.platform === 'win32' ? 'junction' : 'dir')
  assert.deepEqual(await registry.register(alias), project)
  if (process.platform === 'win32') {
    assert.deepEqual(await registry.register(first.toUpperCase()), project)
  }
  const restarted = new ProjectRegistry(workspace)
  await restarted.init()
  assert.deepEqual(restarted.list(), registry.list())
  assert.deepEqual(await restarted.register(first), project)
  const copy = registry.get(project.id)!
  copy.path = 'tampered'
  assert.equal(registry.get(project.id)?.path, project.path)
  assert.deepEqual(await readdir(workspace), ['projects.v1.json'])
})

test('unavailable registered folders remain in the registry without recreation or display-path trust', async (t) => {
  const { workspace, folders } = await projectFixture(t)
  const path = join(folders, 'Project')
  await mkdir(path)
  const registry = new ProjectRegistry(workspace)
  await registry.init()
  const project = await registry.register(path)
  const ref = {
    version: 1 as const,
    nodeId: 'local',
    capabilityId: `local-project-v1:${project.id}`,
    displayPathSnapshot: workspace,
  }
  assert.deepEqual(registry.lookupWorkdir(ref), {
    node: 'online', capability: { kind: 'workdir', online: true, path: project.path },
  })
  assert.equal(registry.lookupWorkdir({ ...ref, nodeId: 'other' }), undefined)
  assert.equal(registry.lookupWorkdir({ ...ref, capabilityId: 'managed-session-v1:a' }), undefined)
  assert.deepEqual(registry.lookupWorkdir({ ...ref, capabilityId: `local-project-v1:${randomUUID()}` }), { node: 'online' })
  await rm(path, { recursive: true })
  await assert.rejects(registry.requireAvailable(project.id), /unavailable/)
  await assert.rejects(registry.requireAvailable(randomUUID()), /not found/)
  assert.deepEqual(registry.lookupWorkdir(ref), {
    node: 'online', capability: { kind: 'workdir', online: false },
  })
  const restarted = new ProjectRegistry(workspace)
  await restarted.init()
  assert.deepEqual(restarted.get(project.id), project)
  assert.deepEqual(await readdir(folders), [])
})

test('registry validates malformed data rather than silently resetting or overwriting it', async (t) => {
  const { workspace, folders } = await projectFixture(t)
  const valid = { id: randomUUID(), name: 'Custom name', path: folders, createdAt: new Date().toISOString() }
  const file = join(workspace, 'projects.v1.json')
  for (const content of [
    '{',
    JSON.stringify([]),
    JSON.stringify({ version: 2, projects: [] }),
    JSON.stringify({ version: 1, projects: [{ ...valid, id: 'unstable' }] }),
    JSON.stringify({ version: 1, projects: [{ ...valid, path: 'relative' }] }),
    JSON.stringify({ version: 1, projects: [{ ...valid, createdAt: 'yesterday' }] }),
    JSON.stringify({ version: 1, projects: [{ ...valid, createdAt: '2026-02-30T00:00:00.000Z' }] }),
    JSON.stringify({ version: 1, projects: [valid, valid] }),
  ]) {
    await writeFile(file, content)
    const registry = new ProjectRegistry(workspace)
    await assert.rejects(registry.init(), /invalid/)
    assert.equal(await readFile(file, 'utf8'), content)
  }
  await writeFile(file, JSON.stringify({ version: 1, projects: [valid] }))
  const registry = new ProjectRegistry(workspace)
  await registry.init()
  assert.deepEqual(await registry.register(folders), valid)
})

test('rejects relative, missing, and file paths; abort and failed persistence do not create records', async (t) => {
  const { workspace, folders } = await projectFixture(t)
  const registry = new ProjectRegistry(workspace)
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
  await mkdir(registry.filePath)
  await assert.rejects(registry.register(folders))
  assert.deepEqual(registry.list(), [])
  assert.deepEqual(await readdir(workspace), ['projects.v1.json'])
  const inaccessible = new ProjectRegistry(workspace)
  await assert.rejects(inaccessible.init())
  await rm(registry.filePath, { recursive: true })
  assert.equal((await registry.register(folders)).path, await realpath(folders))
})
