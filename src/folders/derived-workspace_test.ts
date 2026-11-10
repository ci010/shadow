import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { DatabaseSync } from 'node:sqlite'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { DerivedWorkspaces } from './derived-workspace.ts'
import { FolderRegistry } from './registry.ts'
import { ProjectCatalog } from '../projects/catalog.ts'
import { WorkspaceCreateTool } from '../tools/workspace-create.ts'
import { Tools, SessionTools } from '../tools/registry.ts'
import type { ExecutionContext } from '../tools/context.ts'
import { isolationGit as git } from '../cron/work-isolation.ts'
const signal = new AbortController().signal

test('beside worktree, fixed commit, registered descriptions, retry and source preservation', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'shadow-derived-'))
  try {
    const source = join(temporary, 'repo'), home = join(temporary, 'home')
    await mkdir(source); await mkdir(home)
    await git(source, ['init', '-b', 'main'], signal)
    await git(source, ['config', 'user.name', 'Fixture'], signal)
    await git(source, ['config', 'user.email', 'fixture@example.invalid'], signal)
    await writeFile(join(source, 'tracked'), 'first')
    await git(source, ['add', '.'], signal); await git(source, ['commit', '-m', 'first'], signal)
    const first = await git(source, ['rev-parse', 'HEAD'], signal)
    await git(source, ['branch', 'older'], signal)
    // Existing user prefix refs must not block generated worktree branches.
    await git(source, ['branch', 'shadow'], signal)
    await git(source, ['branch', 'shadow-derived'], signal)
    await writeFile(join(source, 'tracked'), 'second'); await git(source, ['commit', '-am', 'second'], signal)
    await writeFile(join(source, 'tracked'), 'staged'); await git(source, ['add', '.'], signal)
    await writeFile(join(source, 'tracked'), 'dirty'); await writeFile(join(source, 'untracked'), 'private')
    const index = await readFile(join(source, '.git', 'index')), head = await git(source, ['rev-parse', 'HEAD'], signal)
    const catalog = new ProjectCatalog(join(temporary, 'host')); await catalog.init()
    const folders = new FolderRegistry(home, { catalog, projectId: 'default' }); await folders.init()
    const registered = await folders.register(source)
    let fail = true
    const service = new DerivedWorkspaces({ projectId: 'default', directory: join(home, 'derived'), validateWork: key => assert.equal(key, 'work:one'), folders: {
      list: () => folders.list(), requireExecutionAvailable: (id, s) => folders.requireExecutionAvailable(id, s), acquireAccess: () => folders.acquireAccess(), reserveDestination: p => folders.reserveDestination(p),
      register: async (...args) => { if (fail) { fail = false; throw new Error('registration unavailable') }; return folders.register(...args) },
    } })
    const request = { source: registered.id, branch: 'older', description: 'My task', workKey: 'work:one', idempotencyKey: 'stable' }
    await assert.rejects(service.createDerivedWorkspace(request, signal), /registration unavailable/)
    const retained = await service.retained('stable'); assert.ok(retained)
    const result = await service.createDerivedWorkspace(request, signal)
    assert.equal(result.path, retained.path); assert.equal(result.baseCommit, first)
    assert.match(result.branch, /^shadow-derived-[0-9a-f-]{36}$/)
    assert.equal(await git(source, ['rev-parse', 'refs/heads/shadow'], signal), first)
    assert.equal(await git(source, ['rev-parse', 'refs/heads/shadow-derived'], signal), first)
    assert.equal(await git(result.path, ['rev-parse', 'HEAD'], signal), first)
    assert.equal(dirname(result.path), await realpath(temporary))
    assert.match(result.description, /My task\nGit worktree from .*repo.*older.*Work work:one/)
    assert.equal(folders.get(result.workspaceId)?.description, result.description)
    const [a, b] = await Promise.all([service.createDerivedWorkspace(request, signal), service.createDerivedWorkspace(request, signal)])
    assert.equal(a.workspaceId, b.workspaceId)
    const tool = new WorkspaceCreateTool(service, 'default', id => id === 'owner')
    const context: ExecutionContext = { projectId: 'default', sessionId: 'owner', physicalSessionId: 'owner', channel: 'web', chatId: 'fixture', senderId: 'owner', messageId: 'test', tools: new SessionTools(new Tools(home), home), signal }
    assert.equal(JSON.parse(await tool.execute(request, context)).workspaceId, result.workspaceId)
    await assert.rejects(tool.execute(request, { ...context, projectId: 'foreign' }), /unavailable/)
    await assert.rejects(tool.execute(request, { ...context, sessionId: 'executor' }), /unavailable/)
    await assert.rejects(tool.execute({ ...request, sessionId: 'victim' }, context), /Invalid workspace creation parameters/)
    assert.equal(context.sessionId, 'owner')
    const defaultDescription = await service.createDerivedWorkspace({ source: registered.id, branch: 'refs/heads/main', idempotencyKey: 'default' }, signal)
    assert.match(defaultDescription.description, /Git worktree from .*repo.*refs\/heads\/main/)
    await git(source, ['update-ref', 'refs/remotes/origin/older', first], signal)
    const remoteRef = await service.createDerivedWorkspace({ source: registered.id, branch: 'origin/older', idempotencyKey: 'remote-ref' }, signal)
    assert.equal(remoteRef.baseCommit, first)
    const nested = await service.createDerivedWorkspace({ source: result.workspaceId, branch: 'older', idempotencyKey: 'from-worktree' }, signal)
    assert.equal(nested.commonDir, result.commonDir)
    assert.equal(dirname(nested.path), dirname(result.path))
    let previous = nested
    for (let generation = 0; generation < 3; generation++) {
      const next = await service.createDerivedWorkspace({ source: previous.workspaceId, branch: 'older', idempotencyKey: `bounded-lineage-${generation}` }, signal)
      assert(Array.from(basename(next.path)).length <= 86, 'derived source names must not grow with each scheduling generation')
      assert.equal(next.baseCommit, first)
      await service.verify(next, signal)
      previous = next
    }
    await assert.rejects(service.createDerivedWorkspace({ ...request, workKey: 'missing' }, signal))
    await assert.rejects(service.createDerivedWorkspace({ ...request, branch: 'main' }, signal), /conflict/)
    await assert.rejects(service.createDerivedWorkspace({ ...request, source }, signal))
    await assert.rejects(service.createDerivedWorkspace({ ...request, name: '../escape' }, signal))
    await assert.rejects(service.createDerivedWorkspace({ ...request, branch: 'main~1' }, signal))
    assert.equal(await git(source, ['rev-parse', 'HEAD'], signal), head)
    assert.deepEqual(await readFile(join(source, '.git', 'index')), index)
    assert.equal(await readFile(join(source, 'tracked'), 'utf8'), 'dirty')
    assert.equal(await readFile(join(source, 'untracked'), 'utf8'), 'private')
    await assert.rejects(readFile(join(result.path, 'untracked')))
    const journal = join(home, 'derived', `${createHash('sha256').update('stable').digest('hex')}.json`)
    const saved = await readFile(journal, 'utf8')
    await writeFile(journal, JSON.stringify({ ...JSON.parse(saved), phase: 'planned' }))
    await assert.rejects(service.createDerivedWorkspace(request, signal), /unknown completion/)
    await writeFile(journal, saved)
    const foreign = await catalog.create('Foreign')
    const foreignPath = join(temporary, 'foreign'); await mkdir(foreignPath)
    const foreignFolder = await catalog.registerFolder(foreign.id, foreignPath)
    await assert.rejects(service.createDerivedWorkspace({ ...request, source: foreignFolder.id }, signal))
    await rename(source, `${source}-retained`); await mkdir(source)
    await git(source, ['init', '-b', 'main'], signal)
    await assert.rejects(service.verify(result, signal), /source repository identity mismatch/)
    await rm(source, { recursive: true }); await rename(`${source}-retained`, source)
  } finally { await rm(temporary, { recursive: true, force: true }) }
})

test('remote sources fail closed without Git or Main path fallback', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'shadow-derived-remote-'))
  try {
    const folders = { list: () => [{ id: 'remote', name: 'remote', kind: 'remote' as const, identity: { version: 1 as const, rootId: 'a'.repeat(64), ancestorIds: [] }, path: '/not-a-main-path', createdAt: new Date().toISOString(), workdir: { version: 2 as const, nodeId: 'child', workdirId: 'remote-workdir' } }],
      requireExecutionAvailable: async () => folders.list()[0]!, acquireAccess: () => () => {}, reserveDestination: async () => () => {}, register: async () => { throw new Error('must not register') } }
    const service = new DerivedWorkspaces({ projectId: 'test', directory: temporary, folders, validateWork: () => {} })
    await assert.rejects(service.createDerivedWorkspace({ source: 'remote', branch: 'main' }, signal), /Remote workspace creation is unsupported.*Recovery idempotencyKey:/)
  } finally { await rm(temporary, { recursive: true, force: true }) }
})

test('creation admission OS lock releases after abrupt host death', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'shadow-derived-lock-'))
  const file = join(temporary, 'creation.lock.sqlite')
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(process.argv[1]); db.exec('BEGIN IMMEDIATE'); console.log('locked'); setInterval(() => {}, 1000)`, file], { stdio: ['ignore', 'pipe', 'pipe'] })
  let db: DatabaseSync | undefined
  try {
    await once(child.stdout, 'data')
    db = new DatabaseSync(file)
    assert.throws(() => db!.exec('BEGIN IMMEDIATE'), /locked/)
    const stopped = once(child, 'exit'); child.kill('SIGKILL'); await stopped
    db.exec('BEGIN IMMEDIATE'); db.exec('ROLLBACK')
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const stopped = once(child, 'exit'); child.kill('SIGKILL'); await stopped }
    db?.close(); await rm(temporary, { recursive: true, force: true })
  }
})
