import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, rename, symlink, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test, { type TestContext } from 'node:test'
import { Hono } from 'hono'
import { ProcessManager } from '../execution/processes/manager.ts'
import type { CapabilityDescriptorV1 } from '../cluster/contracts.ts'
import { CapabilityFilesystem } from '../execution/capability-filesystem.ts'
import { CapabilityWorkdirIdentity } from '../execution/capability-workdir-identity.ts'
import { CapabilityGit } from '../execution/capability-git.ts'
import { LocalExecutor } from '../execution/local-executor.ts'
import { WORKDIR_IDENTITY_OPERATION } from '../execution/workdir-identity.ts'
import { ProjectCatalog } from '../projects/catalog.ts'
import { DEFAULT_PROJECT_ID } from '../projects/contracts.ts'
import { ProjectExecutor } from '../projects/executor.ts'
import { reserveRemoteSessionWorkdirs } from '../projects/session-ownership.ts'
import { remoteSessionPlugin } from '../sessions/remote-session-routes.ts'
import { JsonlSessionStore } from '../sessions/session-store-jsonl.ts'
import { SqliteSessionStore } from '../sessions/session-store-sqlite.ts'
import type { SessionState, SessionStore } from '../sessions/session-store.ts'
import type { SessionManager } from '../sessions/session-manager.ts'
import type { WorkdirCapabilityState, WorkdirRefV1 } from '../sessions/locality.ts'
import { FolderRegistry } from './registry.ts'
import { RemoteFolderOwnership } from './remote-ownership.ts'
import { FolderService } from './routes.ts'
import { folderFixture } from './test-fixtures.ts'

async function fixture(t: TestContext) {
  const { root, folders, workspace } = await folderFixture(t)
  const a = join(folders, 'a')
  const nested = join(a, 'nested')
  const b = join(folders, 'b')
  const alias = join(folders, 'alias')
  await Promise.all([mkdir(nested, { recursive: true }), mkdir(b)])
  await symlink(a, alias, process.platform === 'win32' ? 'junction' : 'dir')
  await writeFile(join(a, 'remote.txt'), 'CHILD content')
  await writeFile(join(workspace, 'remote.txt'), 'MAIN secret')
  const bindings = [{ capabilityId: 'a', rootPath: a }, { capabilityId: 'b', rootPath: b },
    { capabilityId: 'nested', rootPath: nested }, { capabilityId: 'alias', rootPath: alias },
    { capabilityId: 'parent', rootPath: folders }]
  const local = new LocalExecutor(new ProcessManager(), 'child', [
    new CapabilityWorkdirIdentity(bindings), new CapabilityFilesystem(bindings), new CapabilityGit(bindings),
  ])
  const catalog = new ProjectCatalog(join(root, 'host'))
  await catalog.init()
  const other = await catalog.create('Other')
  let online = true
  let supported = true
  let capabilityState: WorkdirCapabilityState | undefined
  const capability = (ref: WorkdirRefV1): CapabilityDescriptorV1 | undefined => bindings.some(item => item.capabilityId === ref.capabilityId) ? {
    version: 1, nodeId: 'child', capabilityId: ref.capabilityId, kind: 'workdir', online, displayName: ref.capabilityId,
    displayPath: workspace, permissions: supported ? [WORKDIR_IDENTITY_OPERATION] : [],
  } : undefined
  const lookup = (ref: WorkdirRefV1) => capabilityState ?? ({ node: online ? 'online' as const : 'offline' as const,
    ...(capability(ref) ? { capability: { kind: 'workdir', online } } : {}) })
  const registry = async (projectId: string) => {
    const result = new FolderRegistry(workspace, { catalog, projectId })
    await result.init()
    const executor = new ProjectExecutor(projectId, local)
    result.configureRemote(new RemoteFolderOwnership({ projectId, catalog, executor, capability, lookup }))
    return { registry: result, executor }
  }
  return { root, workspace, catalog, other, one: await registry(DEFAULT_PROJECT_ID), two: await registry(other.id),
    lookup, setOnline: (value: boolean) => { online = value }, setSupported: (value: boolean) => { supported = value },
    setCapabilityState: (value: WorkdirCapabilityState | undefined) => { capabilityState = value } }
}

const ref = (capabilityId: string): WorkdirRefV1 => ({ version: 1, nodeId: 'child', capabilityId })
const signal = () => new AbortController().signal

for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  test(`${Store.name}: remote moves retire legacy capability claims and histories without restoring source access`, async t => {
    const f = await fixture(t)
    const store: SessionStore = new Store(join(f.workspace, '.sessions'))
    await store.init()
    const legacy: SessionState = { sessionId: 'web:legacy', segmentIndex: 0, projectId: 'default', workdir: ref('alias') }
    await store.saveState(legacy.sessionId, legacy)
    await store.close?.()
    await reserveRemoteSessionWorkdirs(f.workspace, f.catalog, 'default')
    const original = await f.one.registry.registerRemote(ref('a'), signal())
    f.setOnline(false)
    await assert.rejects(f.one.registry.changeProject(original.id, f.other.id), { code: 'remote_workdir_unavailable' })
    assert.equal(f.one.registry.get(original.id)?.id, original.id)
    f.setOnline(true)
    const moved = await f.one.registry.changeProject(original.id, f.other.id)
    assert(moved && moved.kind === 'remote')
    assert.notEqual(moved.id, original.id)
    assert.deepEqual(f.catalog.remoteClaims(), [])
    assert.throws(() => f.one.registry.assertSessionFolder(legacy), { code: 'folder_access_revoked' })
    await assert.rejects(f.one.registry.registerRemote(ref('alias'), signal()), { code: 'folder_owned_by_another_project' })
    assert.equal((await f.two.registry.requireAvailable(moved.id)).id, moved.id)
    await reserveRemoteSessionWorkdirs(f.workspace, f.catalog, 'default')
    assert.deepEqual(f.catalog.remoteClaims(), [])
    const returned = await f.two.registry.changeProject(moved.id, 'default')
    assert(returned)
    assert.throws(() => f.one.registry.assertSessionFolder(legacy), { code: 'folder_access_revoked' })
    assert.throws(() => f.one.registry.assertSessionFolder({ folderId: original.id, workdir: ref('a') }), { code: 'folder_access_revoked' })
    f.one.registry.assertSessionFolder({ folderId: returned.id, workdir: ref('a') })
    await f.one.registry.changeProject(returned.id)
    const restarted = new ProjectCatalog(join(f.root, 'host'))
    await restarted.init()
    await reserveRemoteSessionWorkdirs(f.workspace, restarted, 'default')
    assert.deepEqual(restarted.remoteClaims(), [])
    assert.deepEqual(restarted.folders(), [])
    const old = new FolderRegistry(f.workspace, { catalog: restarted, projectId: 'default' })
    await old.init()
    assert.throws(() => old.assertSessionFolder(legacy), { code: 'folder_access_revoked' })
    const history: SessionStore = new Store(join(f.workspace, '.sessions'))
    try {
      await history.init()
      assert.deepEqual(JSON.parse(JSON.stringify(await history.getState(legacy.sessionId))), { ...legacy, ownershipVersion: 2 })
    } finally { await history.close?.() }
  })
}

test('two projects share a node, but identical, alias and ancestor roots have one owner across restarts', async t => {
  const f = await fixture(t)
  const [a, b] = await Promise.all([f.one.registry.registerRemote(ref('a'), signal()), f.two.registry.registerRemote(ref('b'), signal())])
  assert.notEqual(a.id, b.id)
  assert.equal(a.kind, 'remote')
  for (const id of ['a', 'alias', 'nested', 'parent']) {
    await assert.rejects(f.two.registry.registerRemote(ref(id), signal()), { code: 'folder_owned_by_another_project' })
  }
  assert.equal((await f.one.registry.registerRemote(ref('alias'), signal())).id, a.id)
  assert.equal(f.catalog.folders().length, 2)
  const reloaded = new ProjectCatalog(join(f.root, 'host'))
  await reloaded.init()
  assert.equal(reloaded.folders().length, 2)
  await assert.rejects(reloaded.registerRemoteFolder(f.other.id, ref('alias'), a.identity), { code: 'folder_owned_by_another_project' })
  await assert.rejects(f.two.registry.requireAvailable(a.id), { code: 'folder_not_found' })
})

test('remote folder resources branch to Child only and reject foreign folder access', async t => {
  const f = await fixture(t)
  await promisify(execFile)('git', ['init', '--quiet', join(f.root, 'folders', 'a')])
  const folder = await f.one.registry.registerRemote(ref('a'), signal())
  let created = 0
  const service = new FolderService({ ...f.one, remoteExecutor: f.one.executor, createSession: async () => {
    created++
    return { sessionId: 'test', chatId: 'test' }
  } })
  const app = new Hono()
  service.plugin(app)
  const files = await app.request(`/api/folders/${folder.id}/files`)
  assert.equal(files.status, 200)
  assert.equal((await files.json()).workdir.kind, 'remote')
  const preview = await app.request(`/api/folders/${folder.id}/preview?path=remote.txt`)
  assert.equal((await preview.json()).content, 'CHILD content')
  const git = await app.request(`/api/folders/${folder.id}/git/status`)
  assert.equal(git.status, 200)
  assert.deepEqual((await git.json()).entries, [{ path: 'remote.txt', status: 'untracked' }])
  const diff = await app.request(`/api/folders/${folder.id}/git/diff?path=remote.txt`)
  assert.equal(diff.status, 200)
  assert.equal((await diff.json()).newContent, 'CHILD content')
  for (const suffix of ['raw?path=remote.txt', 'static/remote.txt']) {
    assert.equal((await app.request(`/api/folders/${folder.id}/${suffix}`)).status, 501)
  }
  assert.equal(created, 0)
  const foreign = new Hono()
  new FolderService({ ...f.two, remoteExecutor: f.two.executor, createSession: async () => { throw new Error('Foreign session') } }).plugin(foreign)
  for (const suffix of ['files', 'preview?path=remote.txt', 'raw?path=remote.txt', 'static/remote.txt', 'git/status', 'git/diff?path=remote.txt']) {
    assert.equal((await foreign.request(`/api/folders/${folder.id}/${suffix}`)).status, 404)
  }
  assert.equal((await foreign.request(`/api/folders/${folder.id}/sessions`, { method: 'POST' })).status, 404)
  f.setOnline(false)
  for (const suffix of ['files', 'preview?path=remote.txt', 'raw?path=remote.txt', 'static/remote.txt', 'git/status', 'git/diff?path=remote.txt']) {
    const response = await app.request(`/api/folders/${folder.id}/${suffix}`)
    assert.equal(response.status, 503)
    const body = await response.json()
    assert.equal(body.error, 'remote_workdir_unavailable')
    assert.equal(body.reason, 'node-offline')
    assert.equal(body.nodeId, 'child')
    assert.equal(body.capabilityId, 'a')
    assert.equal(JSON.stringify(body).includes('MAIN secret'), false)
  }
  for (const [state, reason] of [
    [{ node: 'missing' }, 'node-missing'],
    [{ node: 'revoked' }, 'capability-revoked'],
    [{ node: 'online' }, 'capability-missing'],
    [{ node: 'online', capability: { kind: 'workdir', online: false } }, 'capability-offline'],
    [{ node: 'online', capability: { kind: 'shell', online: true } }, 'incompatible'],
  ] as const) {
    f.setCapabilityState(state)
    for (const suffix of ['files', 'git/status']) {
      const response = await app.request(`/api/folders/${folder.id}/${suffix}`)
      assert.equal(response.status, 503)
      assert.equal((await response.json()).reason, reason)
    }
  }
  f.setCapabilityState(undefined)
  f.setOnline(true)
  assert.equal((await (await app.request(`/api/folders/${folder.id}/preview?path=remote.txt`)).json()).content, 'CHILD content')
  assert.equal((await app.request(`/api/folders/${folder.id}/git/status`)).status, 200)
})

test('remote first-send registers once, allocates only on POST, and retries reuse the session/folder', async t => {
  const f = await fixture(t)
  const states = new Map<string, SessionState>()
  let created = 0
  const sessions: Pick<SessionManager, 'workspace' | 'remoteExecutor' | 'workdirCapabilityLookup' | 'buildSession' | 'getSessionState'> = {
    workspace: f.workspace, remoteExecutor: f.one.executor, workdirCapabilityLookup: f.lookup,
    getSessionState: id => states.get(id) ?? null,
    buildSession: async (id, _parent, fields) => {
      created++
      states.set(id, { sessionId: id, segmentIndex: 0, workdir: fields?.workdir, folderId: fields?.folderId })
    },
  }
  const app = new Hono()
  remoteSessionPlugin({ sessions, folders: f.one.registry, requireFolderOwnership: true, authorize: () => true })(app)
  const request = (body: unknown) => app.request('/api/sessions/remote', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  assert.equal(created, 0)
  assert.equal(f.one.registry.list().length, 0)
  const body = { nodeId: 'child', capabilityId: 'a', requestId: randomUUID() }
  const responses = await Promise.all([request(body), request(body)])
  assert(responses.every(response => response.status === 201))
  const results = await Promise.all(responses.map(response => response.json()))
  assert.equal(results[0].sessionId, results[1].sessionId)
  assert(results[0].folderId)
  assert.equal(created, 1)
  f.setOnline(false)
  assert.equal((await request(body)).status, 201)
  assert.equal(created, 1)
  assert.equal((await request({ ...body, capabilityId: 'b' })).status, 409)
  assert.equal(f.one.registry.list().length, 1)
})

test('old and offline nodes fail explicitly without allocating or falling back to Main', async t => {
  const f = await fixture(t)
  f.setSupported(false)
  await assert.rejects(f.one.registry.registerRemote(ref('a'), signal()), { code: 'remote_workdir_identity_unsupported' })
  f.setOnline(false)
  await assert.rejects(f.one.registry.registerRemote(ref('a'), signal()), { code: 'remote_workdir_unavailable' })
  assert.equal(f.catalog.folders().length, 0)
})

test('registration refreshes authoritative ancestry after a registered directory moves through an alias', async t => {
  const f = await fixture(t)
  await f.one.registry.registerRemote(ref('alias'), signal())
  const moved = join(f.root, 'folders', 'b', 'moved')
  await rename(join(f.root, 'folders', 'a'), moved)
  const alias = join(f.root, 'folders', 'alias')
  await unlink(alias)
  await symlink(moved, alias, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(f.two.registry.registerRemote(ref('b'), signal()), { code: 'folder_owned_by_another_project' })
})

for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  test(`${Store.name}: migrated default remote sessions reserve aliases and overlapping roots`, async t => {
    const f = await fixture(t)
    const directory = join(f.workspace, '.sessions')
    const store: SessionStore = new Store(directory)
    await store.init()
    await store.saveState('legacy', { sessionId: 'legacy', segmentIndex: 0, projectId: DEFAULT_PROJECT_ID, workdir: ref('a') })
    store.close?.()
    await reserveRemoteSessionWorkdirs(f.workspace, f.catalog, DEFAULT_PROJECT_ID)
    f.setOnline(false)
    await assert.rejects(f.two.registry.registerRemote(ref('b'), signal()), { code: 'remote_workdir_unavailable' })
    f.setOnline(true)
    for (const id of ['a', 'alias', 'nested', 'parent']) {
      await assert.rejects(f.two.registry.registerRemote(ref(id), signal()), { code: 'folder_owned_by_another_project' })
    }
    await f.two.registry.registerRemote(ref('b'), signal())
    assert.equal(f.catalog.remoteClaims('child')[0].projectId, DEFAULT_PROJECT_ID)
    assert(f.catalog.remoteClaims('child')[0].identity)
  })
}
