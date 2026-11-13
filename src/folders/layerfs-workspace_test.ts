import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { FolderService } from './routes.ts'
import { sessionsApiPlugin } from '../sessions/routes.ts'
import type { SessionManager } from '../sessions/session-manager.ts'
import { join } from 'node:path'
import { withTempWorkspace } from '../testing/workspace.ts'
import { FolderRegistry } from './registry.ts'
import { ProjectFolderDiscovery } from './discovery.ts'
import { ProjectCatalog } from '../projects/catalog.ts'
import { DEFAULT_PROJECT_ID } from '../projects/contracts.ts'
import { resolveSessionLocations, parseWorkdirRef } from '../sessions/locality.ts'
import { resolveExplicitToolTarget } from '../execution/tool-target.ts'
import { executionTargetContext } from '../tools/execution-target.ts'
import { UseProjectTool } from '../tools/use-project.ts'
import { Tools } from '../tools/registry.ts'
import { prepareWorkingContext } from '../agent/context/working-context.ts'
import type { ExecutionContext } from '../tools/context.ts'
import type { LayerFSFolderRecord } from './contracts.ts'

const mount = 'layerfs:' + Buffer.from(JSON.stringify({ project: 'active', sandbox: '42', path: '/workspaces/42' })).toString('base64url')
const signal = new AbortController().signal
const base = { projectId: DEFAULT_PROJECT_ID, sessionId: 'test:layerfs', physicalSessionId: 'test-0', channel: 'test', chatId: 'chat', senderId: 'user', messageId: 'turn', signal, tools: undefined as never } satisfies ExecutionContext
const record: LayerFSFolderRecord = { id: '11111111-1111-4111-8111-111111111111', projectId: DEFAULT_PROJECT_ID, kind: 'layerfs', mount, name: 'Sandbox', path: '/workspaces/42', createdAt: new Date().toISOString(), workdir: { version: 2, nodeId: 'layerfs', workdirId: mount } }

test('LayerFS registration requires Project authorization; namespace rejection never mutates catalog', async () => {
  await withTempWorkspace(async root => {
    const home = join(root, 'home')
    const catalog = new ProjectCatalog(home); await catalog.init()
    const folders = new FolderRegistry(home, { projectId: DEFAULT_PROJECT_ID, catalog }); await folders.init()
    await assert.rejects(folders.registerLayerFS(mount, signal), /authorization/)
    let active = true
    folders.configureLayerFS({
      authorize: async value => { if (!active || value !== mount) throw new Error('foreign or quarantined namespace'); return { path: '/workspaces/42', name: 'Sandbox' } },
      requireAvailable: async () => { if (!active) throw new Error('quarantined namespace') },
    })
    await assert.rejects(folders.registerLayerFS('layerfs:foreign', signal), /namespace/)
    assert.deepEqual(folders.list(), [])
    const folder = await folders.registerLayerFS(mount, signal, 'sandbox only')
    assert.equal(folder.kind, 'layerfs'); assert.equal(folder.mount, mount)
    assert.deepEqual(await folders.registerLayerFS(mount, signal), folder)
    assert.equal(folder.workdir.nodeId, 'layerfs')
    assert.equal(folder.workdir.workdirId, mount)
    assert.deepEqual(parseWorkdirRef(JSON.parse(JSON.stringify(folder.workdir))), folder.workdir)
    const lookup = (ref: typeof folder.workdir) => folders.lookupWorkdir(ref) ?? { node: 'missing' as const }
    const resolution = resolveSessionLocations(home, { sessionId: 's', workdir: folder.workdir }, undefined, lookup).workdir
    assert.equal(resolution.available && resolution.locality, 'layerfs')
    assert.equal('path' in resolution, false)
    const discovery = new ProjectFolderDiscovery({ projectId: DEFAULT_PROJECT_ID, workspace: home, getProject: () => catalog.get(DEFAULT_PROJECT_ID), registry: folders, workdirLookup: lookup })
    const overview = await discovery.handlers().read('workspaces', base)
    assert.match(String(overview), /\[LayerFS; available\]/)
    assert.match(String(overview), /non-host resources/)
    const details = JSON.parse(String(await discovery.handlers().read(`workspaces/${folder.id}`, base)))
    assert.equal(details.workspace.kind, 'layerfs')
    assert.equal(details.workspace.pathUsage, 'sandbox-display-only')
    assert.equal(details.workspace.mount, mount)
    assert.deepEqual(details.workspace.availability, { available: true, locality: 'layerfs' })
    const target = resolveExplicitToolTarget(home, { sessionId: 's' }, lookup, undefined, folder, 'filesystem.read')
    assert.equal(target.cwd, undefined); assert.equal(target.remoteWorkdir, undefined)
    assert.deepEqual(target.layerfsWorkdir, { workspace: mount })
    const reloaded = new ProjectCatalog(home); await reloaded.init()
    assert.deepEqual(reloaded.folders(DEFAULT_PROJECT_ID), [folder])
    const other = await catalog.create('Other')
    await assert.rejects(folders.changeProject(folder.id, other.id), /cannot move/)
    const foreign = new FolderRegistry(home, { projectId: other.id, catalog }); await foreign.init()
    assert.equal(foreign.lookupWorkdir(folder.workdir)?.workdir, undefined)
    active = false
    await assert.rejects(folders.requireAvailable(folder.id), /quarantined/)
    await assert.rejects(folders.registerLayerFS(mount, signal), /namespace/)
    const standalone = new FolderRegistry(join(root, 'legacy')); await standalone.init()
    standalone.configureLayerFS({ authorize: async () => ({ path: '/workspaces/42' }), requireAvailable: async () => {} })
    await assert.rejects(standalone.registerLayerFS(mount, signal), /authorization/)
  })
})

test('LayerFS locality requires explicit backend, never interprets a container path as Main or remote', () => {
  const state = { sessionId: 's', workdir: record.workdir }
  for (const workdir of [{ online: true, path: '/workspaces/42' }, { online: true, backend: 'layerfs' as const, workspace: 'layerfs:foreign' }]) {
    const result = resolveSessionLocations('/not-used', state, undefined, () => ({ node: 'online', workdir })).workdir
    assert.deepEqual(result.available ? result : result.reason, 'incompatible')
  }
  const result = resolveSessionLocations('/not-used', { sessionId: 's', workdir: { ...record.workdir, nodeId: 'local' } }, undefined,
    () => ({ node: 'online', workdir: { online: true, backend: 'layerfs', workspace: mount, path: '/workspaces/42' } })).workdir
  assert.equal(result.available, false)
})

test('per-call LayerFS selection clears host and remote targets; raw IDs still obey targeting guards', async () => {
  const context = { ...base, cwd: '/main/should-not-be-used', resolveToolTarget: async () => ({ cwd: undefined, layerfsWorkdir: { workspace: mount }, fileChangeTarget: { nodeId: 'layerfs', workdirId: mount } }) }
  const target = await executionTargetContext({ workspace: record.id }, context, 'filesystem.read')
  assert.equal(target.cwd, undefined); assert.equal(target.remoteWorkdir, undefined)
  assert.deepEqual(target.layerfsWorkdir, { workspace: mount })
  assert.equal(context.cwd, '/main/should-not-be-used')
  const local = await executionTargetContext({ workspace: 'local-target' }, { ...context, layerfsWorkdir: { workspace: mount }, resolveToolTarget: async () => ({ cwd: '/main/explicit', fileChangeTarget: { nodeId: 'local', workdirId: 'registered' } }) }, 'filesystem.read')
  assert.equal(local.layerfsWorkdir, undefined)
  assert.equal(local.cwd, '/main/explicit')
  const raw = await executionTargetContext({ workspace: mount }, context, 'filesystem.read')
  assert.deepEqual(raw.layerfsWorkdir, { workspace: mount }); assert.equal(raw.cwd, undefined)
  await assert.rejects(executionTargetContext({ workspace: mount, path: 'v:memory' }, context, 'filesystem.read'), /virtual paths/)
  await assert.rejects(executionTargetContext({ workspace: mount, target: 'raw' }, context, 'filesystem.read'), /raw node/)
})

test('workspace_use reads LayerFS AGENTS only through injected reader and preserves state on failure', async () => {
  let calls = 0; let switches = 0
  const options = { projectId: DEFAULT_PROJECT_ID, folders: { list: () => [record], requireAvailable: async () => record, requireExecutionAvailable: async () => record, acquireAccess: () => () => {} } }
  const context: ExecutionContext = { ...base, toolCallName: 'workspace_use', switchProjectFolder: async event => {
    switches++; assert.deepEqual(event.workdir, record.workdir)
    assert.match(event.content, /not a host filesystem/)
    assert.match(event.content, /sandbox instructions/)
    return 'switched'
  } }
  await assert.rejects(new UseProjectTool(options).execute({ workspace: record.id }, context), /reader unavailable/)
  assert.equal(switches, 0)
  const tool = new UseProjectTool({ ...options, readLayerFSInstructions: async folder => { calls++; assert.equal(folder.mount, mount); return { content: 'sandbox instructions' } } })
  assert.equal(await tool.execute({ workspace: record.id }, context), 'switched')
  assert.equal(calls, 1); assert.equal(switches, 1)
  const snapshot = await prepareWorkingContext({ available: true, locality: 'layerfs', workdir: record.workdir, workspace: mount }, record.id, record)
  assert.match(snapshot, /LayerFS root AGENTS.md has not been loaded/)
  assert.doesNotMatch(snapshot, /Default cwd:/)
})

test('unmarked tools fail closed on default LayerFS contexts before execution', async () => {
  const tools = new Tools('/not-used')
  let executed = false
  tools.register({ name: 'host-only-test', description: 'test', parameters: { type: 'object', properties: {} }, execute: async () => { executed = true; return 'bad' } })
  const result = await tools.execute('host-only-test', {}, { ...base, layerfsWorkdir: { workspace: mount } })
  assert.match(String(result), /does not support LayerFS/); assert.equal(executed, false)
})

test('unsupported UI file and Git routes reject LayerFS without using sandbox display paths on Main', async () => {
  await withTempWorkspace(async root => {
    const home = join(root, 'home')
    const catalog = new ProjectCatalog(home); await catalog.init()
    const registry = new FolderRegistry(home, { projectId: DEFAULT_PROJECT_ID, catalog }); await registry.init()
    registry.configureLayerFS({ authorize: async () => ({ path: '/workspaces/42' }), requireAvailable: async () => {} })
    const folder = await registry.registerLayerFS(mount, signal)
    const app = new Hono()
    const service = new FolderService({ registry, createSession: async () => { throw new Error('not used') } })
    service.plugin(app)
    sessionsApiPlugin({ workspace: home, assertHistoricalFolderAccess: async () => {},
      readSessionState: async () => ({ sessionId: 'sandbox', folderId: folder.id, workdir: folder.workdir }),
      workdirLookup: (ref: typeof folder.workdir) => registry.lookupWorkdir(ref) ?? { node: 'missing' },
    } as unknown as SessionManager)(app)
    try {
      for (const suffix of ['files', 'raw?path=AGENTS.md', 'preview?path=AGENTS.md', 'static/AGENTS.md', 'git/status', 'git/diff', 'files/search?query=AGENTS']) {
        const response = await app.request(`/api/folders/${folder.id}/${suffix}`)
        assert.equal(response.status, 409, suffix)
        assert.equal((await response.json()).error, 'layerfs_route_unsupported')
        const sessionResponse = await app.request(`/api/sessions/sandbox/${suffix}`)
        assert.equal(sessionResponse.status, 501, suffix)
        assert.equal((await sessionResponse.json()).error, 'layerfs_unsupported')
      }
    } finally { await service.dispose() }
  })
})


test('versioned committed-branch identity survives catalog reload without host path binding', async () => {
  const { branchWorkspace } = await import('../execution/layerfs/workspace-identity.ts')
  await withTempWorkspace(async root => {
    const home = join(root, 'home'), id = branchWorkspace('active', 'feature/test')
    const catalog = new ProjectCatalog(home); await catalog.init()
    const folder = await catalog.registerLayerFSFolder(DEFAULT_PROJECT_ID, id, { path: 'layerfs-branch:feature/test' }, signal)
    const reloaded = new ProjectCatalog(home); await reloaded.init()
    assert.deepEqual(reloaded.folders(DEFAULT_PROJECT_ID).find(f => f.id === folder.id), folder)
    assert.equal(folder.workdir.workdirId, id)
    await assert.rejects(catalog.registerLayerFSFolder(DEFAULT_PROJECT_ID, id, { path: 'layerfs-branch:wrong' }, signal), /mismatch/)
  })
})
