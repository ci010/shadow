import { deepEqual as assertEquals, strictEqual as assertStrictEquals } from 'node:assert/strict'
import { test } from 'node:test'
import type { SessionState } from './session-store.ts'
import { sessionPromptLocality } from './session-manager.ts'

const workdir = {
  version: 1 as const,
  nodeId: 'node-a',
  capabilityId: 'project-a',
  displayPathSnapshot: 'C:\\Projects\\a',
}

test('active session prompt context projects persisted locality', () => {
  const state: SessionState = {
    sessionId: 'discord:active',
    segmentIndex: 0,
    workspaceRoot: 'discord:root',
    workdir,
  }

  const locality = sessionPromptLocality(state)

  assertEquals(locality.workspaceRoot, 'discord:root')
  assertStrictEquals(locality.workdir, workdir)
})

test('inactive session prompt context projects persisted locality', () => {
  const persistedState: SessionState = {
    sessionId: 'discord:inactive',
    segmentIndex: 2,
    workspaceRoot: 'discord:root',
    workdir,
  }

  const locality = sessionPromptLocality(persistedState)

  assertEquals(locality.workspaceRoot, 'discord:root')
  assertStrictEquals(locality.workdir, workdir)
})