import { deepEqual as assertEquals, notDeepEqual as assertNotEquals } from 'node:assert/strict'
import { test } from 'node:test'
import { resolve } from 'node:path'
import {
  managedSessionWorkdirRef,
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

test('WorkdirRefV1 parser validates persisted data and ignores unknown fields', () => {
  assertEquals(
    parseWorkdirRefV1({
      version: 1,
      nodeId: 'node-a',
      capabilityId: 'cap-a',
      displayName: 'Project A',
      futureField: true,
    }),
    {
      version: 1,
      nodeId: 'node-a',
      capabilityId: 'cap-a',
      displayName: 'Project A',
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
    sessionDataDir: resolve(workspace, 'discord_top'),
    workdir: {
      available: true,
      locality: 'local',
      workdir: topLevel.workdir,
      path: resolve(workspace, 'discord_top'),
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
