import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, lstat, readFile, symlink, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { isolationGit as git } from '../cron/work-isolation.ts'
import { ProjectCatalog } from '../projects/catalog.ts'
import { FolderRegistry } from './registry.ts'
import { removeDerivedWorktree } from './remove-worktree.ts'
import { WorkspaceRemoveTool } from '../tools/workspace-remove.ts'
import type { ExecutionContext } from '../tools/context.ts'
const signal = new AbortController().signal

test('safe disk removal, retained branch, owner gates, admission exclusion and durable unregister', async t => {
  const root = await mkdtemp(join(process.cwd(), '.remove-worktree-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'repo'), home = join(root, 'host')
  await mkdir(source)
  await git(source, ['init', '-b', 'main'], signal)
  await git(source, ['config', 'user.name', 'Fixture'], signal)
  await git(source, ['config', 'user.email', 'fixture@example.invalid'], signal)
  await writeFile(join(source, 'tracked'), 'first')
  await writeFile(join(source, '.gitignore'), 'ignored\n')
  await git(source, ['add', '.'], signal); await git(source, ['commit', '-m', 'first'], signal)
  const catalog = new ProjectCatalog(home); await catalog.init()
  const registry = new FolderRegistry(home, { catalog, projectId: 'default' }); await registry.init()
  const parent = await registry.register(source)
  let counter = 0
  const derive = async () => {
    const path = join(root, `derived-${++counter}`)
    await git(source, ['worktree', 'add', '-b', `derived-${counter}`, path, 'main'], signal)
    const folder = await registry.register(path)
    await registry.recordLineage(folder.id, { version: 1, parentId: parent.id, backend: 'git-worktree', ownership: 'shadow-derived' })
    return registry.get(folder.id)!
  }
  let referenced = false, verifyExclusion = false, exclusionObserved = false
  catalog.configureFolderLifecycle('default', {
    assertIdle: () => {}, invalidate: () => { registry.acquireAccess()() },
    sessionsToRetire: () => ['inactive-history'],
    assertRemovalIdle: () => {
      if (referenced) throw new Error('Active conversation reference')
      if (verifyExclusion) queueMicrotask(() => {
        assert.throws(() => registry.acquireAccess(), /removal in progress/)
        assert.throws(() => registry.assertSessionFolder({}), /removal in progress/)
        catalog.acquireFolderAccess(foreign.id)()
        exclusionObserved = true
      })
    },
  })
  const tool = new WorkspaceRemoveTool(catalog, 'default', id => id === 'web:owner')
  const context = { projectId: 'default', sessionId: 'web:owner', channel: 'web', inputSource: 'user', admin: true, soleDirectToolCall: true, signal } as ExecutionContext
  const folder = await derive()
  const args = { workspaceId: folder.id, integratedRef: 'refs/heads/main' }
  for (const patch of [{ projectId: 'foreign' }, { sessionId: 'web:other' }, { inputSource: 'automation' }, { admin: false }, { scriptInvocation: true }, { soleDirectToolCall: false }, { recoveringToolCall: true }, { layerfsWorkdir: {} }, { remoteWorkdir: {} }]) await assert.rejects(tool.execute(args, { ...context, ...patch } as ExecutionContext), /unavailable/)
  await assert.rejects(tool.execute({ ...args, force: true }, context), /Expected only/)
  await assert.rejects(tool.execute({ ...args, workspaceId: folder.path }, context), /Expected only/)
  await assert.rejects(tool.execute({ ...args, integratedRef: 'HEAD' }, context), /explicit/)
  await assert.rejects(tool.execute({ ...args, integratedRef: 'refs/heads/main~1' }, context))
  const foreign = await catalog.create('Foreign')
  await assert.rejects(catalog.removeWorktree(foreign.id, folder.id, args.integratedRef, context.sessionId, signal), /not found/)
  const releaseReservation = await registry.reserveDestination(join(folder.path, 'reserved'))
  await assert.rejects(tool.execute(args, context), /Active or uncertain/); releaseReservation()
  catalog.recordRemoteJob('default', 'pending-removal-fixture', true)
  await assert.rejects(tool.execute(args, context), /Active or uncertain/)
  catalog.recordRemoteJob('default', 'pending-removal-fixture', false)
  const release = registry.acquireAccess()
  await assert.rejects(tool.execute(args, context), /Active or uncertain/); release()
  referenced = true
  await assert.rejects(tool.execute(args, context), /conversation reference/); referenced = false
  for (const [file, contents] of [['tracked', 'modified'], ['new', 'untracked'], ['ignored', 'ignored secret bytes']]) {
    await writeFile(join(folder.path, file!), contents!)
    await assert.rejects(tool.execute(args, context), /tracked, untracked, ignored/)
    assert.equal(await readFile(join(folder.path, file!), 'utf8'), contents)
    registry.acquireAccess()()
    if (file === 'tracked') await git(folder.path, ['restore', 'tracked'], signal)
    else await rm(join(folder.path, file!))
  }
  await writeFile(join(folder.path, 'tracked'), 'unique')
  await git(folder.path, ['commit', '-am', 'unique'], signal)
  await assert.rejects(tool.execute(args, context))
  assert.ok(registry.get(folder.id))
  await git(source, ['merge', '--ff-only', 'derived-1'], signal)
  await git(folder.path, ['update-index', '--skip-worktree', 'tracked'], signal)
  await assert.rejects(tool.execute(args, context), /Nonstandard index/)
  await git(folder.path, ['update-index', '--no-skip-worktree', 'tracked'], signal)
  await git(source, ['worktree', 'lock', folder.path], signal)
  await assert.rejects(tool.execute(args, context), /registration retained/)
  registry.acquireAccess()()
  assert.ok(registry.get(folder.id))
  await git(source, ['worktree', 'unlock', folder.path], signal)
  verifyExclusion = true
  const result = JSON.parse(await tool.execute(args, context))
  assert.equal(exclusionObserved, true)
  assert.equal(result.diskRemoved, true); assert.equal(result.unregistered, true)
  assert.equal(result.branchRetained, 'refs/heads/derived-1')
  assert.equal(registry.get(folder.id), undefined)
  assert.equal(catalog.isRetiredSession('default', 'inactive-history'), true)
  assert.throws(() => registry.assertSessionFolder({ sessionId: 'inactive-history', folderId: folder.id }), /removed or moved/)
  await assert.rejects(lstat(folder.path), { code: 'ENOENT' })
  await git(source, ['show-ref', '--verify', 'refs/heads/derived-1'], signal)
  registry.acquireAccess()()
  const reloaded = new ProjectCatalog(home); await reloaded.init()
  assert.ok(!reloaded.folders('default').some(item => item.id === folder.id))
  await assert.rejects(tool.execute(args, context), /not found/)

  const second = await derive()
  await assert.rejects(removeDerivedWorktree({ ...parent, lineage: { version: 1, parentId: second.id, backend: 'git-worktree', ownership: 'shadow-derived' } }, second, 'refs/heads/main', signal), /primary checkouts/)
  await assert.rejects(removeDerivedWorktree({ ...second, kind: 'remote' } as never, parent, 'refs/heads/main', signal), /Only local/)
  await assert.rejects(removeDerivedWorktree({ ...second, kind: 'layerfs' } as never, parent, 'refs/heads/main', signal), /Only local/)
  await assert.rejects(removeDerivedWorktree({ ...second, lineage: undefined }, parent, 'refs/heads/main', signal), /lineage/)
  const link = join(root, 'link')
  await symlink(second.path, link, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(removeDerivedWorktree({ ...second, path: link }, parent, 'refs/heads/main', signal), /Linked/)
  await assert.rejects(removeDerivedWorktree(second, parent, 'refs/heads/derived-2', signal), /cannot be/)
  const aborted = new AbortController(); aborted.abort()
  await assert.rejects(catalog.removeWorktree('default', second.id, args.integratedRef, context.sessionId, aborted.signal))
  registry.acquireAccess()()
  // Failure between disk mutation and durable unregister is explicit, never success.
  verifyExclusion = false
  const partial = await derive()
  const backup = `${catalog.filePath}.backup`
  await rename(catalog.filePath, backup); await mkdir(catalog.filePath)
  try {
    await assert.rejects(tool.execute({ ...args, workspaceId: partial.id }, context), /disk removal completed but registration retained/)
    await assert.rejects(lstat(partial.path), { code: 'ENOENT' })
    assert.ok(registry.get(partial.id))
    await git(source, ['show-ref', '--verify', 'refs/heads/derived-3'], signal)
    registry.acquireAccess()()
  } finally { await rm(catalog.filePath, { recursive: true }); await rename(backup, catalog.filePath) }
  const recovered = new ProjectCatalog(home); await recovered.init()
  assert.ok(recovered.folders('default').some(item => item.id === partial.id))
  await assert.rejects(tool.execute({ ...args, workspaceId: partial.id }, context), /registration retained/)
  registry.acquireAccess()()
  // Owner UI unregister is the existing metadata-only recovery operation.
  await registry.changeProject(partial.id)
  assert.equal(registry.get(partial.id), undefined)

  const invalidation = await derive()
  catalog.configureFolderLifecycle('default', { assertIdle: () => {}, assertRemovalIdle: () => {}, invalidate: () => { throw new Error('invalidation fixture') } })
  await assert.rejects(tool.execute({ ...args, workspaceId: invalidation.id }, context), /disk removal and unregister completed, but session invalidation failed/)
  assert.equal(registry.get(invalidation.id), undefined)
  registry.acquireAccess()()

})
