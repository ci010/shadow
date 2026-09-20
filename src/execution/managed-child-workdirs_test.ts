import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { folderFixture } from '../folders/test-fixtures.ts'
import { ManagedChildWorkdirs } from './managed-child-workdirs.ts'
import { LocalExecutor } from './local-executor.ts'
import { ProcessManager } from './processes/manager.ts'
import { ProjectExecutor } from '../projects/executor.ts'
import { allocateRemoteSessionWorkdir } from './remote-managed-workdir-client.ts'
import { managedProjectScope, managedSessionCapability, MANAGED_SESSION_CAPABILITY, MANAGED_SESSION_OPERATION, projectExecutionKey } from './managed-workdir.ts'
import { executeRemoteFilesystemText } from './remote-filesystem-client.ts'
import { validateJobRequestV1, type JobRequestV1 } from './contracts.ts'
import type { Executor } from './executor.ts'

function request(fields: Partial<JobRequestV1> = {}): JobRequestV1 {
  const id = randomUUID()
  return {
    version: 1, jobId: id, idempotencyKey: id, sessionId: projectExecutionKey('default', 'session', 'web:chat-fixture'), turnId: id,
    managedProject: managedProjectScope('default'), nodeId: 'child',
    capabilityId: MANAGED_SESSION_CAPABILITY, operation: MANAGED_SESSION_OPERATION, args: {},
    createdAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 10_000).toISOString(), ...fields,
  }
}

test('Child allocation validates grants, scope, arguments, aborts and reserved storage boundaries', async t => {
  const { root, workspace, folders } = await folderFixture(t)
  for (const capabilityId of [MANAGED_SESSION_CAPABILITY, 'managed-v1:reserved', 'process-execute']) {
    assert.throws(() => new ManagedChildWorkdirs(workspace, 'child', [{ capabilityId, rootPath: folders }]), /Reserved/)
  }
  await assert.rejects(new ManagedChildWorkdirs(join(workspace, 'overlap'), 'child', [{ capabilityId: 'parent', rootPath: workspace }]).init(), /overlap/)
  const managed = new ManagedChildWorkdirs(join(root, 'managed'), 'child', [])
  await managed.init()
  const local = new LocalExecutor(new ProcessManager(), 'child', managed.operationHandlers, [])
  for (const fields of [
    { managedProject: undefined }, { managedProject: '../escape' }, { sessionId: '../escape' },
    { capabilityId: 'arbitrary' }, { args: { path: folders } }, { args: { projectId: 'other' } }, { args: [] },
  ]) {
    const req = request(fields)
    if (!validateJobRequestV1(req).success) continue
    const events = await Array.fromAsync(local.execute(req, new AbortController().signal))
    assert.equal(events.at(-1)?.type, 'rejected')
  }
  assert.equal(validateJobRequestV1(request({ managedProject: '../escape' })).success, false)
  const controller = new AbortController()
  controller.abort()
  const events = await Array.fromAsync(local.execute(request(), controller.signal))
  assert.equal(events.at(-1)?.type, 'cancel-acknowledged')
  assert.deepEqual(await readdir(managed.rootPath), [])
  const executor = new ProjectExecutor('default', local)
  const options = { projectId: 'default', sessionId: 'web:chat-fixture', nodeId: 'child', executor, signal: new AbortController().signal }
  const [first, repeated] = await Promise.all([allocateRemoteSessionWorkdir(options), allocateRemoteSessionWorkdir(options)])
  assert.deepEqual(first, repeated)
  assert.equal((await readdir(managed.rootPath)).length, 1)
  assert.equal(first.capabilityId, managedSessionCapability('default', options.sessionId))
  assert(!managed.capabilities.some(capability => capability.kind === 'workdir' && capability.displayPath === managed.rootPath))
  const descriptor = managed.capabilities.find(capability => capability.capabilityId === first.capabilityId)!
  await rm(descriptor.displayPath!, { recursive: true })
  const restored = new ManagedChildWorkdirs(managed.rootPath, 'child', [])
  await restored.init()
  assert.equal(restored.capabilities.find(capability => capability.capabilityId === first.capabilityId)?.online, false)
  const restoredExecutor = new ProjectExecutor('default', new LocalExecutor(new ProcessManager(), 'child', restored.operationHandlers, []))
  await assert.rejects(allocateRemoteSessionWorkdir({ ...options, executor: restoredExecutor }), /could not allocate/)
  assert.equal((await readdir(join(managed.rootPath, (await readdir(managed.rootPath))[0]))).includes('workdir'), false)
  await symlink(folders, descriptor.displayPath!, process.platform === 'win32' ? 'junction' : 'dir')
  await writeFile(join(folders, 'private.txt'), 'must not read')
  await assert.rejects(executeRemoteFilesystemText({
    executor, nodeId: 'child', capabilityId: first.capabilityId, sessionId: options.sessionId,
    turnId: randomUUID(), signal: options.signal,
  }, 'filesystem.read', { path: 'private.txt' }), /replaced/)
})

test('managed allocation client rejects malformed, oversized and foreign Child results', async () => {
  const options = { projectId: 'default', sessionId: 'web:chat-fixture', nodeId: 'child', signal: new AbortController().signal }
  const valid = { version: 1, nodeId: 'child', capabilityId: managedSessionCapability('default', options.sessionId) }
  for (const output of [
    'not json', JSON.stringify({ ...valid, capabilityId: 'static-folder' }),
    JSON.stringify({ ...valid, nodeId: 'other' }), JSON.stringify({ ...valid, folderId: 'foreign' }),
    JSON.stringify({ ...valid, capabilityId: managedSessionCapability('other', options.sessionId) }),
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
  managed.onCapability = async () => { reached.resolve(); await release.promise }
  const executor = new ProjectExecutor('default', new LocalExecutor(new ProcessManager(), 'child', managed.operationHandlers, []))
  const controller = new AbortController()
  const options = { executor, projectId: 'default', sessionId: 'web:chat-fixture', nodeId: 'child', signal: controller.signal }
  const pending = allocateRemoteSessionWorkdir(options)
  const failed = assert.rejects(pending, /abort/i)
  await reached.promise
  controller.abort()
  release.resolve()
  await failed
  managed.onCapability = undefined
  const retry = await allocateRemoteSessionWorkdir({ ...options, signal: new AbortController().signal })
  assert.equal(retry.capabilityId, managedSessionCapability('default', options.sessionId))
  assert.equal((await readdir(managed.rootPath)).length, 1)
})

test('Child refuses an unowned reserved allocation directory rather than adopting contents', async t => {
  const { workspace } = await folderFixture(t)
  const managed = new ManagedChildWorkdirs(join(workspace, 'managed'), 'child', [])
  await managed.init()
  const local = new LocalExecutor(new ProcessManager(), 'child', managed.operationHandlers, [])
  const executor = new ProjectExecutor('default', local)
  const options = { executor, projectId: 'default', sessionId: 'web:chat-fixture', nodeId: 'child', signal: new AbortController().signal }
  const capabilityId = managedSessionCapability(options.projectId, options.sessionId)
  const slot = createHash('sha256').update(capabilityId).digest('hex')
  await mkdir(join(managed.rootPath, slot))
  await writeFile(join(managed.rootPath, slot, 'keep.txt'), 'unowned')
  await assert.rejects(allocateRemoteSessionWorkdir(options), /could not allocate/)
  assert.equal(managed.capabilities.some(capability => capability.capabilityId === capabilityId), false)
  assert.deepEqual(await readdir(join(managed.rootPath, slot)), ['keep.txt'])
  const reopened = new ManagedChildWorkdirs(managed.rootPath, 'child', [])
  await assert.rejects(reopened.init())
})
