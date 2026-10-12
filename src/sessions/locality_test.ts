import { sessionWorkspacePath } from '../utils/paths.ts'
import { deepEqual as assertEquals, notDeepEqual as assertNotEquals } from 'node:assert/strict'
import { test } from 'node:test'
import { resolve } from 'node:path'
import {
  managedSessionWorkdirRef,
  localFolderWorkdirRef,
  normalizeSessionLocality,
  parseWorkdirRefV1,
  resolveSessionLocations,
} from './locality.ts'

test('managed compatibility capabilities are deterministic and collision-safe', () => {
  assertEquals(
    managedSessionWorkdirRef('discord:room'),
    managedSessionWorkdirRef('discord:room'),
  )
  assertNotEquals(
    managedSessionWorkdirRef('discord:room'),
    managedSessionWorkdirRef('discord_room'),
  )
})

test('local folders resolve only trusted absolute capability paths, retaining private session data', () => {
  const workdir = { ...localFolderWorkdirRef('folder-a'), displayPathSnapshot: resolve('untrusted') }
  const state = { sessionId: 'web:child', workspaceRoot: 'web:owner', workdir }
  const workspace = resolve('main')
  const path = resolve('folder-a')
  const result = resolveSessionLocations(workspace, state, undefined, () => ({
    node: 'online',
    capability: { kind: 'workdir', online: true, path },
  }))
  assertEquals(workdir.capabilityId, 'local-project-v1:folder-a')
  assertEquals(result.sessionDataDir, sessionWorkspacePath(workspace, 'web:owner'))
  assertEquals(result.workdir, { available: true, locality: 'local', workdir, path })
  for (const capability of [
    undefined,
    { kind: 'workdir', online: true },
    { kind: 'workdir', online: true, path: 'relative-folder' },
    { kind: 'workdir', online: false, path },
    { kind: 'shell', online: true, path },
  ]) {
    assertEquals(resolveSessionLocations(workspace, state, undefined, () => ({
      node: 'online',
      capability,
    })).workdir.available, false)
  }
  assertEquals(resolveSessionLocations(workspace, state).workdir.available, false)
})

test('remote folder capabilities never expose a trusted lookup path locally', () => {
  const workdir = { ...localFolderWorkdirRef('folder-a'), nodeId: 'remote', displayPathSnapshot: resolve('untrusted') }
  const result = resolveSessionLocations(resolve('main'), { sessionId: 'web:chat', workdir }, undefined, () => ({
    node: 'online',
    capability: { kind: 'workdir', online: true, path: resolve('folder-a') },
  }))
  assertEquals(result.workdir, { available: true, locality: 'remote', workdir })
  assertEquals('path' in result.workdir, false)
})

test('WorkdirRefV1 parser validates persisted data and ignores unknown fields', () => {
  assertEquals(
    parseWorkdirRefV1({
      version: 1,
      nodeId: 'node-a',
      capabilityId: 'cap-a',
      displayName: 'Folder A',
      futureField: true,
    }),
    {
      version: 1,
      nodeId: 'node-a',
      capabilityId: 'cap-a',
      displayName: 'Folder A',
    },
  )
  assertEquals(
    parseWorkdirRefV1({ version: 2, nodeId: 'node-a', capabilityId: 'cap-a' }),
    null,
  )
  assertEquals(
    parseWorkdirRefV1({ version: 1, nodeId: '', capabilityId: 'cap-a' }),
    null,
  )
})

test('legacy state normalizes to its existing managed folder', () => {
  const workspace = resolve('workspace')
  const topLevel = normalizeSessionLocality({ sessionId: 'discord:top' })
  const nested = normalizeSessionLocality({
    sessionId: 'subagent:child',
    workspaceRoot: 'discord:top',
  })

  assertEquals(nested.workdir, topLevel.workdir)
  assertEquals(resolveSessionLocations(workspace, topLevel), {
    home: workspace,
    sessionDataDir: sessionWorkspacePath(workspace, 'discord:top'),
    workdir: {
      available: true,
      locality: 'local',
      workdir: topLevel.workdir,
      path: sessionWorkspacePath(workspace, 'discord:top'),
    },
  })
})

test('resolver exposes an online remote workdir without inventing a local path', () => {
  const workspace = resolve('workspace')
  const state = {
    sessionId: 'discord:top',
    workdir: {
      version: 1 as const,
      nodeId: 'remote-node',
      capabilityId: 'workdir-1',
    },
  }
  const locations = resolveSessionLocations(workspace, state, 'local', () => ({
    node: 'online',
    capability: { kind: 'workdir', online: true },
  }))

  assertEquals(locations.workdir, {
    available: true,
    locality: 'remote',
    workdir: state.workdir,
  })
  assertEquals('path' in locations.workdir, false)

  const incompatible = resolveSessionLocations(
    workspace,
    state,
    'local',
    () => ({
      node: 'online',
      capability: { kind: 'shell', online: true },
    }),
  )
  assertEquals(incompatible.workdir.available, false)
  if (!incompatible.workdir.available) {
    assertEquals(incompatible.workdir.reason, 'incompatible')
  }
})

test('resolver reports non-local and unknown capabilities as unavailable', () => {
  const workspace = resolve('workspace')
  const remote = resolveSessionLocations(workspace, {
    sessionId: 'discord:top',
    workdir: {
      version: 1,
      nodeId: 'remote-node',
      capabilityId: 'remote-capability',
    },
  })
  const unknownLocal = resolveSessionLocations(workspace, {
    sessionId: 'discord:top',
    workdir: {
      version: 1,
      nodeId: 'local',
      capabilityId: 'revoked-or-unknown',
    },
  })

  assertEquals(remote.workdir.available, false)
  if (!remote.workdir.available) {
    assertEquals(remote.workdir.reason, 'node-missing')
  }
  assertEquals(unknownLocal.workdir.available, false)
  if (!unknownLocal.workdir.available) {
    assertEquals(unknownLocal.workdir.reason, 'capability-missing')
  }
})
