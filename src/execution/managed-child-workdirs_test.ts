import { fixtureProjectExecutor } from './test-fixtures.ts'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { folderFixture } from '../folders/test-fixtures.ts'
import { ManagedChildWorkdirs } from './managed-child-workdirs.ts'
import { LocalExecutor } from './local-executor.ts'
import { ProcessManager } from './processes/manager.ts'
import { ProjectExecutor } from '../projects/executor.ts'
import { allocateRemoteSessionWorkdir } from './remote-managed-workdir-client.ts'
import { managedProjectScope, managedSessionWorkdirId, LEGACY_MANAGED_SERVICE_ID, MANAGED_SESSION_OPERATION, projectExecutionKey } from './managed-workdir.ts'
import { executeRemoteFilesystemText } from './remote-filesystem-client.ts'
import { validateExecutionRequestV2, type ExecutionRequestV2 } from './contracts.ts'
import type { Executor } from './executor.ts'

function request(fields: Partial<ExecutionRequestV2> = {}): ExecutionRequestV2 {
  const id = randomUUID()
  return {
    version: 2, jobId: id, idempotencyKey: id, sessionId: projectExecutionKey('default', 'session', 'web:chat-fixture'), turnId: id,
    nodeId: 'child',
    projectScope: managedProjectScope('default'), operation: MANAGED_SESSION_OPERATION, args: {},
    createdAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 10_000).toISOString(), ...fields,
  }
}

test('Child allocation validates grants, scope, arguments, aborts and reserved storage boundaries', async t => {
  const { root, workspace, folders } = await folderFixture(t)
  for (const workdirId of [LEGACY_MANAGED_SERVICE_ID, 'managed-v1:reserved', 'process-execute']) {
    assert.throws(() => new ManagedChildWorkdirs(workspace, 'child', [{ workdirId, rootPath: folders }]), /Reserved/)
  }
  await assert.rejects(new ManagedChildWorkdirs(join(workspace, 'overlap'), 'child', [{ workdirId: 'parent', rootPath: workspace }]).init(), /overlap/)
  const managed = new ManagedChildWorkdirs(join(root, 'managed'), 'child', [])
  await managed.init()
  const local = new LocalExecutor(new ProcessManager(), 'child', managed.operationHandlers, (request, signal) => managed.assertCanExecute(request, signal))
  for (const fields of [
    { projectScope: undefined }, { projectScope: '../escape' }, { sessionId: '../escape' },
    { nodeId: 'child', workdirId: 'arbitrary'  }, { args: { path: folders } }, { args: { projectId: 'other' } }, { args: [] },
  ]) {
    const req = request(fields)
    if (!validateExecutionRequestV2(req).success) continue
    const events = await Array.fromAsync(local.execute(req, new AbortController().signal))
    assert.equal(events.at(-1)?.type, 'rejected')
  }
  assert.equal(validateExecutionRequestV2(request({ projectScope: '../escape' })).success, false)
  const controller = new AbortController()
  controller.abort()
  const events = await Array.fromAsync(local.execute(request(), controller.signal))
  assert.equal(events.at(-1)?.type, 'cancel-acknowledged')
  assert.deepEqual(await readdir(managed.rootPath), ['.resource-identities-v1'])
  const executor = fixtureProjectExecutor('default', local)
  const options = { projectId: 'default', sessionId: 'web:chat-fixture', nodeId: 'child', executor, signal: new AbortController().signal }
  const [first, repeated] = await Promise.all([allocateRemoteSessionWorkdir(options), allocateRemoteSessionWorkdir(options)])
  assert.deepEqual(first, repeated)
  assert.equal((await readdir(managed.rootPath)).length, 2)
  assert.equal(first.workdirId, managedSessionWorkdirId('default', options.sessionId))
  assert(!managed.workdirs.some(capability => capability.displayPath === managed.rootPath))
  const descriptor = managed.workdirs.find(capability => capability.workdirId === first.workdirId)!
  await rm(descriptor.displayPath!, { recursive: true })
  const restored = new ManagedChildWorkdirs(managed.rootPath, 'child', [])
  await restored.init()
  assert.equal(restored.workdirs.find(capability => capability.workdirId === first.workdirId)?.online, false)
  const restoredExecutor = fixtureProjectExecutor('default', new LocalExecutor(new ProcessManager(), 'child', restored.operationHandlers, (request, signal) => restored.assertCanExecute(request, signal)))
  await assert.rejects(allocateRemoteSessionWorkdir({ ...options, executor: restoredExecutor }), /could not allocate/)
  assert.equal((await readdir(join(managed.rootPath, createHash('sha256').update(first.workdirId).digest('hex')))).includes('workdir'), false)
  await symlink(folders, descriptor.displayPath!, process.platform === 'win32' ? 'junction' : 'dir')
  await writeFile(join(folders, 'private.txt'), 'must not read')
  await assert.rejects(executeRemoteFilesystemText({
    executor, nodeId: 'child', workdirId: first.workdirId, sessionId: options.sessionId,
    turnId: randomUUID(), signal: options.signal,
  }, 'filesystem.read', { path: 'private.txt' }), /replaced/)
})

test('managed allocation client rejects malformed, oversized and foreign Child results', async () => {
  const options = { projectId: 'default', sessionId: 'web:chat-fixture', nodeId: 'child', signal: new AbortController().signal }
  const valid = { version: 2, nodeId: 'child', workdirId: managedSessionWorkdirId('default', options.sessionId) }
  for (const output of [
    'not json', JSON.stringify({ ...valid, workdirId: 'static-folder' }),
    JSON.stringify({ ...valid, nodeId: 'other' }), JSON.stringify({ ...valid, folderId: 'foreign' }),
    JSON.stringify({ ...valid, workdirId: managedSessionWorkdirId('other', options.sessionId) }),
    JSON.stringify({ ...valid, displayName: 'x'.repeat(20_000) }),
  ]) {
    const executor: Executor = {
      async *execute(request) {
        yield { version: 1, jobId: request.jobId, sequence: 0, timestamp: new Date().toISOString(), type: 'stdout', chunk: output }
        yield {
          version: 1, jobId: request.jobId, sequence: 1, timestamp: new Date().toISOString(), type: 'completed',
          receipt: { version: 1, jobId: request.jobId, nodeId: 'child', state: 'completed', finishedAt: new Date().toISOString() },
        }
      },
      getStatus: async () => null,
      cancel: async () => { throw new Error('unused') },
    }
    await assert.rejects(allocateRemoteSessionWorkdir({ ...options, executor }), /invalid|unowned/)
  }
})

test('an aborted first send retains the allocated Child workdir for a stable retry', async t => {
  const { workspace } = await folderFixture(t)
  const managed = new ManagedChildWorkdirs(join(workspace, 'managed'), 'child', [])
  await managed.init()
  const reached = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  managed.onWorkdir = async () => { reached.resolve(); await release.promise }
  const executor = fixtureProjectExecutor('default', new LocalExecutor(new ProcessManager(), 'child', managed.operationHandlers, (request, signal) => managed.assertCanExecute(request, signal)))
  const controller = new AbortController()
  const options = { executor, projectId: 'default', sessionId: 'web:chat-fixture', nodeId: 'child', signal: controller.signal }
  const pending = allocateRemoteSessionWorkdir(options)
  const failed = assert.rejects(pending, /abort/i)
  await reached.promise
  controller.abort()
  release.resolve()
  await failed
  managed.onWorkdir = undefined
  const retry = await allocateRemoteSessionWorkdir({ ...options, signal: new AbortController().signal })
  assert.equal(retry.workdirId, managedSessionWorkdirId('default', options.sessionId))
  assert.equal((await readdir(managed.rootPath)).length, 2)
})

test('Child refuses an unowned reserved allocation directory rather than adopting contents', async t => {
  const { workspace } = await folderFixture(t)
  const managed = new ManagedChildWorkdirs(join(workspace, 'managed'), 'child', [])
  await managed.init()
  const local = new LocalExecutor(new ProcessManager(), 'child', managed.operationHandlers, (request, signal) => managed.assertCanExecute(request, signal))
  const executor = fixtureProjectExecutor('default', local)
  const options = { executor, projectId: 'default', sessionId: 'web:chat-fixture', nodeId: 'child', signal: new AbortController().signal }
  const workdirId = managedSessionWorkdirId(options.projectId, options.sessionId)
  const slot = createHash('sha256').update(workdirId).digest('hex')
  await mkdir(join(managed.rootPath, slot))
  await writeFile(join(managed.rootPath, slot, 'keep.txt'), 'unowned')
  await assert.rejects(allocateRemoteSessionWorkdir(options), /could not allocate/)
  assert.equal(managed.workdirs.some(capability => capability.workdirId === workdirId), false)
  assert.deepEqual(await readdir(join(managed.rootPath, slot)), ['keep.txt'])
  const reopened = new ManagedChildWorkdirs(managed.rootPath, 'child', [])
  await assert.rejects(reopened.init())
  await rm(join(managed.rootPath, slot, 'keep.txt'))
  await assert.rejects(allocateRemoteSessionWorkdir(options), /could not allocate/)
  assert.deepEqual(await readdir(join(managed.rootPath, slot)), [], 'An empty unowned slot is not adopted either')
})

function identityIndex(managed: ManagedChildWorkdirs): string {
  return join(managed.rootPath, '.resource-identities-v1', 'index.json')
}

function resourceRequest(workdirId: string): ExecutionRequestV2 {
  return request({ nodeId: 'child', workdirId, operation: 'filesystem.read', args: { path: '.' } })
}

function executorFor(managed: ManagedChildWorkdirs): LocalExecutor {
  return new LocalExecutor({ spawn: async () => assert.fail('No command may spawn') }, 'child', managed.operationHandlers,
    (request, signal) => managed.assertCanExecute(request, signal))
}

test('private identities survive restarts, root rebinding and inode replacement without disabling other resources', async t => {
  const { workspace, folders } = await folderFixture(t)
  const replaced = join(folders, 'replaced'); const stable = join(folders, 'stable')
  await mkdir(replaced); await mkdir(stable)
  const configured = [{ workdirId: 'replaced', rootPath: replaced }, { workdirId: 'stable', rootPath: stable }]
  const managed = new ManagedChildWorkdirs(join(workspace, 'managed'), 'child', configured)
  await managed.init()
  const saved = await readFile(identityIndex(managed))
  if (process.platform !== 'win32') {
    assert.equal((await lstat(identityIndex(managed))).mode & 0o777, 0o600)
    assert.equal((await lstat(join(managed.rootPath, '.resource-identities-v1'))).mode & 0o777, 0o700)
  }
  await rename(replaced, join(folders, 'original')); await mkdir(replaced)
  for (const rootPath of [replaced, stable]) {
    const restarted = new ManagedChildWorkdirs(managed.rootPath, 'child', [{ ...configured[0], rootPath }, configured[1]])
    await restarted.init()
    assert.deepEqual(restarted.workdirs.map(r => r.online), [false, true])
    assert(restarted.workdirs.filter(w => w.workdirId === 'replaced').every(w => !w.online))
    await assert.rejects(restarted.assertCanExecute(resourceRequest('replaced'), new AbortController().signal), /offline/)
    await restarted.assertCanExecute(resourceRequest('stable'), new AbortController().signal)
    assert.deepEqual(await readFile(identityIndex(managed)), saved)
  }
  const removed = new ManagedChildWorkdirs(managed.rootPath, 'child', [])
  await removed.init()
  assert.deepEqual(await readFile(identityIndex(managed)), saved, 'omitting a resource cannot erase its identity tombstone')
})

test('missing legacy directories and missing index entries cannot later become a new identity baseline', async t => {
  const { workspace, folders } = await folderFixture(t)
  const missing = join(folders, 'not-yet-present')
  const configured = [{ workdirId: 'missing', rootPath: missing }]
  const managed = new ManagedChildWorkdirs(join(workspace, 'managed'), 'child', configured)
  await managed.init()
  const snapshot = await readFile(identityIndex(managed))
  assert.equal(managed.workdirs[0].online, false)
  await mkdir(missing)
  const workdirId = managedSessionWorkdirId('default', 'late-owner')
  const directory = join(managed.rootPath, createHash('sha256').update(workdirId).digest('hex'))
  await mkdir(join(directory, 'workdir'), { recursive: true })
  await writeFile(join(directory, 'owner.json'), JSON.stringify({ version: 1, capabilityId: workdirId,
    projectScope: managedProjectScope('default'), sessionId: projectExecutionKey('default', 'session', 'late-owner') }))
  const restarted = new ManagedChildWorkdirs(managed.rootPath, 'child', configured)
  await restarted.init()
  assert(restarted.workdirs.every(r => !r.online))
  assert.deepEqual(await readFile(identityIndex(managed)), snapshot)
})

test('identity index corruption, missing files and interrupted initialization fail closed without reset', async t => {
  const { workspace, folders } = await folderFixture(t)
  const managed = new ManagedChildWorkdirs(join(workspace, 'managed'), 'child', [{ workdirId: 'configured', rootPath: folders }])
  await managed.init()
  const path = identityIndex(managed)
  const valid = JSON.parse(await readFile(path, 'utf8'))
  const record = valid.bindings[0]
  const invalidValues = [
    '{', 'null', JSON.stringify({ ...valid, version: 2 }), JSON.stringify({ ...valid, nodeId: 'foreign' }),
    JSON.stringify({ ...valid, extra: true }), JSON.stringify({ ...valid, bindings: [record, record] }),
    ...[
      { ...record, workdirId: '' }, { ...record, rootPath: '../relative' }, { ...record, unexpected: true },
      { ...record, identity: { ...record.identity, canonicalPath: 'relative' } },
      { ...record, identity: { ...record.identity, inode: -1 } },
      { ...record, identity: { ...record.identity, device: 'NaN' } },
      { ...record, identity: { ...record.identity, extra: 'field' } },
    ].map(binding => JSON.stringify({ ...valid, bindings: [binding] })),
    ' '.repeat(4 * 1024 * 1024 + 1),
  ]
  for (const invalid of invalidValues) {
    await writeFile(path, invalid)
    await assert.rejects(new ManagedChildWorkdirs(managed.rootPath, 'child', managed.staticWorkdirs).init())
    assert.equal(await readFile(path, 'utf8'), invalid)
  }
  await rm(path)
  await assert.rejects(new ManagedChildWorkdirs(managed.rootPath, 'child', managed.staticWorkdirs).init(), /ENOENT/)
  assert.deepEqual(await readdir(join(managed.rootPath, '.resource-identities-v1')), [])
  const external = join(folders, 'external-index.json'); await writeFile(external, JSON.stringify(valid))
  await symlink(external, path)
  await assert.rejects(new ManagedChildWorkdirs(managed.rootPath, 'child', managed.staticWorkdirs).init(), /identity index/)
  assert.equal((await lstat(path)).isSymbolicLink(), true)
  assert.equal(await readFile(external, 'utf8'), JSON.stringify(valid))
  const interruptedRoot = join(workspace, 'interrupted')
  await mkdir(join(interruptedRoot, '.resource-identities-v1'), { recursive: true })
  await assert.rejects(new ManagedChildWorkdirs(interruptedRoot, 'child', []).init(), /ENOENT/)
})

test('new allocations and picks persist identity before advertising and never rebind on repeat', async t => {
  const { workspace, folders } = await folderFixture(t)
  const managed = new ManagedChildWorkdirs(join(workspace, 'managed'), 'child', [])
  await managed.init()
  let advertised = 0
  managed.onWorkdir = async resource => {
    const index = JSON.parse(await readFile(identityIndex(managed), 'utf8'))
    assert(index.bindings.some((binding: { workdirId: string; identity: unknown }) => binding.workdirId === resource.workdirId && binding.identity))
    const restarted = new ManagedChildWorkdirs(managed.rootPath, 'child', [])
    await restarted.init()
    assert.equal(restarted.workdirs.find(r => r.workdirId === resource.workdirId)?.online, true)
    advertised++
  }
  const local = executorFor(managed)
  const allocation = await Array.fromAsync(local.execute(request(), new AbortController().signal))
  assert.equal(allocation.at(-1)?.type, 'completed')
  const pick = request({ operation: 'owner.folder.select', args: { path: folders } })
  assert.equal((await Array.fromAsync(local.execute(pick, new AbortController().signal))).at(-1)?.type, 'completed')
  assert.equal(advertised, 2)
  const snapshot = await readFile(identityIndex(managed))
  const pickedMetadata = await readFile(join(managed.rootPath, 'picked-folders.json'))
  const allocationPath = managed.workdirs.find(r => r.workdirId.startsWith('managed-v1:'))!.displayPath!
  await rename(allocationPath, `${allocationPath}-original`); await mkdir(allocationPath)
  await rename(folders, `${folders}-original`); await mkdir(folders)
  managed.onWorkdir = () => assert.fail('A rebound resource must not be advertised')
  assert.equal((await Array.fromAsync(local.execute(request(), new AbortController().signal))).at(-1)?.type, 'rejected')
  assert.equal((await Array.fromAsync(local.execute({ ...pick, jobId: randomUUID(), idempotencyKey: randomUUID() }, new AbortController().signal))).at(-1)?.type, 'rejected')
  const restarted = new ManagedChildWorkdirs(managed.rootPath, 'child', [])
  await restarted.init()
  assert(restarted.workdirs.every(r => !r.online))
  assert.deepEqual(await readFile(identityIndex(managed)), snapshot)
  assert.deepEqual(await readFile(join(managed.rootPath, 'picked-folders.json')), pickedMetadata)
})

test('index loss during allocation or picking cannot reset prior identities or advertise unverified resources', async t => {
  const { workspace, folders } = await folderFixture(t)
  const managed = new ManagedChildWorkdirs(join(workspace, 'managed'), 'child', [])
  await managed.init()
  await rm(identityIndex(managed))
  managed.onWorkdir = () => assert.fail('Identity persistence must precede advertisement')
  const local = executorFor(managed)
  for (const req of [request(), request({ operation: 'owner.folder.select', args: { path: folders } })]) {
    assert.equal((await Array.fromAsync(local.execute(req, new AbortController().signal))).at(-1)?.type, 'rejected')
  }
  assert.deepEqual(managed.workdirs, [])
  await assert.rejects(readFile(identityIndex(managed)), /ENOENT/)
  await assert.rejects(readFile(join(managed.rootPath, 'picked-folders.json')), /ENOENT/)
  await assert.rejects(new ManagedChildWorkdirs(managed.rootPath, 'child', []).init(), /ENOENT/)
})

test('a removed allocation retains its identity tombstone and cannot be allocated anew', async t => {
  const { workspace } = await folderFixture(t)
  const managed = new ManagedChildWorkdirs(join(workspace, 'managed'), 'child', [])
  await managed.init()
  assert.equal((await Array.fromAsync(executorFor(managed).execute(request(), new AbortController().signal))).at(-1)?.type, 'completed')
  const workdirId = managed.workdirs[0].workdirId
  const slotPath = join(managed.rootPath, createHash('sha256').update(workdirId).digest('hex'))
  const snapshot = await readFile(identityIndex(managed))
  await rm(slotPath, { recursive: true })
  const restarted = new ManagedChildWorkdirs(managed.rootPath, 'child', [])
  await restarted.init()
  assert.deepEqual(restarted.workdirs, [])
  assert.equal((await Array.fromAsync(executorFor(restarted).execute(request(), new AbortController().signal))).at(-1)?.type, 'rejected')
  await assert.rejects(lstat(slotPath), /ENOENT/)
  assert.deepEqual(await readFile(identityIndex(managed)), snapshot)
})
