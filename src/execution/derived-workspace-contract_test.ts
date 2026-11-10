import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DERIVED_WORKSPACE_OPERATION, parseDerivedWorkspaceArgs, parseDerivedWorkspaceInspectResult, parseDerivedWorkspaceResult } from './derived-workspace-contract.ts'
import { assertExecutionSupported, IMPLEMENTED_OPERATIONS, NODE_OPERATIONS, validateWorkdirAdvertisement } from './workdir-contracts.ts'
import { MANAGED_WORKDIR_OPERATIONS } from './managed-workdir.ts'

function result() {
  return {
    version: 1, nodeId: 'child', sourceWorkdirId: 'repo',
    workdir: { version: 2, nodeId: 'child', workdirId: 'picked-v1:abc', displayName: 'worktree', displayPath: 'C:\\work\\repo-worktree', online: true, support: { operations: [DERIVED_WORKSPACE_OPERATION] } },
    receipt: { backend: 'git-worktree', projectId: 'a'.repeat(32), sourceId: 'repo', sourcePath: 'C:\\work\\repo', commonDir: 'C:\\work\\repo\\.git', commonIdentity: '1:2', path: 'C:\\work\\repo-worktree', branch: 'shadow-derived-12345678-1234-1234-1234-123456789abc', baseBranch: 'refs/heads/main', baseCommit: 'a'.repeat(40), description: 'Task\nGit worktree', workspaceId: 'picked-v1:abc' },
  }
}

test('derive is explicitly advertised as a directory operation; old peers cannot accept it', () => {
  assert(IMPLEMENTED_OPERATIONS.includes(DERIVED_WORKSPACE_OPERATION))
  assert(MANAGED_WORKDIR_OPERATIONS.includes(DERIVED_WORKSPACE_OPERATION))
  assert(!NODE_OPERATIONS.has(DERIVED_WORKSPACE_OPERATION))
  const request = { nodeId: 'child', workdirId: 'repo', operation: DERIVED_WORKSPACE_OPERATION, args: { action: 'inspect' }, createdAt: new Date().toISOString(), deadlineAt: new Date().toISOString() }
  const descriptor = { ...result().workdir, workdirId: 'repo', version: 2 as const }
  assertExecutionSupported(request, [descriptor], { operations: [] })
  assert.throws(() => assertExecutionSupported(request, [{ ...descriptor, support: { operations: ['workdir.git.status'] } }], { operations: [] }), /No live support/)
  assert.throws(() => assertExecutionSupported({ ...request, workdirId: undefined }, [descriptor], { operations: [DERIVED_WORKSPACE_OPERATION] }), /require workdirId/)
})

test('derive accepts only strict path-free inspect/create/verify args', () => {
  for (const value of [{ action: 'inspect' }, { action: 'create', key: 'task:one', branch: 'main', name: 'task', description: 'Task' }, { action: 'create', key: 'task:empty-description', branch: 'main', description: '' }, { action: 'verify', key: 'task:one' }]) {
    assert.deepEqual(parseDerivedWorkspaceArgs(value), value)
  }
  for (const value of [null, [], {}, { action: 'inspect', key: 'no' }, { action: 'verify' }, { action: 'verify', key: '' },
    { action: 'verify', key: 'key', branch: 'main' }, { action: 'create', key: 'key' }, { action: 'create', key: 'key', branch: 'main', name: '../escape' },
    { action: 'create', key: 'key', branch: 'main', description: 'bad\nline' }, { action: 'create', key: 'key\0bad', branch: 'main' },
    { action: 'create', key: 'key', branch: 'main', source: 'C:\\repo' }, { action: 'create', key: 'key', branch: 'main', destination: '/tmp/worktree' },
    { action: 'verify', key: 'k'.repeat(257) }, { action: 'create', key: 'k', branch: 'main', projectScope: 'other' }]) assert.throws(() => parseDerivedWorkspaceArgs(value))
})

test('strict wire responses retain Windows paths as opaque snapshots and reject foreign identity or extra fields', () => {
  const inspect = { version: 1, nodeId: 'child', sourceWorkdirId: 'repo', branch: 'main' }
  assert.deepEqual(parseDerivedWorkspaceInspectResult(inspect), inspect)
  for (const value of [{ ...inspect, version: 2 }, { ...inspect, sourcePath: 'C:\\repo' }, { ...inspect, branch: '' }, { ...inspect, nodeId: '../child' }]) assert.throws(() => parseDerivedWorkspaceInspectResult(value))
  const good = result()
  assert.deepEqual(parseDerivedWorkspaceResult(good), good)
  for (const value of [
    { ...good, unknown: true }, { ...good, version: 2 }, { ...good, workdir: { ...good.workdir, nodeId: 'other' } },
    { ...good, workdir: { ...good.workdir, online: false } }, { ...good, receipt: { ...good.receipt, projectId: '../escape' } },
    { ...good, receipt: { ...good.receipt, sourceId: 'foreign' } }, { ...good, receipt: { ...good.receipt, workspaceId: 'foreign' } },
    { ...good, receipt: { ...good.receipt, path: 'different' } }, { ...good, receipt: { ...good.receipt, baseCommit: 'HEAD' } },
    { ...good, receipt: { ...good.receipt, extra: true } }, { ...good, receipt: { ...good.receipt, commonIdentity: 'arbitrary' } },
  ]) assert.throws(() => parseDerivedWorkspaceResult(value))
})

test('workdir platform metadata is optional for older Children and strictly validates native OS values', () => {
  const old = result().workdir
  assert(validateWorkdirAdvertisement(old).success)
  for (const platform of ['win32', 'darwin', 'linux']) {
    assert(validateWorkdirAdvertisement({ ...old, platform }).success)
    const parsed = parseDerivedWorkspaceResult({ ...result(), workdir: { ...old, platform } })
    assert.equal(parsed.workdir.platform, platform)
  }
  for (const platform of ['Windows', 'macOS', 'windows', '', '../win32', null, 1, {}, ['win32']]) {
    assert.equal(validateWorkdirAdvertisement({ ...old, platform }).success, false)
    assert.throws(() => parseDerivedWorkspaceResult({ ...result(), workdir: { ...old, platform } }))
  }
})
