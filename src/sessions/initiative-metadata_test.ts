import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeInitiativeMetadata, parseInitiativeId, parseWorkRoot } from './initiative-metadata.ts'

test('current Work keys retain Project and Folder metadata without old identity conversion', () => {
  const current = { projectId: 'domain', folderId: 'resource', initiativeId: 'work:cleanup', segmentIndex: 2 }
  assert.deepEqual(normalizeInitiativeMetadata(current), current)
  assert.equal(parseWorkRoot('work:cleanup'), 'work:cleanup')
  assert.equal(parseInitiativeId({}), undefined)
  // These are persisted current Work keys, not aliases for old slugs.
  for (const key of ['initiative:retained', 'item:retained', 'topic:web:owner']) assert.equal(parseWorkRoot(key), key)
})

test('old selectors, slugs and tool preloads fail explicitly', () => {
  for (const record of [{ projectName: 'cleanup' }, { initiativeName: 'cleanup' }, { initiativeId: 'cleanup' },
    { preloadTools: { project: [] } }, { preloadTools: { initiative: [] } }]) {
    assert.throws(() => normalizeInitiativeMetadata(record), /Unsupported legacy|canonical Work key/)
  }
  for (const key of ['', '../other', 'work:a/b', 'work:a\\b', 'work:', 'work:has space', 42, null]) {
    assert.throws(() => parseWorkRoot(key), /canonical Work key/)
  }
})
