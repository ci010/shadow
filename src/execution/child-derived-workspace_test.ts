import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { isolationGit as git } from '../cron/work-isolation.ts'
import { folderFixture } from '../folders/test-fixtures.ts'
import { ManagedChildWorkdirs } from './managed-child-workdirs.ts'
import { DERIVED_WORKSPACE_DIRECTORY } from './child-derived-workspace.ts'
import { DERIVED_WORKSPACE_OPERATION, parseDerivedWorkspaceInspectResult, parseDerivedWorkspaceResult } from './derived-workspace-contract.ts'
import { LocalExecutor } from './local-executor.ts'
import type { ExecutionRequestV2 } from './contracts.ts'
import { managedProjectScope, projectExecutionKey } from './managed-workdir.ts'

const signal = new AbortController().signal
function request(args: unknown, fields: Partial<ExecutionRequestV2> = {}): ExecutionRequestV2 {
  const id = randomUUID()
  return { version: 2, jobId: id, idempotencyKey: id, sessionId: projectExecutionKey('default', 'session', 'fixture'), turnId: id,
    nodeId: 'child', workdirId: 'repo', projectScope: managedProjectScope('default'), operation: DERIVED_WORKSPACE_OPERATION,
    args, createdAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 30_000).toISOString(), ...fields }
}
function executor(managed: ManagedChildWorkdirs) {
  return new LocalExecutor({ spawn: async () => assert.fail('No shell execution expected') }, 'child', managed.operationHandlers, (r, s) => managed.assertCanExecute(r, s))
}
async function execute(managed: ManagedChildWorkdirs, args: unknown, fields: Partial<ExecutionRequestV2> = {}): Promise<unknown> {
  const events = await Array.fromAsync(executor(managed).execute(request(args, fields), signal))
  const last = events.at(-1)!
  if (last.type !== 'completed') throw new Error(JSON.stringify(last))
  return JSON.parse(events.filter(e => e.type === 'stdout').map(e => e.type === 'stdout' ? e.chunk : '').join(''))
}
async function fixture(t: TestContext) {
  const { root, folders, workspace } = await folderFixture(t)
  const source = join(folders, 'repo with spaces 原生路径')
  await mkdir(source)
  await git(source, ['init', '-b', 'main'], signal)
  await git(source, ['config', 'user.name', 'Fixture'], signal)
  await git(source, ['config', 'user.email', 'fixture@example.invalid'], signal)
  await writeFile(join(source, 'tracked'), 'first')
  await git(source, ['add', '.'], signal); await git(source, ['commit', '-m', 'first'], signal)
  const configured = [{ workdirId: 'repo', rootPath: source }]
  const managed = new ManagedChildWorkdirs(join(workspace, 'managed'), 'child', configured)
  await managed.init()
  return { root, source, configured, managed }
}

test('Child inspect/create is a real independent worktree with durable picked identity and awaited advertisement; source dirt is preserved', async t => {
  const { source, configured, managed } = await fixture(t)
  const branch = parseDerivedWorkspaceInspectResult(await execute(managed, { action: 'inspect' }))
  assert.equal(branch.branch, 'main'); assert.equal(branch.sourceWorkdirId, 'repo')
  const commit = await git(source, ['rev-parse', 'HEAD'], signal)
  await writeFile(join(source, 'tracked'), 'staged'); await git(source, ['add', '.'], signal)
  await writeFile(join(source, 'tracked'), 'dirty'); await writeFile(join(source, 'untracked'), 'private')
  const index = await readFile(join(source, '.git', 'index'))
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let announced = 0
  managed.onWorkdir = async descriptor => {
    const identities = JSON.parse(await readFile(join(managed.rootPath, '.resource-identities-v1', 'index.json'), 'utf8'))
    assert(identities.bindings.some((b: { workdirId: string }) => b.workdirId === descriptor.workdirId))
    assert(managed.workdirs.some(w => w.workdirId === descriptor.workdirId))
    announced++; entered.resolve(); await release.promise
  }
  let outputReceived = false
  const args = { action: 'create', key: 'stable', branch: 'main', description: 'Child task', name: 'native-name' }
  const pending = execute(managed, args).then(value => { outputReceived = true; return value })
  await entered.promise
  assert.equal(outputReceived, false, 'operation output must wait for advertisement')
  release.resolve()
  const created = parseDerivedWorkspaceResult(await pending)
  managed.onWorkdir = undefined
  assert.equal(announced, 1)
  assert.equal(created.workdir.platform, process.platform)
  assert(managed.workdirs.every(workdir => workdir.platform === process.platform))
  assert.equal(created.receipt.projectId, managedProjectScope('default'))
  assert.equal(created.receipt.sourceId, 'repo')
  assert.equal(created.receipt.workspaceId, created.workdir.workdirId)
  assert.match(created.workdir.workdirId, /^picked-v1:[0-9a-f]{64}$/)
  assert.equal(await git(created.receipt.path, ['rev-parse', 'HEAD'], signal), commit)
  assert.notEqual(created.receipt.branch, 'main')
  assert.equal(await readFile(join(created.receipt.path, 'tracked'), 'utf8'), 'first')
  await assert.rejects(readFile(join(created.receipt.path, 'untracked')))
  assert.equal(await git(source, ['symbolic-ref', '--short', 'HEAD'], signal), 'main')
  assert.equal(await readFile(join(source, 'tracked'), 'utf8'), 'dirty')
  assert.equal(await readFile(join(source, 'untracked'), 'utf8'), 'private')
  assert.deepEqual(await readFile(join(source, '.git', 'index')), index)
  const [a, b] = await Promise.all([execute(managed, args), execute(managed, args)])
  assert.deepEqual(a, created); assert.deepEqual(b, created)
  await assert.rejects(execute(managed, { ...args, branch: 'other' }), /conflict/)
  await writeFile(join(created.receipt.path, 'tracked'), 'retained user edits')
  const restarted = new ManagedChildWorkdirs(managed.rootPath, 'child', configured)
  await restarted.init()
  assert.deepEqual(await execute(restarted, { action: 'verify', key: 'stable' }), created)
  assert.equal(await readFile(join(created.receipt.path, 'tracked'), 'utf8'), 'retained user edits')
  assert(!restarted.workdirs.some(w => w.displayPath?.includes(DERIVED_WORKSPACE_DIRECTORY)))
})

test('Child receipt keys are separated by host Project scope; foreign source identity and unknown scope cannot recover them', async t => {
  const { source, managed } = await fixture(t)
  const args = { action: 'create', key: 'same-key', branch: 'main' }
  const a = parseDerivedWorkspaceResult(await execute(managed, args))
  const b = parseDerivedWorkspaceResult(await execute(managed, args, { projectScope: managedProjectScope('other') }))
  assert.notEqual(a.receipt.path, b.receipt.path)
  assert.notEqual(a.workdir.workdirId, b.workdir.workdirId)
  assert.equal(b.receipt.projectId, managedProjectScope('other'))
  assert.deepEqual(await execute(managed, { action: 'verify', key: 'same-key' }), a)
  assert.deepEqual(await execute(managed, { action: 'verify', key: 'same-key' }, { projectScope: managedProjectScope('other') }), b)
  await assert.rejects(execute(managed, { action: 'verify', key: 'same-key' }, { workdirId: a.workdir.workdirId }), /matching registered/)
  await assert.rejects(execute(managed, args, { workdirId: a.workdir.workdirId }), /conflict/)
  const scoped = join(managed.rootPath, DERIVED_WORKSPACE_DIRECTORY, managedProjectScope('default'))
  const records = await readdir(scoped)
  await assert.rejects(execute(managed, { action: 'verify', key: 'unknown' }), /matching registered/)
  assert.deepEqual(await readdir(scoped), records, 'unknown verify keys cannot write receipts or locks')
  const before = await readdir(join(managed.rootPath, DERIVED_WORKSPACE_DIRECTORY))
  await assert.rejects(execute(managed, { action: 'verify', key: 'same-key' }, { projectScope: managedProjectScope('unrelated') }), /ENOENT/)
  assert.deepEqual(await readdir(join(managed.rootPath, DERIVED_WORKSPACE_DIRECTORY)), before, 'verify cannot create scope metadata')
  const alias = new ManagedChildWorkdirs(managed.rootPath, 'child', [{ workdirId: 'alias', rootPath: source }])
  await alias.init()
  await assert.rejects(execute(alias, { action: 'verify', key: 'same-key' }, { workdirId: 'alias' }), /offline/)
})

test('missing registered targets are never recreated by verify or idempotent create, including after restart', async t => {
  const { managed, configured } = await fixture(t)
  const args = { action: 'create', key: 'missing', branch: 'main' }
  const created = parseDerivedWorkspaceResult(await execute(managed, args))
  await rm(created.receipt.path, { recursive: true })
  const restarted = new ManagedChildWorkdirs(managed.rootPath, 'child', configured)
  await restarted.init()
  assert.equal(restarted.workdirs.find(w => w.workdirId === created.workdir.workdirId)?.online, false)
  await assert.rejects(execute(restarted, { action: 'verify', key: 'missing' }), /ENOENT|unavailable/)
  await assert.rejects(execute(restarted, args), /missing; refusing to recreate/)
  await assert.rejects(lstat(created.receipt.path), /ENOENT/)
})

test('verify rejects retargeted target branches, symlinks and replaced Git identity without mutation', async t => {
  const { source, managed } = await fixture(t)
  const a = parseDerivedWorkspaceResult(await execute(managed, { action: 'create', key: 'branch', branch: 'main' }))
  await writeFile(join(a.receipt.path, 'tracked'), 'keep my changes')
  await git(a.receipt.path, ['symbolic-ref', 'HEAD', 'refs/heads/main'], signal)
  await assert.rejects(execute(managed, { action: 'verify', key: 'branch' }), /identity mismatch/)
  assert.equal(await readFile(join(a.receipt.path, 'tracked'), 'utf8'), 'keep my changes')
  const b = parseDerivedWorkspaceResult(await execute(managed, { action: 'create', key: 'link', branch: 'main' }))
  await rename(b.receipt.path, `${b.receipt.path}-kept`)
  await symlink(source, b.receipt.path, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(execute(managed, { action: 'verify', key: 'link' }), /replaced|identity|unavailable/)
  assert((await lstat(b.receipt.path)).isSymbolicLink())
  const c = parseDerivedWorkspaceResult(await execute(managed, { action: 'create', key: 'source-git', branch: 'main' }))
  await rename(join(source, '.git'), join(source, '.git-kept'))
  await git(source, ['init', '-b', 'main'], signal)
  await assert.rejects(execute(managed, { action: 'verify', key: 'source-git' }), /source repository identity mismatch/)
  assert.equal(await readFile(join(c.receipt.path, 'tracked'), 'utf8'), 'first')
})

test('inspect requires a bound Git repository root and symbolic branch; strict args are rejected before metadata side effects', async t => {
  const { source, managed } = await fixture(t)
  for (const args of [{ action: 'inspect', source: source }, { action: 'create', key: 'k', branch: 'main', path: source }, { action: 'verify', key: 'k', projectScope: 'foreign' }]) {
    await assert.rejects(execute(managed, args), /Unknown derived workspace field/)
  }
  assert.deepEqual(await readdir(managed.rootPath), ['.resource-identities-v1'])
  await git(source, ['checkout', '--detach'], signal)
  await assert.rejects(execute(managed, { action: 'inspect' }), /symbolic-ref/)
  const sub = join(source, 'sub'); await mkdir(sub)
  const nested = new ManagedChildWorkdirs(join(managed.rootPath, '..', 'nested-metadata'), 'child', [{ workdirId: 'repo', rootPath: sub }])
  await nested.init()
  await assert.rejects(execute(nested, { action: 'inspect' }), /repository root/)
  assert.deepEqual(await readdir(nested.rootPath), ['.resource-identities-v1'])
})

test('reserved receipt metadata validates on restart and cannot become a path capability or follow a replaced scope directory', async t => {
  const { managed, configured, root } = await fixture(t)
  const created = parseDerivedWorkspaceResult(await execute(managed, { action: 'create', key: 'stable', branch: 'main' }))
  const directory = join(managed.rootPath, DERIVED_WORKSPACE_DIRECTORY)
  const scope = join(directory, managedProjectScope('default'))
  const file = join(scope, `${createHash('sha256').update('stable').digest('hex')}.json`)
  const retained = JSON.parse(await readFile(file, 'utf8'))
  await writeFile(file, JSON.stringify({ ...retained, receipt: { ...retained.receipt, projectId: managedProjectScope('foreign') } }))
  await assert.rejects(execute(managed, { action: 'verify', key: 'stable' }), /matching registered/)
  await writeFile(file, JSON.stringify(retained))
  await rename(scope, join(root, 'kept-receipts'))
  await symlink(join(root, 'kept-receipts'), scope, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(execute(managed, { action: 'verify', key: 'stable' }), /metadata directory/)
  await assert.rejects(new ManagedChildWorkdirs(managed.rootPath, 'child', configured).init(), /metadata directory/)
  assert.equal(await readFile(join(created.receipt.path, 'tracked'), 'utf8'), 'first')
})


test('Windows paired-depth receipt paths beyond MAX_PATH retain SQLite locking and restart verification', { skip: process.platform !== 'win32' }, async t => {
  const { root, source, configured } = await fixture(t)
  const managedRoot = join(root, 'managed-session-workdirs-v1', 'a'.repeat(64))
  const key = 'paired-depth-windows'
  const lockPath = join(managedRoot, DERIVED_WORKSPACE_DIRECTORY, managedProjectScope('default'),
    createHash('sha256').update(key).digest('hex') + '.json.lock.sqlite')
  assert(lockPath.length > 260, 'fixture must reproduce the real paired Child path depth')
  const managed = new ManagedChildWorkdirs(managedRoot, 'child', configured)
  await managed.init()
  const created = parseDerivedWorkspaceResult(await execute(managed, { action: 'create', key, branch: 'main' }))
  assert.equal(await readFile(join(created.receipt.path, 'tracked'), 'utf8'), 'first')
  assert((await lstat(lockPath)).isFile())
  const restarted = new ManagedChildWorkdirs(managedRoot, 'child', configured)
  await restarted.init()
  assert.deepEqual(await execute(restarted, { action: 'verify', key }), created)
  assert.equal(await git(source, ['symbolic-ref', '--short', 'HEAD'], signal), 'main')
})
