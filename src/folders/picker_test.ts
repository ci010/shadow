import assert from 'node:assert/strict'
import { mkdir, readdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { Hono } from 'hono'
import { registerGatewayRoutes } from '../gateway/server.ts'
import { folderFixture } from './test-fixtures.ts'
import { FolderRegistry } from './registry.ts'
import { FolderService } from './routes.ts'
import { RemoteFolderOwnership } from './remote-ownership.ts'
import { ProjectCatalog } from '../projects/catalog.ts'
import { ProjectExecutor } from '../projects/executor.ts'
import { ManagedChildWorkdirs } from '../execution/managed-child-workdirs.ts'
import { LocalExecutor } from '../execution/local-executor.ts'
import { ProcessManager } from '../execution/processes/manager.ts'
import { browseDirectories, FOLDER_PICKER_CAPABILITY, FOLDER_BROWSE_OPERATION, FOLDER_SELECT_OPERATION } from './picker.ts'
import type { NodeInventoryResponse } from '../cluster/node-inventory.ts'
import type { JobRequestV1 } from '../execution/contracts.ts'

const signal = () => new AbortController().signal
function post(app: Hono, action: string, nodeId: string, path: string, extras = {}) {
  return app.request(`/api/folders/picker/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nodeId, path, ...extras }) })
}

test('owner picker browses and registers Main and Child without creating a chat; advertises before identity and preserves ownership', async t => {
  const f = await folderFixture(t)
  const childPath = join(f.folders, 'child-project')
  const mainPath = join(f.folders, 'main-project')
  await mkdir(childPath); await mkdir(mainPath); await mkdir(join(childPath, 'nested'))
  const child = new ManagedChildWorkdirs(join(f.root, 'child-managed'), 'other-child', [])
  await child.init()
  const advertised: string[] = []
  child.onCapability = cap => { advertised.push(cap.capabilityId) }
  const executor = new LocalExecutor(new ProcessManager(), 'other-child', child.operationHandlers)
  const catalog = new ProjectCatalog(join(f.root, 'host'))
  await catalog.init()
  const other = await catalog.create('Other')
  let online = true
  const inventory = (): NodeInventoryResponse => ({ version: 1, nodes: [
    { nodeId: 'main-identity', displayName: 'Main', role: 'main', connection: 'connected', capabilities: [] },
    { nodeId: 'other-child', displayName: 'Other Child', role: 'child', connection: online ? 'connected' : 'offline',
      capabilities: child.capabilities.map(c => ({ ...c, online: online && c.online })) },
    { nodeId: 'old-child', displayName: 'Old Child', role: 'child', connection: 'connected', capabilities: [] },
  ] })
  let sessions = 0
  async function service(projectId: string) {
    const registry = new FolderRegistry(f.workspace, { catalog, projectId })
    await registry.init()
    const scoped = new ProjectExecutor(projectId, executor)
    registry.configureRemote(new RemoteFolderOwnership({ projectId, catalog, executor: scoped,
      lookup: ref => ({ node: online ? 'online' : 'offline', capability: { kind: 'workdir', online: advertised.includes(ref.capabilityId) } }),
      capability: ref => child.capabilities.find(c => c.capabilityId === ref.capabilityId),
    }))
    const folders = new FolderService({ registry, picker: { inventory, executor: scoped }, createSession: async () => {
      sessions++; return { sessionId: 'unused', chatId: 'unused' }
    } })
    t.after(() => folders.dispose())
    const app = new Hono(); folders.plugin(app)
    return { app, registry }
  }
  const one = await service('default')
  const two = await service(other.id)
  const devices = (await (await one.app.request('/api/folders/picker/devices')).json()).devices
  assert.equal(devices[0].nodeId, 'main-identity')
  assert.equal(devices[2].supported, false)
  for (const [node, path] of [['main-identity', mainPath], ['other-child', childPath]]) {
    const response = await post(one.app, 'browse', node, path)
    assert.equal(response.status, 200)
    assert.equal((await response.json()).listing.path, path)
  }
  const main = await post(one.app, 'select', 'main-identity', mainPath)
  assert.equal(main.status, 200)
  assert.notEqual((await main.json()).folder.kind, 'remote')
  const selected = await post(one.app, 'select', 'other-child', childPath)
  assert.equal(selected.status, 200)
  const remote = (await selected.json()).folder
  assert.equal(remote.kind, 'remote')
  assert.equal(remote.workdir.nodeId, 'other-child')
  assert.ok(advertised.includes(remote.workdir.capabilityId))
  assert.equal((await (await post(one.app, 'select', 'other-child', childPath)).json()).folder.id, remote.id)
  assert.equal((await post(two.app, 'select', 'other-child', childPath)).status, 409)
  assert.equal((await post(two.app, 'select', 'other-child', join(childPath, 'nested'))).status, 409)
  assert.equal((await post(one.app, 'select', 'other-child', child.rootPath)).status, 503)
  assert.equal(sessions, 0)
  const restored = new ManagedChildWorkdirs(child.rootPath, 'other-child', [])
  await restored.init()
  assert.ok(restored.capabilities.some(c => c.capabilityId === remote.workdir.capabilityId))
  online = false
  assert.equal((await post(one.app, 'browse', 'other-child', childPath)).status, 503)
  assert.equal((await post(one.app, 'select', 'unknown', mainPath)).status, 503)
  assert.equal((await post(one.app, 'browse', 'old-child', '')).status, 409)
  assert.equal((await post(one.app, 'select', 'main-identity', mainPath, { capabilityId: 'spoof' })).status, 400)
})

test('picker directory browsing handles Unicode, symlinks, parent, invalid paths and aborts', async t => {
  const f = await folderFixture(t)
  await mkdir(join(f.folders, '项目'))
  await writeFile(join(f.folders, 'not-a-directory'), 'x')
  await symlink(join(f.folders, '项目'), join(f.folders, 'alias'), process.platform === 'win32' ? 'junction' : 'dir')
  const listing = await browseDirectories(f.folders, signal())
  assert.deepEqual(listing.directories.map(d => d.name).sort(), ['alias', '项目'].sort())
  assert.equal(listing.parent, f.root)
  await assert.rejects(browseDirectories('relative', signal()))
  await assert.rejects(browseDirectories(join(f.folders, 'not-a-directory'), signal()))
  const abort = new AbortController(); abort.abort()
  await assert.rejects(browseDirectories(f.folders, abort.signal))
  assert.deepEqual(await readdir(f.folders), ['alias', 'not-a-directory', '项目'])
})

test('Child picker operations reject use through a different capability and malformed arguments', async t => {
  const f = await folderFixture(t)
  const child = new ManagedChildWorkdirs(join(f.root, 'managed'), 'child', [])
  await child.init()
  const handler = child.operationHandlers.find(h => h.handles(FOLDER_BROWSE_OPERATION))!
  assert.ok('execute' in handler)
  const request = { nodeId: 'child', capabilityId: FOLDER_PICKER_CAPABILITY, operation: FOLDER_BROWSE_OPERATION, args: { path: f.folders } } as JobRequestV1
  if (!('execute' in handler)) return
  for (const override of [{ capabilityId: 'process-execute' }, { nodeId: 'foreign' }, { args: { path: f.folders, extra: true } }, { args: { path: 'relative' } }]) {
    await assert.rejects(handler.execute({ ...request, ...override }, signal()))
  }
  const result = await handler.execute({ ...request, operation: FOLDER_SELECT_OPERATION }, signal())
  assert.equal(JSON.parse(result).nodeId, 'child')
})


test('picker APIs require owner UI admission and preserve opaque foreign filesystem paths', async t => {
  const f = await folderFixture(t)
  const registry = new FolderRegistry(f.workspace)
  await registry.init()
  const opaque = 'Z:\\远端\\项目'
  let calls = 0
  const executor = new LocalExecutor(new ProcessManager(), 'foreign-child', [{
    handles: operation => operation === FOLDER_BROWSE_OPERATION,
    execute: async request => {
      calls++
      assert.deepEqual(request.args, { path: opaque })
      return JSON.stringify({ path: opaque, parent: 'Z:\\远端', directories: [], truncated: false })
    },
  }])
  const service = new FolderService({ registry, picker: { executor, inventory: () => ({ version: 1, nodes: [{
    nodeId: 'foreign-child', displayName: 'Foreign filesystem', role: 'child', connection: 'connected',
    capabilities: [{ capabilityId: FOLDER_PICKER_CAPABILITY, displayName: 'Picker', kind: 'shell', online: true }],
  }] }) }, createSession: async () => { throw new Error('Must not create a chat') } })
  t.after(() => service.dispose())
  const app = new Hono()
  registerGatewayRoutes(app, [service.plugin], { launchCredential: 'synthetic-owner-token' })
  assert.equal((await app.request('/api/folders/picker/devices')).status, 401)
  assert.equal((await post(app, 'browse', 'foreign-child', opaque)).status, 401)
  assert.equal(calls, 0)
  const response = await app.request('/api/folders/picker/browse', { method: 'POST',
    headers: { authorization: 'Bearer synthetic-owner-token', 'content-type': 'application/json' },
    body: JSON.stringify({ nodeId: 'foreign-child', path: opaque }) })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).listing.path, opaque)
  assert.equal(calls, 1)
})
