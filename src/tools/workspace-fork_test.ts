import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WorkspaceForkTool } from './workspace-fork.ts'
import { branchWorkspace } from '../execution/layerfs/workspace-identity.ts'
import type { ExecutionContext } from './context.ts'
import type { FolderRegistry } from '../folders/registry.ts'

const context = { projectId: 'p', sessionId: 'owner', signal: new AbortController().signal } as ExecutionContext
function fixture() {
  const calls: unknown[] = []
  let released = 0
  const mount = branchWorkspace('namespace', 'feature/source')
  const records = [{ id: 'local', name: 'repo', kind: 'local' }, { id: 'layer', name: 'branch', kind: 'layerfs', mount }, { id: 'remote', kind: 'remote' }]
  const lineage: unknown[] = []
  const folders = { recordLineage: async (id: string, value: unknown) => { lineage.push([id, value]) }, list: () => records, acquireAccess: () => () => { released++ }, requireExecutionAvailable: async (id: string) => records.find(r => r.id === id)! } as unknown as FolderRegistry
  const tool = new WorkspaceForkTool({ createDerivedWorkspace: async args => { calls.push(['git', args]); return { workspaceId: 'git' } as never } }, 'p', id => id === 'owner', folders,
    async (args, _ctx, binding) => { calls.push(['layerfs', args, binding]); return '{"workspaceId":"layerfs"}' })
  return { tool, calls, mount, lineage, releases: () => released }
}
test('workspace_fork uses stable selectors and safe auto Git routing, including remote', async () => {
  const { tool, calls, releases } = fixture()
  for (const source of ['repo', 'remote']) await tool.execute({ source, baseRef: 'main', idempotencyKey: source }, context)
  assert.deepEqual(calls, [['git', { source: 'local', branch: 'main', idempotencyKey: 'repo' }], ['git', { source: 'remote', branch: 'main', idempotencyKey: 'remote' }]])
  assert.equal(releases(), 2)
})
test('workspace_fork inherits LayerFS binding, separates new branch and never redirects base', async () => {
  const { tool, calls, mount, lineage } = fixture()
  await tool.execute({ source: 'branch', newBranch: 'new', name: 'task' }, context)
  assert.deepEqual(lineage, [['layerfs', { version: 1, parentId: 'layer', backend: 'layerfs', ownership: 'shadow-derived' }]])
  assert.deepEqual(calls, [['layerfs', { source: 'feature/source', branch: 'new', name: 'task' }, mount]])
  await assert.rejects(tool.execute({ source: 'layer', baseRef: 'other' }, context), /override/)
  await assert.rejects(tool.execute({ source: 'layer', backend: 'git-worktree', baseRef: 'main' }, context), /no host fallback/)
  assert.equal(calls.length, 1)
})
test('workspace_fork refuses invalid/unauthorized sources and unsupported setup without dispatch/fallback', async () => {
  const { tool, calls } = fixture()
  for (const source of ['/tmp/repo', 'main', 'missing']) await assert.rejects(tool.execute({ source, baseRef: 'main' }, context), /Unknown/)
  await assert.rejects(tool.execute({ source: 'local', backend: 'layerfs' }, context), /setup\/import/)
  await assert.rejects(tool.execute({ source: 'local' }, context), /baseRef/)
  await assert.rejects(tool.execute({ source: 'local', baseRef: 'main', newBranch: 'new' }, context), /LayerFS-only/)
  await assert.rejects(tool.execute({ source: 'local', backend: 'bad' }, context), /Unsupported/)
  await assert.rejects(tool.execute({ source: 'local', branch: 'main' }, context), /Invalid/)
  await assert.rejects(tool.execute({ source: 'local' }, { ...context, projectId: 'foreign' }), /unavailable/)
  await assert.rejects(tool.execute({ source: 'local' }, { ...context, sessionId: 'child' }), /unavailable/)
  assert.equal(calls.length, 0)
})

test('LayerFS backend failure is returned without trying Git', async () => {
  const mount = branchWorkspace('namespace', 'main')
  let gitCalls = 0
  const lineage: unknown[] = []
  const folders = { recordLineage: async (id: string, value: unknown) => { lineage.push([id, value]) }, list: () => [{ id: 'layer' }], acquireAccess: () => () => {}, requireExecutionAvailable: async () => ({ id: 'layer', kind: 'layerfs', mount }) } as unknown as FolderRegistry
  const tool = new WorkspaceForkTool({ createDerivedWorkspace: async () => { gitCalls++; throw new Error('unexpected Git') } }, 'p', () => true, folders,
    async () => { throw new Error('LayerFS unavailable') })
  await assert.rejects(tool.execute({ source: 'layer' }, context), /LayerFS unavailable/)
  assert.equal(gitCalls, 0)
})
