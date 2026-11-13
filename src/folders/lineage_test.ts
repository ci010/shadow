import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { withTempWorkspace } from '../testing/workspace.ts'
import { ProjectCatalog } from '../projects/catalog.ts'
import { FolderRegistry } from './registry.ts'
import { workspaceTree, parseWorkspaceLineage } from './lineage.ts'
import { ProjectFolderDiscovery } from './discovery.ts'
import { assessWorkspaceRecycle } from './recycle.ts'
import type { FolderRecord } from './contracts.ts'
import type { ExecutionContext } from '../tools/context.ts'
const lineage = (parentId: string) => ({ version: 1 as const, parentId, backend: 'git-worktree' as const, ownership: 'shadow-derived' as const })
const folder = (id: string, parentId?: string): FolderRecord => ({ id, name: id, path: '/display', projectId: 'default', createdAt: '', ...(parentId ? { lineage: lineage(parentId) } : {}) })

test('direct-parent Markdown tree nests recursive forks, not backend groups; orphans and cycles survive', () => {
  const records = [folder('C', 'B'), folder('B', 'shadow'), folder('shadow'), folder('A', 'shadow'), folder('orphan', 'gone'), folder('x', 'y'), folder('y', 'x')]
  assert.deepEqual(workspaceTree(records, f => f.id), ['- shadow', '  - B', '    - C', '  - A', '- orphan [parent unavailable]', '- x [lineage cycle]', '  - y'])
  assert.throws(() => parseWorkspaceLineage({ ...lineage('x'), version: 2 }))
})

test('versioned lineage persists; old roots remain unknown; archive parent retains historical ID and live descendants', async () => {
  await withTempWorkspace(async root => {
    const home = join(root, 'host'), workspace = join(root, 'workspace')
    await mkdir(workspace)
    let catalog = new ProjectCatalog(home); await catalog.init()
    let registry = new FolderRegistry(workspace, { catalog, projectId: 'default' }); await registry.init()
    const register = async (name: string) => { const path = join(root, name); await mkdir(path); return registry.register(path) }
    const parent = await register('shadow'), child = await register('child'), grandchild = await register('grandchild')
    await registry.recordLineage(child.id, lineage(parent.id))
    await registry.recordLineage(grandchild.id, lineage(child.id))
    await assert.rejects(registry.recordLineage(parent.id, lineage(grandchild.id)), /cycle/)
    catalog = new ProjectCatalog(home); await catalog.init()
    registry = new FolderRegistry(workspace, { catalog, projectId: 'default' }); await registry.init()
    assert.equal(registry.get(parent.id)?.lineage, undefined)
    assert.deepEqual(registry.get(child.id)?.lineage, lineage(parent.id))
    await catalog.changeFolderProject('default', parent.id, undefined)
    const discovery = new ProjectFolderDiscovery({ projectId: 'default', workspace, getProject: () => catalog.get('default'), registry, workdirLookup: () => ({ node: 'offline' }) })
    const read = discovery.handlers().read, context = { projectId: 'default' } as ExecutionContext
    const listing = String(await read('workspaces', context))
    assert.match(listing, /parent unavailable/)
    assert.match(listing, /\n  - \*\*grandchild/)
    assert.doesNotMatch(listing, /\*\*shadow\*\*/)
    assert.equal(JSON.parse(String(await read(`workspaces/${parent.id}`, context))).workspace.status, 'archived')
    assert.equal(JSON.parse(String(await read('workspaces/archive', context))).workspaces[0].id, parent.id)
    const reloaded = new ProjectCatalog(home); await reloaded.init()
    assert.equal(reloaded.archivedFolders('default')[0].id, parent.id)
  })
})

test('recycle assessment fails closed and never equates completed or stale integration with reclamation', () => {
  const derived = folder('child', 'root')
  const evidence = { identityVerified: true, cleanIncludingUntrackedAndIgnored: true, noActiveSessionsOrCommands: true, noUnknownOperations: true, currentTip: 'a'.repeat(40), integratedTip: 'a'.repeat(40), integration: 'git-ancestry' as const }
  assert.equal(assessWorkspaceRecycle(derived, evidence).eligible, true)
  for (const change of [{ currentTip: 'b'.repeat(40) }, { noActiveSessionsOrCommands: false }, { noUnknownOperations: false }, { cleanIncludingUntrackedAndIgnored: false }, { identityVerified: false }, { integration: 'squash' as const }, { integration: 'rebase' as const }]) assert.equal(assessWorkspaceRecycle(derived, { ...evidence, ...change }).eligible, false)
  assert.equal(assessWorkspaceRecycle(folder('legacy'), evidence).eligible, false)
  assert.equal(assessWorkspaceRecycle({ ...derived, lineage: { ...lineage('root'), backend: 'layerfs' } }, evidence).eligible, false)
})
