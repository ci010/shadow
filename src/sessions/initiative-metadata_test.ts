import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeInitiativeMetadata, parseInitiativeId, parseWorkRoot } from './initiative-metadata.ts'

test('current Work keys retain Project and Folder metadata without old identity conversion', () => {
  const current = { projectId: 'domain', folderId: 'resource', initiativeId: 'work:1bfc5416-30b2-5627-9659-b4511d4a7f1f', segmentIndex: 2 }
  assert.deepEqual(normalizeInitiativeMetadata(current), current)
  assert.equal(parseWorkRoot('work:1bfc5416-30b2-5627-9659-b4511d4a7f1f'), 'work:1bfc5416-30b2-5627-9659-b4511d4a7f1f')
  assert.equal(parseInitiativeId({}), undefined)
})

test('old selectors, slugs and tool preloads fail explicitly', () => {
  for (const record of [{ projectName: 'cleanup' }, { initiativeName: 'cleanup' }, { initiativeId: 'cleanup' },
    { preloadTools: { project: [] } }, { preloadTools: { initiative: [] } }]) {
    assert.throws(() => normalizeInitiativeMetadata(record), /Unsupported legacy|canonical Work key/)
  }
  for (const key of ['initiative:retained', 'item:retained', 'topic:web:owner', 'work:cleanup', '', '../other', 'work:c0a4d7f3-1966-50f2-8874-fea3c604b719/b', 'work:c0a4d7f3-1966-50f2-8874-fea3c604b719\\b', 'work:', 'work:has space', 42, null]) {
    assert.throws(() => parseWorkRoot(key), /canonical Work key/)
  }
})
