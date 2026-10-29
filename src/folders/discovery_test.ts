import { requireToolText } from '../tools/tool.ts'
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
import { selectFolder } from './identifier.ts'

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
      await registry.register(path, undefined, i === 10 ? 'API <service>\n**metadata**' : undefined)
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
    const all = requireToolText(await read.execute({ path: 'v:project/folders' }, context))
    assert.equal(all.split('\n').filter(line => line.startsWith('- **')).length, 11)
    assert.equal((await handlers.list(context))[0].content, all)
    assert.doesNotMatch(all, /unavailable:/)
    assert(all.includes('API &lt;service&gt; \\*\\*metadata\\*\\*'))
    assert(!JSON.stringify(all).includes('hidden-folder'))
    const last = registry.list().at(-1)!
    const reloaded = new ProjectCatalog(workspace)
    await reloaded.init()
    assert.equal(reloaded.folders(DEFAULT_PROJECT_ID).at(-1)?.description, last.description)
    assert.equal(reloaded.folders(DEFAULT_PROJECT_ID)[0].description, undefined)
    const glob = await new GlobTool(workspace, vfs).execute({ path: 'v:project', pattern: 'folders/*' }, context)
    assert.equal(glob.split('\n').length, 11)
    assert(glob.includes(`v:project/folders/${last.id}`))
    const grep = await new GrepTool(workspace, vfs).execute({ path: 'v:project', pattern: 'folder-10' }, context)
    assert(grep.includes(`v:project/folders/${last.id}`))
    const detail = JSON.parse(requireToolText(await read.execute({ path: `v:project/folders/${last.id}` }, context))).folder
    assert.equal(detail.id, last.id)
    assert.equal(detail.description, last.description)
    await assert.rejects(read.execute({ path: `v:project/folders/${hidden.id}` }, context), /Unknown current-project/)
    await assert.rejects(read.execute({ path: 'v:project/folders' }, executionContext(other.id)), /current Project context/)
    assert.throws(() => handlers.list(executionContext(other.id)), /current Project context/)
    await assert.rejects(read.execute({ path: 'v:project/../folders' }, context), /Unknown current-project/)

    await catalog.rename(DEFAULT_PROJECT_ID, 'Renamed live project')
    await rm(last.path, { recursive: true })
    const updated = requireToolText(await read.execute({ path: 'v:project/folders' }, context))
    assert.match(updated, /^# Renamed live project/)
    assert.match(updated, /unavailable: capability-offline/)
    const promptContext = { projectId: DEFAULT_PROJECT_ID } as SessionPromptContext
    const prompt = projectProvider(discovery).getPromptSection(promptContext) as string
    assert.match(prompt, /Renamed live project/)
    assert.match(prompt, /Project folders: 11/)
    assert.doesNotMatch(prompt, /displayPath=/)
    const addedPath = join(root, 'added-live')
    await mkdir(addedPath)
    await registry.register(addedPath)
    assert.equal(requireToolText(await read.execute({ path: 'v:project/folders' }, context)).split('\n').filter(line => line.startsWith('- **')).length, 12)
    const moved = registry.list()[0]
    await catalog.changeFolderProject(DEFAULT_PROJECT_ID, moved.id, other.id)
    const afterMove = await read.execute({ path: 'v:project/folders' }, context)
    assert.equal(requireToolText(afterMove).split('\n').filter(line => line.startsWith('- **')).length, 11)
    assert(!requireToolText(afterMove).includes(moved.id))
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
  const offline = JSON.parse(await read(`folders/${remote.id}`, executionContext())).folder
  assert.deepEqual(offline.availability, { available: false, reason: 'node-offline' })
  assert.equal(offline.pathUsage, 'remote-display-only')
  assert.equal(offline.path, remote.path)
  assert.deepEqual(offline.workdir, remote.workdir)
  const prompt = projectProvider(discovery).getPromptSection({ projectId: DEFAULT_PROJECT_ID, folderId: remote.id } as SessionPromptContext) as string
  assert.doesNotMatch(prompt, /Selected Project folder|kind=remote/)
  state = { node: 'online', capability: { kind: 'workdir', online: true, path: resolve('.must-not-be-used') } }
  const online = JSON.parse(await read(`folders/${remote.id}`, executionContext())).folder
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
  const result = await handlers.read('folders', executionContext())
  assert.match(result, /^# Empty project/)
  assert.match(result, /No registered folders/)
  assert.match(result, /does not select a folder/)
  assert.equal((await handlers.list(executionContext()))[0].content, result)
  assert.equal((await handlers.list(executionContext())).length, 1)
})

test('Markdown groups by node identity, renders live names, unique selectors and inert metadata', async () => {
  const base = { projectId: DEFAULT_PROJECT_ID, createdAt: '' }
  const remote = (id: string, nodeId: string, name = 'app'): RemoteFolderRecord => ({
    ...base, id, name, kind: 'remote', path: 'Z:\\remote',
    workdir: { version: 1, nodeId, capabilityId: id, displayPathSnapshot: 'Z:\\remote' },
    identity: { version: 1, rootId: 'a'.repeat(64), ancestorIds: [] },
  })
  const folders = [
    { ...base, id: '12345678-0000-0000-0000-000000000001', name: 'app', path: 'C:\\app' },
    remote('12345678-0000-0000-0000-000000000002', 'child-a'),
    remote('bbbbbbbb-0000-0000-0000-000000000003', 'child-b'),
    remote('cccccccc-0000-0000-0000-000000000004', 'child-a', 'second'),
    remote('dddddddd-0000-0000-0000-000000000005', 'unknown', '<img>\n**bad**'),
  ]
  folders[4]!.path = 'Z:\\[link](https://invalid)\n## injected <script>& `code` | cell'
  let displayName = 'Worker'
  const discovery = new ProjectFolderDiscovery({
    projectId: DEFAULT_PROJECT_ID, workspace: resolve('.test-data'),
    getProject: () => ({ ...base, id: DEFAULT_PROJECT_ID, name: 'Project\n# <img> [bad](url)' }),
    registry: { list: () => folders },
    getNodeInventory: () => ({ version: 1, nodes: [
      { nodeId: 'main-id', displayName: 'Host', role: 'main', connection: 'connected', capabilities: [] },
      ...['child-a', 'child-b'].map(nodeId => ({ nodeId, displayName, role: 'child' as const, connection: 'offline' as const, capabilities: [] })),
    ] }),
    workdirCapabilityLookup: () => ({ node: 'offline' }),
  })
  const handlers = discovery.handlers()
  const text = await handlers.read('folders', executionContext())
  assert.equal((await handlers.list(executionContext()))[0].content, text)
  assert.equal(text.split('\n').filter(line => line.startsWith('## ')).length, 4)
  assert.match(text, /## Main: Host/)
  assert(text.includes('Worker \\(child-a\\)'))
  assert(text.includes('Worker \\(child-b\\)'))
  assert.match(text, /## unknown/)
  assert.match(text, /unavailable: node-offline/)
  assert.doesNotMatch(text, /<img>|<script>|\n## injected|\[link\]\(https:/)
  assert.match(text, /&lt;script&gt;&amp;/)
  const selectors: string[] = []
  for (const folder of folders) {
    const detail = JSON.parse(await handlers.read(`folders/${folder.id}`, executionContext())).folder
    selectors.push(detail.identifier)
    assert.equal(selectFolder(folders, detail.identifier), folder)
    assert.equal(detail.path, folder.path)
  }
  assert.equal(new Set(selectors).size, folders.length)
  assert.equal(selectors[0], folders[0].id)
  assert.equal(selectors[1], folders[1].id)
  assert.equal(selectors[3], 'second')
  displayName = 'Renamed'
  assert.match(await handlers.read('folders', executionContext()), /## Renamed/)
})

test('displayed selectors reject collisions with other slugs and authoritative full IDs', async () => {
  const folders = [
    { id: 'aaaaaaaa-0000-0000-0000-000000000001', name: 'app' },
    { id: 'bbbbbbbb-0000-0000-0000-000000000002', name: 'app' },
    { id: 'cccccccc-0000-0000-0000-000000000003', name: 'app-aaaaaaaa' },
    { id: 'dddddddd-0000-0000-0000-000000000004', name: 'aaaaaaaa-0000-0000-0000-000000000001' },
  ].map(folder => ({ ...folder, projectId: DEFAULT_PROJECT_ID, path: 'C:\\folder', createdAt: '' }))
  const discovery = new ProjectFolderDiscovery({
    projectId: DEFAULT_PROJECT_ID, workspace: resolve('.test-data'),
    getProject: () => ({ id: DEFAULT_PROJECT_ID, name: 'Project', createdAt: '' }),
    registry: { list: () => folders }, workdirCapabilityLookup: () => ({ node: 'offline' }),
  })
  const handlers = discovery.handlers()
  const text = await handlers.read('folders', executionContext())
  assert.match(text, /## Main\n/)
  const selectors = [...text.matchAll(/^- \*\*(.+?)\*\*:/gm)].map(match => match[1]!)
  assert.equal(selectors.length, folders.length)
  selectors.forEach((selector, i) => assert.equal(selectFolder(folders, selector), folders[i]))
  assert.equal(selectors[0], folders[0].id)
  assert.notEqual(selectors[2], folders[2].name)
  assert.notEqual(selectors[3], folders[3].name)
})
