import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, readFile, rename, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { ExecutionRequestV2, JobEventV1 } from '../execution/contracts.ts'
import type { Executor } from '../execution/executor.ts'
import { managedProjectScope } from '../execution/managed-workdir.ts'
import { DERIVED_WORKSPACE_OPERATION, type DerivedWorkspaceResult } from '../execution/derived-workspace-contract.ts'
import { executeChildDerivedWorkspace } from '../execution/child-derived-workspace.ts'
import { CapabilityWorkdirIdentity } from '../execution/capability-workdir-identity.ts'
import { LocalExecutor } from '../execution/local-executor.ts'
import { ProcessManager } from '../execution/processes/manager.ts'
import type { WorkdirAdvertisement } from '../execution/workdir-contracts.ts'
import { ProjectExecutor, DIRECTORY_OPERATIONS } from '../projects/executor.ts'
import { ProjectCatalog } from '../projects/catalog.ts'
import { isolationGit as git } from '../cron/work-isolation.ts'
import { DerivedWorkspaces } from './derived-workspace.ts'
import { FolderRegistry } from './registry.ts'
import { RemoteFolderOwnership } from './remote-ownership.ts'
import type { FolderRecord, RemoteFolderRecord } from './contracts.ts'
import { MAX_DERIVED_WORKSPACE_RESULT_BYTES, RemoteDerivedWorkspaceBackend } from './remote-derived-workspace.ts'
import { folderFixture } from './test-fixtures.ts'

const signal = new AbortController().signal
const scope = managedProjectScope('project-a')
const source: RemoteFolderRecord = { kind: 'remote', id: 'source-folder', projectId: 'project-a', name: 'Source',
  path: 'Z:\\private\\source', createdAt: new Date(0).toISOString(), workdir: { version: 2, nodeId: 'child', workdirId: 'source' },
  identity: { version: 1, rootId: 'a'.repeat(64), ancestorIds: [] } }
function result(): DerivedWorkspaceResult {
  return { version: 1, nodeId: 'child', sourceWorkdirId: 'source',
    workdir: { version: 2, nodeId: 'child', workdirId: 'derived', displayName: 'Derived', displayPath: 'Z:\\private\\derived', online: true,
      support: { operations: ['workdir.identity', DERIVED_WORKSPACE_OPERATION] } },
    receipt: { backend: 'git-worktree', projectId: scope, sourceId: 'source', sourcePath: source.path, commonDir: 'Z:\\private\\source\\.git',
      commonIdentity: '1:2', path: 'Z:\\private\\derived', branch: 'shadow-derived-12345678-1234-1234-1234-123456789012', baseBranch: 'refs/heads/main',
      baseCommit: 'a'.repeat(40), description: 'Worktree', workspaceId: 'derived' } }
}
function stream(request: ExecutionRequestV2, output: unknown): JobEventV1[] {
  const base = { version: 1 as const, jobId: request.jobId, timestamp: request.createdAt }
  return [{ ...base, sequence: 0, type: 'accepted' }, { ...base, sequence: 1, type: 'stdout', chunk: JSON.stringify(output) },
    { ...base, sequence: 2, type: 'completed', receipt: { version: 1, jobId: request.jobId, nodeId: request.nodeId, state: 'completed', finishedAt: request.createdAt } }]
}
function executor(events: (request: ExecutionRequestV2) => JobEventV1[]): Executor {
  return { async *execute(request) { yield* events(request) }, getStatus: async () => null, cancel: async () => { throw new Error('No retry/cancel') } }
}

test('Main client checks strict wire, opaque Windows display paths, Project/source/target identities and exact folder profile', async () => {
  const requests: ExecutionRequestV2[] = []
  const backend = new RemoteDerivedWorkspaceBackend({ projectId: 'project-a', executor: new ProjectExecutor('project-a', executor(request => {
    requests.push(request)
    return stream(request, (request.args as { action: string }).action === 'inspect'
      ? { version: 1, nodeId: 'child', sourceWorkdirId: 'source', branch: 'main' } : result())
  }), request => {
    assert.equal(request.sessionId, 'folder:source-folder')
    assert.equal(request.operation, DERIVED_WORKSPACE_OPERATION)
    assert.equal(request.nodeId, 'child'); assert.equal(request.workdirId, 'source')
  }) })
  assert.deepEqual(await backend.inspectSource(source, signal), { branch: 'main' })
  assert.equal((await backend.create(source, { key: 'key', branch: 'main' }, signal)).receipt.path, 'Z:\\private\\derived')
  await backend.verify(source, 'key', signal)
  assert.equal(requests.length, 3)
  assert.ok(requests.every(request => request.projectScope === scope))
  await assert.rejects(backend.inspectSource({ ...source, projectId: 'foreign' }, signal), /outside/)
  for (const mutate of [
    (v: any) => { v.extra = true }, (v: any) => { v.nodeId = 'other' }, (v: any) => { v.sourceWorkdirId = v.receipt.sourceId = 'other' },
    (v: any) => { v.receipt.projectId = managedProjectScope('foreign') }, (v: any) => { v.receipt.extra = true },
    (v: any) => { v.workdir.extra = true }, (v: any) => { v.receipt.workspaceId = 'different' },
    (v: any) => { v.workdir.nodeId = 'different' }, (v: any) => { v.workdir.online = false },
    (v: any) => { v.workdir.workdirId = v.receipt.workspaceId = 'source' }, (v: any) => { v.receipt.workKey = 'foreign-work' },
  ]) {
    const value = result(); mutate(value)
    const invalid = new RemoteDerivedWorkspaceBackend({ projectId: 'project-a', executor: executor(request => stream(request, value)) })
    await assert.rejects(invalid.verify(source, 'key', signal))
  }
  const invalidInspect = new RemoteDerivedWorkspaceBackend({ projectId: 'project-a', executor: executor(request => stream(request,
    { version: 1, nodeId: 'other', sourceWorkdirId: 'source', branch: 'main' })) })
  await assert.rejects(invalidInspect.inspectSource(source, signal), /identity mismatch/)
})

test('Main client bounds output and rejects missing, failed, malformed, duplicate or uncorrelated terminals without replay', async () => {
  const invalidStreams = [
    (events: JobEventV1[]) => events.slice(0, -1),
    (events: JobEventV1[]) => [...events, { ...events[1], sequence: 3 }],
    (events: JobEventV1[]) => { events[1].jobId = 'foreign'; return events },
    (events: JobEventV1[]) => { events[1].sequence = 0; return events },
    (events: JobEventV1[]) => { (events[1] as any).type = 'stderr'; return events },
    (events: JobEventV1[]) => { (events[1] as any).chunk = 'x'.repeat(MAX_DERIVED_WORKSPACE_RESULT_BYTES + 1); return events },
    (events: JobEventV1[]) => { (events[2] as any).receipt.nodeId = 'other'; return events },
    (events: JobEventV1[]) => { (events[2] as any).receipt.jobId = 'other'; return events },
    (events: JobEventV1[]) => { (events[2] as any).receipt.state = 'failed'; return events },
    (events: JobEventV1[]) => { (events[2] as any).type = 'cancel-acknowledged'; return events },
    (events: JobEventV1[]) => { (events[2] as any).receipt.exitCode = 1; return events },
    (events: JobEventV1[]) => { (events[2] as any).receipt.reason = { code: 'unknown', message: 'lost', retryable: true }; return events },
    (events: JobEventV1[]) => { (events[2] as any).type = 'failed'; (events[2] as any).receipt.state = 'failed'; return events },
  ]
  for (const mutate of invalidStreams) {
    let calls = 0
    const backend = new RemoteDerivedWorkspaceBackend({ projectId: 'project-a', executor: executor(request => { calls++; return mutate(stream(request, result())) }) })
    await assert.rejects(backend.create(source, { key: 'saved-key', branch: 'main' }, signal))
    assert.equal(calls, 1)
  }
})

test('Main retained remote state survives restart, rejects local/source key collisions and verifies binding without recreating missing resources', async t => {
  const { root } = await folderFixture(t)
  const records = new Map<string, FolderRecord>([[source.id, source]])
  let creates = 0, verifies = 0, registers = 0, missing = false, altered = false
  const remote = {
    inspectSource: async () => ({ branch: 'main' }),
    create: async () => { creates++; return result() },
    verify: async () => { verifies++; if (missing) throw new Error('Child missing'); const value = result(); if (altered) value.receipt.commonIdentity = '5:6'; return value },
  }
  const options = { projectId: 'project-a', directory: join(root, 'state'), remote, validateWork: (key: string) => assert.equal(key, 'work:one'), folders: {
    list: () => [...records.values()], acquireAccess: () => () => {},
    requireExecutionAvailable: async (id: string) => { const folder = records.get(id); if (!folder) throw new Error('Registration missing'); return folder },
    register: async () => { throw new Error('No Main registration') }, reserveDestination: async () => { throw new Error('No Main destination') },
    registerRemote: async (ref: any) => { registers++; const folder: RemoteFolderRecord = { ...source, id: 'main-derived', workdir: ref }; records.set(folder.id, folder); return folder },
  } }
  const request = { source: source.id, branch: 'main', workKey: 'work:one', idempotencyKey: 'stable' }
  const first = await new DerivedWorkspaces(options).createDerivedWorkspace(request, signal)
  assert.equal(first.projectId, 'project-a'); assert.equal(first.sourceId, source.id); assert.equal(first.workspaceId, 'main-derived')
  assert.equal(first.workKey, 'work:one'); assert.equal(first.remote?.workdirId, 'derived')
  const restarted = new DerivedWorkspaces(options)
  assert.deepEqual(await restarted.retained('stable'), first)
  await restarted.verify(first, signal)
  assert.deepEqual(await restarted.createDerivedWorkspace(request, signal), first)
  assert.equal(creates, 1); assert.equal(registers, 1); assert.equal(verifies, 2)
  const secondSource = { ...source, id: 'other-source', workdir: { ...source.workdir, workdirId: 'other' } }
  records.set(secondSource.id, secondSource)
  await assert.rejects(restarted.createDerivedWorkspace({ ...request, source: secondSource.id }, signal), /conflict/)
  records.set(source.id, { ...source, workdir: { ...source.workdir, nodeId: 'other-child' } })
  await assert.rejects(restarted.createDerivedWorkspace(request, signal), /conflict/)
  records.set(source.id, { ...source, projectId: 'foreign' })
  await assert.rejects(restarted.verify(first, signal), /source identity mismatch/)
  records.set(source.id, source)
  const file = join(options.directory, `${createHash('sha256').update('stable').digest('hex')}.json`)
  const saved = await readFile(file, 'utf8')
  await writeFile(file, JSON.stringify({ fingerprint: JSON.parse(saved).fingerprint, phase: 'registered', receipt: { ...first, remote: undefined } }))
  await assert.rejects(restarted.createDerivedWorkspace(request, signal), /conflict/)
  await writeFile(file, saved)
  altered = true
  await assert.rejects(restarted.verify(first, signal), /identity mismatch/)
  altered = false; missing = true
  await assert.rejects(restarted.verify(first, signal), /Child missing/)
  await assert.rejects(restarted.createDerivedWorkspace(request, signal), /Child missing/)
  missing = false; records.delete('main-derived')
  await assert.rejects(restarted.verify(first, signal), /Registration missing/)
  await assert.rejects(restarted.createDerivedWorkspace(request, signal), /Registration missing/)
  assert.equal(creates, 1); assert.equal(registers, 1)
  await assert.rejects(new DerivedWorkspaces({ ...options, projectId: 'foreign' }).retained('stable'), /identity/)
})

test('unknown create persists source intent, never auto-replays and permits only explicit same-key recovery', async t => {
  const { root } = await folderFixture(t)
  let calls = 0
  let records = [source]
  const service = new DerivedWorkspaces({ projectId: 'project-a', directory: root, validateWork: () => {},
    remote: { inspectSource: async () => ({ branch: 'main' }), create: async () => { calls++; throw new Error('remote-node-unavailable unknown') }, verify: async () => { throw new Error('No saved receipt') } },
    folders: { list: () => records, acquireAccess: () => () => {}, requireExecutionAvailable: async id => records.find(folder => folder.id === id)!,
      reserveDestination: async () => { throw new Error('No fallback') }, register: async () => { throw new Error('No fallback') }, registerRemote: async () => { throw new Error('No registration') } } })
  const request = { source: source.id, branch: 'main', idempotencyKey: 'unknown' }
  await assert.rejects(service.createDerivedWorkspace(request, signal), /unknown.*Recovery idempotencyKey: unknown/)
  assert.equal(calls, 1); assert.equal(await service.retained('unknown'), undefined)
  records = [{ ...source, workdir: { ...source.workdir, nodeId: 'other' } }]
  await assert.rejects(service.createDerivedWorkspace(request, signal), /conflict/)
  assert.equal(calls, 1)
  records = [source]
  await assert.rejects(service.createDerivedWorkspace(request, signal), /unknown/)
  assert.equal(calls, 2, 'Only the explicit same-key call may reach Child again')
})

test('Main ProjectExecutor -> LocalExecutor -> real Child derivation registers exact remote workdir and verifies after Main restart', async t => {
  const { root, workspace, folders } = await folderFixture(t)
  const childRoot = join(root, 'child'); await mkdir(childRoot)
  const repo = join(folders, 'repo'); await mkdir(repo)
  await git(repo, ['init', '-b', 'main'], signal)
  await git(repo, ['config', 'user.name', 'Fixture'], signal); await git(repo, ['config', 'user.email', 'fixture@example.invalid'], signal)
  await writeFile(join(repo, 'tracked'), 'first'); await git(repo, ['add', '.'], signal); await git(repo, ['commit', '-m', 'first'], signal)
  await writeFile(join(repo, 'untracked'), 'preserve source')
  const paths = new Map([['source', repo]])
  const ads = new Map<string, WorkdirAdvertisement>()
  const ad = (workdirId: string, path: string): WorkdirAdvertisement => ({ version: 2, nodeId: 'child', workdirId, displayName: workdirId, displayPath: path, online: true,
    support: { operations: [DERIVED_WORKSPACE_OPERATION, 'workdir.identity'] } })
  ads.set('source', ad('source', repo))
  let creates = 0, verifies = 0
  const local = new LocalExecutor(new ProcessManager(), 'child', [{
    handles: operation => operation === DERIVED_WORKSPACE_OPERATION || operation === 'workdir.identity',
    execute: async (request, s) => {
      const bindings = [...paths].map(([workdirId, rootPath]) => ({ workdirId, rootPath }))
      if (request.operation === 'workdir.identity') return new CapabilityWorkdirIdentity(bindings).execute(request, s)
      const action = (request.args as { action: string }).action
      if (action === 'create') creates++; if (action === 'verify') verifies++
      return JSON.stringify(await executeChildDerivedWorkspace({ root: childRoot, nodeId: 'child', projectScope: request.projectScope!,
        source: { workdirId: request.workdirId!, rootPath: paths.get(request.workdirId!)! }, args: request.args,
        assertSource: async () => { assert.ok(paths.has(request.workdirId!)) },
        register: async path => {
          const existing = [...paths].find(([, rootPath]) => rootPath === path)
          const id = existing?.[0] ?? `picked-${paths.size}`
          paths.set(id, path); const resource = ad(id, path); ads.set(id, resource); return resource
        }, describe: async id => { const resource = ads.get(id); if (!resource) throw new Error('Missing advertisement'); return resource },
      }, s))
    },
  }], request => { assert.ok(DIRECTORY_OPERATIONS.includes(request.operation)); assert.ok(paths.has(request.workdirId!)) })
  const catalog = new ProjectCatalog(join(root, 'host')); await catalog.init()
  const registry = new FolderRegistry(workspace, { catalog, projectId: 'default' }); await registry.init()
  const scoped = new ProjectExecutor('default', local, request => {
    assert.ok(DIRECTORY_OPERATIONS.includes(request.operation))
    if (request.operation === DERIVED_WORKSPACE_OPERATION) {
      const folder = registry.list().find(folder => request.sessionId === `folder:${folder.id}`)
      assert.ok(folder?.kind === 'remote' && folder.workdir.nodeId === request.nodeId && folder.workdir.workdirId === request.workdirId)
    }
  })
  registry.configureRemote(new RemoteFolderOwnership({ projectId: 'default', catalog, executor: scoped,
    lookup: ref => ({ node: 'online', ...(ads.has(ref.workdirId) ? { workdir: { online: true } } : {}) }), workdir: ref => ads.get(ref.workdirId) }))
  const sourceFolder = await registry.registerRemote({ version: 2, nodeId: 'child', workdirId: 'source' }, signal)
  const backend = new RemoteDerivedWorkspaceBackend({ projectId: 'default', executor: scoped })
  assert.deepEqual(await backend.inspectSource(sourceFolder, signal), { branch: 'main' })
  const options = { projectId: 'default', directory: join(root, 'main-derived'), folders: registry, remote: backend, validateWork: () => {} }
  const receipt = await new DerivedWorkspaces(options).createDerivedWorkspace({ source: sourceFolder.id, branch: 'main', idempotencyKey: 'real' }, signal)
  assert.equal(receipt.projectId, 'default'); assert.equal(receipt.sourceId, sourceFolder.id)
  const registered = registry.get(receipt.workspaceId)
  assert.ok(registered?.kind === 'remote'); assert.equal(registered.workdir.workdirId, receipt.remote?.workdirId)
  assert.equal(await readFile(join(repo, 'untracked'), 'utf8'), 'preserve source')
  assert.equal(await git(receipt.path, ['rev-parse', 'HEAD'], signal), receipt.baseCommit)
  const reloadedCatalog = new ProjectCatalog(join(root, 'host')); await reloadedCatalog.init()
  const reloadedRegistry = new FolderRegistry(workspace, { catalog: reloadedCatalog, projectId: 'default' }); await reloadedRegistry.init()
  const reloadedExecutor = new ProjectExecutor('default', local, request => {
    assert.ok(DIRECTORY_OPERATIONS.includes(request.operation))
    if (request.operation === DERIVED_WORKSPACE_OPERATION) {
      const folder = reloadedRegistry.list().find(folder => request.sessionId === `folder:${folder.id}`)
      assert.ok(folder?.kind === 'remote' && folder.workdir.nodeId === request.nodeId && folder.workdir.workdirId === request.workdirId)
    }
  })
  reloadedRegistry.configureRemote(new RemoteFolderOwnership({ projectId: 'default', catalog: reloadedCatalog, executor: reloadedExecutor,
    lookup: ref => ({ node: 'online', ...(ads.has(ref.workdirId) ? { workdir: { online: true } } : {}) }), workdir: ref => ads.get(ref.workdirId) }))
  const restarted = new DerivedWorkspaces({ ...options, folders: reloadedRegistry,
    remote: new RemoteDerivedWorkspaceBackend({ projectId: 'default', executor: reloadedExecutor }) })
  assert.deepEqual(await restarted.retained('real'), receipt); await restarted.verify(receipt, signal)
  const replay = await restarted.createDerivedWorkspace({ source: sourceFolder.id, branch: 'main', idempotencyKey: 'real' }, signal)
  assert.deepEqual(replay, receipt); assert.equal(creates, 1); assert.equal(verifies, 2)
  await rename(receipt.path, `${receipt.path}-retained`)
  await assert.rejects(restarted.verify(receipt, signal), /did not complete/)
  await assert.rejects(restarted.createDerivedWorkspace({ source: sourceFolder.id, branch: 'main', idempotencyKey: 'real' }, signal), /did not complete/)
  assert.equal(creates, 1)
  assert.equal((await readdir(folders)).some(name => join(folders, name) === receipt.path), false)
})


test('local and remote creation share the idempotency namespace but never switch a retained key across backends', async t => {
  const { root, workspace, folders } = await folderFixture(t)
  const repo = join(folders, 'repo'); await mkdir(repo)
  await git(repo, ['init', '-b', 'main'], signal)
  await git(repo, ['config', 'user.name', 'Fixture'], signal); await git(repo, ['config', 'user.email', 'fixture@example.invalid'], signal)
  await writeFile(join(repo, 'tracked'), 'first'); await git(repo, ['add', '.'], signal); await git(repo, ['commit', '-m', 'first'], signal)
  const registry = new FolderRegistry(workspace); await registry.init(); const local = await registry.register(repo)
  let creates = 0
  const options = { projectId: 'project-a', directory: join(root, 'state'), validateWork: () => {},
    remote: { inspectSource: async () => ({ branch: 'main' }), create: async () => { creates++; return result() }, verify: async () => result() },
    folders: {
      list: () => [...registry.list(), source], acquireAccess: () => registry.acquireAccess(),
      requireExecutionAvailable: async (id: string, s?: AbortSignal) => id === source.id ? source : registry.requireExecutionAvailable(id, s),
      register: registry.register.bind(registry), reserveDestination: registry.reserveDestination.bind(registry),
      registerRemote: async (ref: any) => ({ ...source, id: 'main-derived', workdir: ref }),
    } }
  const service = new DerivedWorkspaces(options)
  await service.createDerivedWorkspace({ source: source.id, branch: 'main', idempotencyKey: 'remote-first' }, signal)
  await assert.rejects(service.createDerivedWorkspace({ source: local.id, branch: 'main', idempotencyKey: 'remote-first' }, signal), /conflict/)
  await service.createDerivedWorkspace({ source: local.id, branch: 'main', idempotencyKey: 'local-first' }, signal)
  await assert.rejects(service.createDerivedWorkspace({ source: source.id, branch: 'main', idempotencyKey: 'local-first' }, signal), /conflict/)
  assert.equal(creates, 1)
})
