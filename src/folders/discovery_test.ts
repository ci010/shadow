import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { projectProvider } from '../agent/context/project.ts'
import type { SessionPromptContext } from '../agent/context/builder.ts'
import { ProjectCatalog } from '../projects/catalog.ts'
import { DEFAULT_PROJECT_ID } from '../projects/contracts.ts'
import type { WorkdirCapabilityState } from '../sessions/locality.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import type { ExecutionContext } from '../tools/context.ts'
import { ReadTool } from '../tools/read.ts'
import { GlobTool, GrepTool } from '../tools/ripgrep.ts'
import { VirtualFs } from '../vfs/virtual-fs.ts'
import type { RemoteFolderRecord } from './contracts.ts'
import { ProjectFolderDiscovery } from './discovery.ts'
import { FolderRegistry } from './registry.ts'

function executionContext(projectId = DEFAULT_PROJECT_ID): ExecutionContext {
  return { projectId, signal: new AbortController().signal } as ExecutionContext
}

test('live project-scoped registry provides complete read/search discovery and current availability', async () => {
  await withTempWorkspace(async root => {
    const workspace = join(root, 'home')
    const catalog = new ProjectCatalog(workspace)
    await catalog.init()
    const other = await catalog.create('Hidden project')
    const registry = new FolderRegistry(workspace, { catalog, projectId: DEFAULT_PROJECT_ID })
    await registry.init()
    for (let i = 0; i < 11; i++) {
      const path = join(root, `folder-${i}`)
      await mkdir(path)
      await registry.register(path)
    }
    const hiddenPath = join(root, 'hidden-folder')
    await mkdir(hiddenPath)
    const hidden = await catalog.registerFolder(other.id, hiddenPath)
    const discovery = new ProjectFolderDiscovery({
      projectId: DEFAULT_PROJECT_ID,
      workspace,
      getProject: () => catalog.get(DEFAULT_PROJECT_ID),
      registry,
      workdirCapabilityLookup: ref => registry.lookupWorkdir(ref) ?? { node: 'missing' },
    })
    const handlers = discovery.handlers()
    const vfs = new VirtualFs()
    vfs.mount('v:project', 'current project metadata', handlers.read, handlers.list)
    const context = executionContext()
    const read = new ReadTool(workspace, vfs)
    const all = JSON.parse(await read.execute({ path: 'v:project/folders' }, context))
    assert.equal(all.folders.length, 11)
    assert.deepEqual(JSON.parse((await handlers.list(context))[0].content), all)
    assert(all.folders.every((folder: { availability: { available: boolean } }) => folder.availability.available))
    assert(!JSON.stringify(all).includes('hidden-folder'))
    const last = registry.list().at(-1)!
    const glob = await new GlobTool(workspace, vfs).execute({ path: 'v:project', pattern: 'folders/*' }, context)
    assert.equal(glob.split('\n').length, 11)
    assert(glob.includes(`v:project/folders/${last.id}`))
    const grep = await new GrepTool(workspace, vfs).execute({ path: 'v:project', pattern: 'folder-10' }, context)
    assert(grep.includes(`v:project/folders/${last.id}`))
    assert.equal(JSON.parse(await read.execute({ path: `v:project/folders/${last.id}` }, context)).folder.id, last.id)
    await assert.rejects(read.execute({ path: `v:project/folders/${hidden.id}` }, context), /Unknown current-project/)
    await assert.rejects(read.execute({ path: 'v:project/folders' }, executionContext(other.id)), /current Project context/)
    assert.throws(() => handlers.list(executionContext(other.id)), /current Project context/)
    await assert.rejects(read.execute({ path: 'v:project/../folders' }, context), /Unknown current-project/)

    await catalog.rename(DEFAULT_PROJECT_ID, 'Renamed live project')
    await rm(last.path, { recursive: true })
    const updated = JSON.parse(await read.execute({ path: 'v:project/folders' }, context))
    assert.equal(updated.project.name, 'Renamed live project')
    assert.deepEqual(updated.folders.at(-1).availability, { available: false, reason: 'capability-offline' })
    const promptContext = { projectId: DEFAULT_PROJECT_ID } as SessionPromptContext
    const prompt = projectProvider(discovery).getPromptSection(promptContext) as string
    assert.match(prompt, /Renamed live project/)
    assert.match(prompt, /11 registered/)
    assert.doesNotMatch(prompt, /displayPath=/)
    const addedPath = join(root, 'added-live')
    await mkdir(addedPath)
    await registry.register(addedPath)
    assert.equal(JSON.parse(await read.execute({ path: 'v:project/folders' }, context)).folders.length, 12)
    const moved = registry.list()[0]
    await catalog.changeFolderProject(DEFAULT_PROJECT_ID, moved.id, other.id)
    const afterMove = await read.execute({ path: 'v:project/folders' }, context)
    assert.equal(JSON.parse(afterMove).folders.length, 11)
    assert(!afterMove.includes(moved.id))
    await assert.rejects(read.execute({ path: `v:project/folders/${moved.id}` }, context), /Unknown current-project/)
  })
})

test('remote discovery uses only capability state, preserves display metadata, and reflects offline updates', async () => {
  const remote: RemoteFolderRecord = {
    id: 'remote-folder',
    projectId: DEFAULT_PROJECT_ID,
    name: 'Remote <display>',
    kind: 'remote',
    path: 'Z:\\not-a-main-path\\remote',
    workdir: { version: 1, nodeId: 'child', capabilityId: 'remote-cap', displayPathSnapshot: 'Z:\\not-a-main-path\\remote' },
    identity: { version: 1, rootId: 'a'.repeat(64), ancestorIds: [] },
    createdAt: '2026-01-01T00:00:00.000Z',
  }
  let state: WorkdirCapabilityState = { node: 'offline' }
  const discovery = new ProjectFolderDiscovery({
    projectId: DEFAULT_PROJECT_ID,
    workspace: resolve('.test-data'),
    getProject: () => ({ id: DEFAULT_PROJECT_ID, name: 'Remote project', createdAt: remote.createdAt }),
    registry: { list: () => [remote] },
    workdirCapabilityLookup: ref => {
      assert.equal(ref, remote.workdir)
      return state
    },
  })
  const read = discovery.handlers().read
  const offline = JSON.parse(await read('folders', executionContext())).folders[0]
  assert.deepEqual(offline.availability, { available: false, reason: 'node-offline' })
  assert.equal(offline.pathUsage, 'remote-display-only')
  assert.equal(offline.path, remote.path)
  assert.deepEqual(offline.workdir, remote.workdir)
  const prompt = projectProvider(discovery).getPromptSection({ projectId: DEFAULT_PROJECT_ID, folderId: remote.id } as SessionPromptContext) as string
  assert.match(prompt, /kind=remote/)
  assert.match(prompt, /Selected registered resource \(metadata\): id="remote-folder"/)
  state = { node: 'online', capability: { kind: 'workdir', online: true, path: resolve('.must-not-be-used') } }
  const online = JSON.parse(await read('folders', executionContext())).folders[0]
  assert.deepEqual(online.availability, { available: true, locality: 'remote' })
  assert(!JSON.stringify(online).includes('.must-not-be-used'))
})

test('missing project context, wrong live project, and mixed-project registry fail closed', () => {
  const options = {
    projectId: DEFAULT_PROJECT_ID,
    workspace: resolve('.test-data'),
    getProject: () => ({ id: DEFAULT_PROJECT_ID, name: 'Project', createdAt: '' }),
    registry: { list: () => [] },
    workdirCapabilityLookup: () => ({ node: 'missing' as const }),
  }
  assert.throws(() => new ProjectFolderDiscovery(options).snapshot(undefined), /current Project context/)
  assert.throws(() => new ProjectFolderDiscovery({ ...options, getProject: () => undefined }).snapshot(DEFAULT_PROJECT_ID), /unavailable/)
  assert.throws(() => new ProjectFolderDiscovery({
    ...options, getProject: () => ({ ...options.getProject(), id: 'wrong' }),
  }).snapshot(DEFAULT_PROJECT_ID), /unavailable/)
  assert.throws(() => new ProjectFolderDiscovery({
    ...options, registry: { list: () => [{ id: 'foreign', projectId: 'wrong', name: 'secret', path: 'secret', createdAt: '' }] },
  }).snapshot(DEFAULT_PROJECT_ID), /does not belong/)
})

test('empty discovery returns current project metadata without creating or selecting a folder', async () => {
  const project = { id: DEFAULT_PROJECT_ID, name: 'Empty project', createdAt: '2026-01-01T00:00:00.000Z' }
  const discovery = new ProjectFolderDiscovery({
    projectId: DEFAULT_PROJECT_ID,
    workspace: resolve('.test-data'),
    getProject: () => project,
    registry: { list: () => [] },
    workdirCapabilityLookup: () => { throw new Error('Empty discovery must not probe the filesystem') },
  })
  const handlers = discovery.handlers()
  const result = JSON.parse(await handlers.read('folders', executionContext()))
  assert.deepEqual(result.project, project)
  assert.deepEqual(result.folders, [])
  assert.match(result.notice, /does not select a folder/)
  assert.equal((await handlers.list(executionContext())).length, 1)
})
