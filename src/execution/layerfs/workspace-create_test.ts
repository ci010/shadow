import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { LayerFSWorkspaces } from './workspace-create.ts'
import { layerfsName } from './bridge.ts'
import { branchWorkspace, parseBranchWorkspace } from './workspace-identity.ts'
import type { ExecutionContext } from '../../tools/context.ts'
import { ToolOutcomeUnknownError } from '../../tools/tool.ts'
import { WorkspaceCreateTool } from '../../tools/workspace-create.ts'

const context = { projectId: 'one', sessionId: 'owner', signal: new AbortController().signal } as ExecutionContext


test('LayerFS creation forks/binds/registers once; retained requests do not repeat mutations', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.layerfs-create-'))
  try {
    const calls: Record<string, unknown>[] = []
    let identity = 'managed:active'
    const service = new LayerFSWorkspaces({ projectId: 'one', directory: dir, identity: async () => identity,
      run: async args => { calls.push(args); return JSON.stringify({ ok: true, result: args.action === 'branch_workspace' ? { workspace: branchWorkspace(layerfsName('one'), String(args.branch)) } : {} }) },
      register: async value => { assert.match(parseBranchWorkspace(value).branch, /^shadow-derived-/); return { id: 'registered-layerfs' } },
    })
    const args = { source: 'main', idempotencyKey: 'stable' }
    const [a, b] = await Promise.all([service.create(args, context), service.create(args, context)])
    assert.deepEqual(JSON.parse(a), JSON.parse(b))
    assert.equal(JSON.parse(a).workspaceId, 'registered-layerfs')
    assert.equal(calls.length, 2)
    assert.deepEqual(calls.map(c => c.action), ['fork', 'branch_workspace'])
    assert.equal(calls[0].ref, 'main')
    assert.equal(calls[0].namespace, 'active')
    assert.match(String(calls[0].branch), /^shadow-derived-/)
    await assert.rejects(service.create({ ...args, source: 'other' }, context), /identity|parameters/)
    identity = 'managed:fresh'
    await assert.rejects(service.create(args, context), /identity/)
    assert.equal(calls.length, 2)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('lost branch binding response is not replayed after restart; source validation fails before dispatch', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.layerfs-create-'))
  try {
    const calls: string[] = []
    const options = { projectId: 'one', directory: dir, identity: async () => 'managed:active',
      run: async (args: Record<string, unknown>) => { calls.push(String(args.action)); if (args.action === 'branch_workspace') throw new ToolOutcomeUnknownError('lost'); return JSON.stringify({ ok: true, result: {} }) },
      register: async () => ({ id: 'never' }),
    }
    const args = { source: 'main', branch: 'isolated', idempotencyKey: 'lost' }
    await assert.rejects(new LayerFSWorkspaces(options).create(args, context), ToolOutcomeUnknownError)
    await assert.rejects(new LayerFSWorkspaces(options).create(args, context), /unconfirmed mutation/)
    assert.deepEqual(calls, ['fork', 'branch_workspace'])
    await assert.rejects(new LayerFSWorkspaces(options).create({ source: '/host/source' }, context), /not a host path/)
    await assert.rejects(new LayerFSWorkspaces(options).create({ source: 'main', sourceReviewed: true }, context), /Invalid/)
    await assert.rejects(new LayerFSWorkspaces(options).create(args, { ...context, projectId: 'foreign' }), /direct local/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('workspace_create selects backend, preserves default Git contract and never falls back', async () => {
  const seen: unknown[] = []
  const git = { createDerivedWorkspace: async (args: unknown) => { seen.push(args); return { workspaceId: 'git' } as never } }
  const tool = new WorkspaceCreateTool(git, 'one', id => id === 'owner', async args => { seen.push(args); return JSON.stringify({ workspaceId: 'layerfs' }) })
  assert.equal(JSON.parse(await tool.execute({ source: 'repo', branch: 'main' }, context)).workspaceId, 'git')
  assert.equal(JSON.parse(await tool.execute({ backend: 'layerfs', source: 'main' }, context)).workspaceId, 'layerfs')
  assert.deepEqual(seen, [{ source: 'repo', branch: 'main' }, { source: 'main' }])
  await assert.rejects(tool.execute({ backend: 'unknown', source: 'main' }, context), /Unsupported/)
  await assert.rejects(new WorkspaceCreateTool(git, 'one', () => true).execute({ backend: 'layerfs', source: 'main' }, context), /no Git or host fallback/)
  assert.equal(seen.length, 2)
})

test('registered fork validates namespace and connection before dispatch and on recovery', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.layerfs-create-'))
  try {
    const calls: unknown[] = []
    const project = layerfsName('one')
    let identity = 'managed:active'
    const service = new LayerFSWorkspaces({ projectId: 'one', directory: dir,
      identity: async () => identity, bindingProject: async () => project,
      run: async args => { calls.push(args); return JSON.stringify({ ok: true, result: args.action === 'branch_workspace' ? { workspace: branchWorkspace(project, String(args.branch)) } : {} }) },
      register: async () => ({ id: 'registered' }),
    })
    const args = { source: 'main', idempotencyKey: 'registered-fork' }
    await assert.rejects(service.create(args, context, branchWorkspace('foreign', 'main')), /another Project/)
    await assert.rejects(service.create(args, context, branchWorkspace(project, 'other')), /binding\/connection/)
    assert.equal(calls.length, 0)
    const binding = branchWorkspace(project, 'main')
    await service.create(args, context, binding)
    await service.create(args, context, binding)
    assert.equal(calls.length, 2)
    identity = 'managed:fresh'
    await assert.rejects(service.create(args, context, binding), /identity/)
    assert.equal(calls.length, 2)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
