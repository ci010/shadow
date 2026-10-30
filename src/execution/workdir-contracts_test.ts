import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { withTempWorkspace } from '../testing/workspace.ts'
import { ManagedChildWorkdirs } from './managed-child-workdirs.ts'
import { LocalExecutor } from './local-executor.ts'
import { JournaledShellExecutor, ShellJournal } from './shell-journal.ts'
import { validateExecutionReceiptV1, validateExecutionRequestV2, validateJobEventV1, validateJobRequestV2, type ExecutionRequestV2 } from './contracts.ts'
import { assertExecutionProtocol, assertExecutionSupported, validateExecutionSupport, validateWorkdirAdvertisement, type WorkdirAdvertisement, type ExecutionSupport } from './workdir-contracts.ts'
import { managedWorkdirForScope, managedProjectScope, projectExecutionKey } from './managed-workdir.ts'

const support: ExecutionSupport = { operations: ['workdir.process.execute-once', 'workdir.process.reconcile'], shell: { shells: ['sh'], maxInputBytes: 32768, maxDeadlineMs: 120000 } }
const resource: WorkdirAdvertisement = { version: 2, nodeId: 'child', workdirId: 'directory', displayName: 'Directory', online: true, support }
function request(overrides: Partial<ExecutionRequestV2> = {}): ExecutionRequestV2 {
  return { version: 2, jobId: 'job', idempotencyKey: 'execution-key', sessionId: 'session', turnId: 'turn', nodeId: 'child', workdirId: 'directory', projectScope: managedProjectScope('project'), operation: 'workdir.process.execute-once', args: { script: 'echo never' }, createdAt: '2026-01-01T00:00:00.000Z', deadlineAt: '2026-01-01T00:01:00.000Z', ...overrides }
}

test('domain and wire parsers reject unknown fields, operations, legacy execution and unscoped wire jobs', () => {
  assert(validateWorkdirAdvertisement(resource).success)
  assert(validateExecutionSupport(support).success)
  for (const value of [{ ...support, permissions: [] }, { ...support, conditions: { version: 1, sandbox: true } }, { ...support, conditions: { version: 1, maxInputBytes: Infinity } }, { ...support, operations: ['future.execute'] }, { ...support, operations: ['process.execute'] }, { ...support, scope: { kind: 'node' } }]) assert.equal(validateExecutionSupport(value, 'workdir').success, false)
  assert.equal(validateWorkdirAdvertisement({ ...resource, rootPath: '/private' }).success, false)
  assert(validateJobRequestV2(request()).success)
  assert(validateExecutionRequestV2({ ...request(), projectScope: undefined }).success)
  for (const value of [{ ...request(), version: 1 }, { ...request(), capabilityId: 'directory' }, { ...request(), projectScope: undefined }, { ...request(), nodeId: 'child', workdirId: 'directory', capabilityId: 'fake' }]) assert.equal(validateJobRequestV2(value).success, false)
})

test('live directory and support checks deny before admission without substitution; shell limits are shell-only', () => {
  assertExecutionSupported(request(), [resource], { operations: [] })
  for (const operation of support.operations) {
    for (const workdirs of [[], [{ ...resource, online: false }], [{ ...resource, workdirId: 'other' }], [{ ...resource, support: { operations: [] } }]]) assert.throws(() => assertExecutionSupported(request({ operation }), workdirs, { operations: [] }))
    for (const args of [{ script: 'echo no', shell: 'cmd' }, { script: 'x'.repeat(40000) }]) assert.throws(() => assertExecutionSupported(request({ operation, args }), [resource], { operations: [] }), /shell support limits/)
    assert.throws(() => assertExecutionSupported(request({ operation, deadlineAt: '2026-01-01T00:03:00.000Z' }), [resource], { operations: [] }), /shell support limits/)
  }
  assertExecutionSupported(request({ operation: 'filesystem.write', args: { content: 'x'.repeat(40000) } }), [{ ...resource, support: { ...support, operations: ['filesystem.write'] } }], { operations: [] })
  assert.throws(() => assertExecutionSupported(request({ operation: 'future.execute' }), [resource], { operations: [] }), /Unsupported/)
  for (const features of [undefined, [], ['jobs-v1', 'capabilities-v1'], ['resource-execution-v2']]) assert.throws(() => assertExecutionProtocol(features), /Upgrade both Main and Child/)
})

test('Child checks ownership, rebound roots and conditions before any durable journal claim or spawn', async () => {
  await withTempWorkspace(async root => {
    const directory = join(root, 'directory')
    await mkdir(directory)
    const workdirs = new ManagedChildWorkdirs(join(root, 'managed'), 'child', [{ workdirId: 'directory', rootPath: directory }])
    await workdirs.init()
    const journal = new ShellJournal(join(root, 'journal'))
    let spawns = 0
    const local = new LocalExecutor({ spawn: async () => { spawns++; throw new Error('must not spawn') } }, 'child', workdirs.operationHandlers, (request, signal) => workdirs.assertCanExecute(request, signal))
    const executor = new JournaledShellExecutor(local, journal)
    const now = Date.now()
    const base = request({ createdAt: new Date(now).toISOString(), deadlineAt: new Date(now + 10000).toISOString() })
    for (const args of [{ script: 'echo no', cwd: '../outside' }, { script: 'x'.repeat(40000) }, { script: 'echo no', shell: 'unsupported-shell' }, { script: 'echo no', cwd: 'missing' }]) {
      const events = await Array.fromAsync(executor.execute({ ...base, args }, new AbortController().signal))
      assert.equal(events.at(-1)?.type, 'rejected')
    }
    await rename(directory, join(root, 'old-directory')); await mkdir(directory)
    const rebound = await Array.fromAsync(executor.execute(base, new AbortController().signal))
    assert.equal(rebound.at(-1)?.type, 'rejected')
    assert.equal(spawns, 0)
    assert.equal((await readdir(root)).includes('journal'), false)
  })
})

test('legacy managed ownership and picked metadata read without rewrite, retain IDs and reject cross-Project reconcile before claim', async () => {
  await withTempWorkspace(async root => {
    const metadataRoot = join(root, 'managed'); await mkdir(metadataRoot)
    const scope = managedProjectScope('owner')
    const sessionId = projectExecutionKey('owner', 'session', 'session')
    const workdirId = managedWorkdirForScope(scope, sessionId)
    const slot = createHash('sha256').update(workdirId).digest('hex')
    await mkdir(join(metadataRoot, slot, 'workdir'), { recursive: true })
    const ownerPath = join(metadataRoot, slot, 'owner.json')
    const legacy = JSON.stringify({ version: 1, capabilityId: workdirId, projectScope: scope, sessionId }, null, 2).replaceAll('\n', '\r\n') + '\r\n'
    await writeFile(ownerPath, legacy)
    const pickedPath = join(root, 'picked'); await mkdir(pickedPath)
    const pickedId = `picked-v1:${createHash('sha256').update(pickedPath).digest('hex')}`
    const picked = JSON.stringify([{ capabilityId: pickedId, path: pickedPath }], null, 2) + '\r\n'
    await writeFile(join(metadataRoot, 'picked-folders.json'), picked)
    const managed = new ManagedChildWorkdirs(metadataRoot, 'child', []); await managed.init()
    assert.deepEqual(managed.workdirs.map(r => r.workdirId).sort(), [pickedId, workdirId].sort())
    assert.equal(await readFile(ownerPath, 'utf8'), legacy)
    assert.equal(await readFile(join(metadataRoot, 'picked-folders.json'), 'utf8'), picked)
    const restarted = new ManagedChildWorkdirs(metadataRoot, 'child', []); await restarted.init()
    assert(restarted.workdirs.every(r => r.online))
    assert.deepEqual(await readFile(ownerPath), Buffer.from(legacy))
    assert.deepEqual(await readFile(join(metadataRoot, 'picked-folders.json')), Buffer.from(picked))
    const journal = new ShellJournal(join(root, 'journal'))
    const local = new LocalExecutor({ spawn: async () => assert.fail('No spawn') }, 'child', managed.operationHandlers, (request, signal) => managed.assertCanExecute(request, signal))
    const executor = new JournaledShellExecutor(local, journal)
    const events = await Array.fromAsync(executor.execute(request({ operation: 'workdir.process.reconcile', nodeId: 'child', workdirId, projectScope: managedProjectScope('foreign') }), new AbortController().signal))
    const terminal = events.at(-1)!
    assert('receipt' in terminal)
    assert.equal(terminal.receipt.reason?.code, 'project-access-denied')
    assert.equal((await readdir(root)).includes('journal'), false)
  })
})

for (const savedVersion of [1, 2]) test(`V${savedVersion} shell journal reconciliation normalizes identity without rerun or admission record rewrite`, async () => {
  await withTempWorkspace(async root => {
    const journal = new ShellJournal(root)
    const current = request()
    const slot = createHash('sha256').update(current.idempotencyKey).digest('hex')
    await mkdir(join(root, slot))
    const legacy = { version: 1, jobId: 'old-job', idempotencyKey: current.idempotencyKey, sessionId: current.sessionId, turnId: current.turnId, nodeId: 'child', capabilityId: 'directory', operation: current.operation, args: current.args, createdAt: current.createdAt, deadlineAt: current.deadlineAt }
    const { nodeId, capabilityId, ...rest } = legacy
    const serialized = JSON.stringify(savedVersion === 1 ? legacy : { ...rest, version: 2, projectScope: current.projectScope, target: { kind: 'resource', nodeId, resourceId: capabilityId } })
    await writeFile(join(root, slot, 'request.json'), serialized)
    const receipt = { version: 1, jobId: 'old-job', nodeId: 'child', state: 'completed', finishedAt: current.deadlineAt, exitCode: 0 }
    const terminalContents = JSON.stringify({ version: 1, outcome: 'known', events: [{ version: 1, jobId: 'old-job', sequence: 0, timestamp: current.deadlineAt, type: 'completed', receipt }] }, null, 2) + '\r\n'
    await writeFile(join(root, slot, 'terminal.json'), terminalContents)
    const executor = new JournaledShellExecutor({
      async assertCanExecute() {},
      async *execute() { assert.fail('V1 journal replay must not spawn or execute') },
      async getStatus() { return null }, async cancel() { throw new Error('unused') },
    }, journal)
    for (const operation of ['workdir.process.reconcile', 'workdir.process.execute-once']) {
      const events = await Array.fromAsync(executor.execute({ ...current, operation }, new AbortController().signal))
      const terminal = events.at(-1)!
      assert('receipt' in terminal)
      assert.equal(terminal.receipt.jobId, current.jobId)
      assert.equal(terminal.receipt.reconciledJobId, 'old-job')
      assert.equal(validateJobEventV1(terminal).success, true)
      assert.deepEqual(await readFile(join(root, slot, 'request.json')), Buffer.from(serialized))
      assert.deepEqual(await readFile(join(root, slot, 'terminal.json')), Buffer.from(terminalContents))
    }
    assert.equal((await journal.reconcile(current)).outcome, 'known')
    assert.equal(await journal.claim(current), false)
    assert.equal(await readFile(join(root, slot, 'request.json'), 'utf8'), serialized)
    await assert.rejects(journal.reconcile({ ...current, nodeId: 'child', workdirId: 'other' }), /identity/)
  })
})

test('receipt parser permits only a nonempty correlated journal job marker', () => {
  const receipt = { version: 1, jobId: 'query-job', nodeId: 'child', state: 'completed', finishedAt: '2026-01-01T00:00:00.000Z', exitCode: 0 }
  assert.equal(validateExecutionReceiptV1(receipt).success, true)
  assert.equal(validateExecutionReceiptV1({ ...receipt, reconciledJobId: 'original-job' }).success, true)
  for (const reconciledJobId of ['', null, 123, {}, []]) {
    assert.equal(validateExecutionReceiptV1({ ...receipt, reconciledJobId }).success, false)
  }
  assert.equal(validateExecutionReceiptV1({ ...receipt, reconciledJobId: 'original-job', journalVerified: true }).success, false)
})


test('established intermediate identity index reads resourceId in place without rebaseline or rewrite', async () => {
  await withTempWorkspace(async root => {
    const directory = join(root, 'directory')
    await mkdir(directory)
    const storage = join(root, 'managed')
    const managed = new ManagedChildWorkdirs(storage, 'child', [{ workdirId: 'original', rootPath: directory }])
    await managed.init()
    const path = join(storage, '.resource-identities-v1', 'index.json')
    const saved = JSON.parse(await readFile(path, 'utf8'))
    saved.bindings = saved.bindings.map(({ workdirId, ...binding }: { workdirId: string }) => ({ ...binding, resourceId: workdirId }))
    const bytes = JSON.stringify(saved, null, 2) + '\r\n'
    await writeFile(path, bytes)
    const restored = new ManagedChildWorkdirs(storage, 'child', [{ workdirId: 'original', rootPath: directory }])
    await restored.init()
    assert.equal(restored.workdirs[0].online, true)
    assert.equal(await readFile(path, 'utf8'), bytes)
    await rename(directory, join(root, 'original-directory'))
    await mkdir(directory)
    const replaced = new ManagedChildWorkdirs(storage, 'child', [{ workdirId: 'original', rootPath: directory }])
    await replaced.init()
    assert.equal(replaced.workdirs[0].online, false)
    assert.equal(await readFile(path, 'utf8'), bytes)
  })
})
