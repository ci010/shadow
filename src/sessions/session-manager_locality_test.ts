import { deepEqual as assertEquals, strictEqual as assertStrictEquals } from 'node:assert/strict'
import { test } from 'node:test'
import type { SessionState } from './session-store.ts'
import { sessionPromptLocality } from './session-manager.ts'

const workdir = {
  version: 1 as const,
  nodeId: 'node-a',
  capabilityId: 'folder-a',
  displayPathSnapshot: 'C:\\Folders\\a',
}

test('active session prompt context folders persisted locality', () => {
  const state: SessionState = {
    sessionId: 'discord:active',
    segmentIndex: 0,
    workspaceRoot: 'discord:root',
    workdir,
    folderId: 'selected-folder',
  }

  const locality = sessionPromptLocality(state)

  assertEquals(locality.workspaceRoot, 'discord:root')
  assertStrictEquals(locality.workdir, workdir)
  assertEquals(locality.folderId, 'selected-folder')
})

test('inactive session prompt context folders persisted locality', () => {
  const persistedState: SessionState = {
    sessionId: 'discord:inactive',
    segmentIndex: 2,
    workspaceRoot: 'discord:root',
    workdir,
    folderId: 'selected-folder',
  }

  const locality = sessionPromptLocality(persistedState)

  assertEquals(locality.workspaceRoot, 'discord:root')
  assertStrictEquals(locality.workdir, workdir)
  assertEquals(locality.folderId, 'selected-folder')
})

test('scratch session prompt has no selected folder even with a workdir capability', () => {
  assertEquals(sessionPromptLocality(undefined), { workspaceRoot: undefined, workdir: undefined, folderId: undefined })
  const locality = sessionPromptLocality({ workdir })
  assertEquals(locality.folderId, undefined)
  assertStrictEquals(locality.workdir, workdir)
})