import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { WorkspaceRegisterTool } from './workspace-register.ts'
import { FolderRegistry } from '../folders/registry.ts'
import { ProjectCatalog } from '../projects/catalog.ts'
import type { ExecutionContext } from './context.ts'

const signal = new AbortController().signal
const context = { projectId: 'default', sessionId: 'owner', signal } as ExecutionContext

test('local registration uses ownership, preserves contents, supports duplicate/recovery and fails closed', async () => {
  const temporary = await mkdtemp(join(process.cwd(), '.workspace-register-test-'))
  try {
    const home = join(temporary, 'host')
    const catalog = new ProjectCatalog(home); await catalog.init()
    const folders = new FolderRegistry(home, { catalog, projectId: 'default' }); await folders.init()
    const tool = new WorkspaceRegisterTool(folders, 'default', id => id === 'owner')
    const path = join(temporary, 'baseline')
    const request = { mode: 'create_empty', path, description: 'Baseline destination' }
    const first = JSON.parse(await tool.execute(request, context))
    assert.equal(first.created, true)
    const copies = await Promise.all([tool.execute(request, context), tool.execute(request, context)])
    for (const copy of copies) assert.equal(JSON.parse(copy).workspaceId, first.workspaceId)
    assert.equal(folders.list().length, 1)
    assert.equal(context.folderId, undefined)
    await writeFile(join(path, 'keep'), 'unchanged')
    await assert.rejects(tool.execute(request, context), /empty directory/)
    assert.equal(JSON.parse(await tool.execute({ path, mode: 'existing', description: 'ignored' }, context)).workspaceId, first.workspaceId)
    assert.equal(folders.get(first.workspaceId)?.description, request.description)
    assert.equal(await readFile(join(path, 'keep'), 'utf8'), 'unchanged')

    const recovery = join(temporary, 'recovery')
    const failing = new WorkspaceRegisterTool({ acquireAccess: () => folders.acquireAccess(), reserveDestination: p => folders.reserveDestination(p), register: async () => { throw new Error('injected registration failure') } }, 'default', () => true)
    await assert.rejects(failing.execute({ path: recovery, mode: 'create_empty' }, context), /injected registration failure.*Directory retained/)
    assert.deepEqual(await readdir(recovery), [])
    assert.equal(JSON.parse(await tool.execute({ path: recovery, mode: 'create_empty' }, context)).created, false)

    const foreign = await catalog.create('Foreign')
    const owned = join(temporary, 'foreign'); await mkdir(owned)
    await catalog.registerFolder(foreign.id, owned)
    await assert.rejects(tool.execute({ path: owned, mode: 'existing' }, context), /another project/)
    const forbidden = join(owned, 'child')
    await assert.rejects(tool.execute({ path: forbidden, mode: 'create_empty' }, context), /another project/)
    await assert.rejects(readdir(forbidden), { code: 'ENOENT' })
    await assert.rejects(tool.execute({ path: join(home, 'bad'), mode: 'create_empty' }, context), /host data/)

    for (const changed of [{ projectId: 'foreign' }, { sessionId: 'worker' }, { scriptInvocation: true }, { remoteWorkdir: {} }]) {
      await assert.rejects(tool.execute(request, { ...context, ...changed } as ExecutionContext), /unavailable/)
    }
    for (const bad of ['relative', `${temporary}/../escape`, '//server/share', '\\\\server\\share']) {
      await assert.rejects(tool.execute({ path: bad, mode: 'create_empty' }, context))
    }
    await assert.rejects(tool.execute({ path: join(temporary, 'missing', 'child'), mode: 'create_empty' }, context), /ENOENT/)
    await assert.rejects(tool.execute({ ...request, projectId: 'foreign' }, context), /Invalid/)
    const cancelled = new AbortController(); cancelled.abort()
    const cancelledPath = join(temporary, 'cancelled')
    await assert.rejects(tool.execute({ path: cancelledPath, mode: 'create_empty' }, { ...context, signal: cancelled.signal }))
    await assert.rejects(readdir(cancelledPath), { code: 'ENOENT' })
    const file = join(temporary, 'file'); await writeFile(file, 'preserved')
    await assert.rejects(tool.execute({ path: file, mode: 'create_empty' }, context), /folder is unavailable/)
    assert.equal(await readFile(file, 'utf8'), 'preserved')
    const restartedCatalog = new ProjectCatalog(home); await restartedCatalog.init()
    const restartedFolders = new FolderRegistry(home, { catalog: restartedCatalog, projectId: 'default' }); await restartedFolders.init()
    const restartedTool = new WorkspaceRegisterTool(restartedFolders, 'default', () => true)
    assert.equal(JSON.parse(await restartedTool.execute({ path, mode: 'existing' }, context)).workspaceId, first.workspaceId)
    const link = join(temporary, 'link')
    await symlink(path, link, process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(tool.execute({ path: link, mode: 'existing' }, context), /linked ancestors/)
    await assert.rejects(tool.execute({ path: join(link, 'escape'), mode: 'create_empty' }, context), /linked ancestors/)
    await assert.rejects(readdir(join(path, 'escape')), { code: 'ENOENT' })
    assert.equal(folders.list().length, 2)
  } finally { await rm(temporary, { recursive: true, force: true }) }
})
