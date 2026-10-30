import { sessionWorkspacePath } from '../utils/paths.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolve } from 'node:path'
import {
  managedSessionWorkdirRef, localFolderWorkdirRef, normalizeSessionLocality,
  parseWorkdirRef, resolveSessionLocations, type WorkdirState,
} from './locality.ts'

test('workdir factories write V2 while retaining deterministic collision-safe resource identities', () => {
  assert.deepEqual(managedSessionWorkdirRef('discord:room'), {
    version: 2, nodeId: 'local', workdirId: 'managed-session-v1:discord%3Aroom',
  })
  assert.notDeepEqual(managedSessionWorkdirRef('discord:room'), managedSessionWorkdirRef('discord_room'))
  assert.deepEqual(localFolderWorkdirRef('folder-a'), { version: 2, nodeId: 'local', workdirId: 'local-project-v1:folder-a' })
})

test('parser normalizes supported storage versions byte-for-byte, rejects ambiguous or unknown identity', () => {
  const workdirId = 'opaque %2F 大写:Exact'
  const current = { version: 2, nodeId: 'node-a', workdirId, displayName: 'Folder A', displayPathSnapshot: 'Z:\\not-main' }
  assert.deepEqual(parseWorkdirRef({ version: 1, nodeId: 'node-a', capabilityId: workdirId,
    displayName: 'Folder A', displayPathSnapshot: current.displayPathSnapshot }), current)
  assert.deepEqual(parseWorkdirRef(current), current)
  for (const invalid of [null, [], {}, { ...current, version: 3 }, { ...current, nodeId: '' },
    { ...current, workdirId: '' }, { ...current, workdirId: undefined }, { ...current, displayName: 42 },
    { ...current, ignored: true }, { ...current, capabilityId: 'ambiguous' }, { version: 1, nodeId: 'local', workdirId: 'wrong-model' }]) {
    assert.equal(parseWorkdirRef(invalid), null)
    assert.throws(() => normalizeSessionLocality({ sessionId: 'legacy', workdir: invalid as never }), /Invalid|unsupported/)
  }
})

test('local folders resolve only trusted absolute resource paths, retaining private session data', () => {
  const workdir = { ...localFolderWorkdirRef('folder-a'), displayPathSnapshot: resolve('untrusted') }
  const state = { sessionId: 'web:child', workspaceRoot: 'web:owner', workdir }
  const workspace = resolve('main')
  const path = resolve('folder-a')
  const result = resolveSessionLocations(workspace, state, undefined, () => ({
    node: 'online', workdir: { online: true, path },
  }))
  assert.equal(result.sessionDataDir, sessionWorkspacePath(workspace, 'web:owner'))
  assert.deepEqual(result.workdir, { available: true, locality: 'local', workdir, path })
  for (const resource of [undefined, { online: true },
    { online: true, path: 'relative-folder' }, { online: false, path },
    { kind: 'shell', online: true, path }]) {
    assert.equal(resolveSessionLocations(workspace, state, undefined, () => ({ node: 'online', resource })).workdir.available, false)
  }
  assert.equal(resolveSessionLocations(workspace, state).workdir.available, false)
})

test('remote directory resources never expose lookup or display paths locally', () => {
  const workdir = { version: 2 as const, nodeId: 'remote', workdirId: 'folder', displayPathSnapshot: resolve('untrusted') }
  const result = resolveSessionLocations(resolve('main'), { sessionId: 'web:chat', workdir }, undefined, () => ({
    node: 'online', workdir: { online: true, path: resolve('folder-a') },
  }))
  assert.deepEqual(result.workdir, { available: true, locality: 'remote', workdir })
  assert.equal('path' in result.workdir, false)
})

test('absent legacy state normalizes to its existing managed owner and accepts the local alias', () => {
  const workspace = resolve('workspace')
  const topLevel = normalizeSessionLocality({ sessionId: 'discord:top' })
  const nested = normalizeSessionLocality({ sessionId: 'subagent:child', workspaceRoot: 'discord:top' })
  assert.deepEqual(nested.workdir, topLevel.workdir)
  assert.deepEqual(resolveSessionLocations(workspace, topLevel, 'main-device'), {
    home: workspace, sessionDataDir: sessionWorkspacePath(workspace, 'discord:top'),
    workdir: { available: true, locality: 'local', workdir: topLevel.workdir, path: sessionWorkspacePath(workspace, 'discord:top') },
  })
})

test('unavailable and protocol-incompatible targets preserve exact selection and never fall back', () => {
  const workdir = { version: 2 as const, nodeId: 'remote', workdirId: 'folder' }
  const cases: [WorkdirState, string][] = [
    [{ node: 'missing' }, 'node-missing'], [{ node: 'offline' }, 'node-offline'],
    [{ node: 'revoked' }, 'workdir-revoked'], [{ node: 'online' }, 'workdir-missing'],
    [{ node: 'online', workdir: { online: false } }, 'workdir-offline'],
    [{ node: 'online', incompatible: true, workdir: { online: true } }, 'incompatible'],
    [{ node: 'online', incompatible: true, workdir: { online: true } }, 'incompatible'],
  ]
  for (const [state, reason] of cases) assert.deepEqual(
    resolveSessionLocations('.', { sessionId: 'test', workdir }, undefined, () => state).workdir,
    { available: false, workdir, reason },
  )
  assert.deepEqual(resolveSessionLocations('.', { sessionId: 'test', workdir: { ...workdir, nodeId: 'local' } }).workdir,
    { available: false, workdir: { ...workdir, nodeId: 'local' }, reason: 'workdir-missing' })
})

test('explicit native managed refs honor authoritative refusal while absent legacy defaults stay local', () => {
  const workdir = managedSessionWorkdirRef('native')
  for (const state of [{ node: 'revoked' }, { node: 'offline' }, { node: 'missing' },
    { node: 'online', incompatible: true }, { node: 'online', workdir: { online: false } }] as const) {
    assert.equal(resolveSessionLocations('.', { sessionId: 'native', workdir }, undefined, () => state).workdir.available, false)
    assert.equal(resolveSessionLocations('.', { sessionId: 'native' }, undefined, () => state).workdir.available, true)
  }
})


test('live workdir refs reject both retired storage generations and mixed addressing', async () => {
  const { parseLiveWorkdirRef } = await import('./locality.ts')
  const current = { version: 2, nodeId: 'child', workdirId: 'same-bytes' }
  assert.deepEqual(parseLiveWorkdirRef(current), current)
  for (const value of [
    { version: 1, nodeId: 'child', capabilityId: 'same-bytes' },
    { version: 2, nodeId: 'child', resourceId: 'same-bytes' },
    { ...current, resourceId: 'same-bytes' }, { ...current, capabilityId: 'same-bytes' },
    { ...current, unknown: true },
  ]) assert.equal(parseLiveWorkdirRef(value), null)
})
