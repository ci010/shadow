import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeInitiativeMetadata, parseInitiativeId } from './initiative-metadata.ts'

test('legacy planning names normalize without colliding with Project or Folder identities', () => {
  const old = { projectId: 'domain', folderId: 'resource', projectName: 'cleanup', segmentIndex: 2 }
  assert.deepEqual(normalizeInitiativeMetadata(old), {
    projectId: 'domain', folderId: 'resource', initiativeId: 'cleanup', segmentIndex: 2,
  })
  assert.equal(old.projectName, 'cleanup')
  assert.deepEqual(normalizeInitiativeMetadata({ initiativeName: 'cleanup' }), { initiativeId: 'cleanup' })
  assert.deepEqual(normalizeInitiativeMetadata({ initiativeId: 'cleanup' }), { initiativeId: 'cleanup' })
  const root = 'work:11111111-1111-4111-8111-111111111111'
  assert.deepEqual(normalizeInitiativeMetadata({ initiativeId: root }), { initiativeId: root })
  assert.equal(parseInitiativeId({}), undefined)
  assert.deepEqual(normalizeInitiativeMetadata({ preloadTools: { project: [], cron: [] } }), {
    preloadTools: { initiative: [], cron: [] },
  })
})

test('initiative metadata rejects corrupt, unsafe and conflicting identities', () => {
  for (const projectName of ['', '../other', 'a/b', 'a\\b', '.', 'a'.repeat(65), 'work:../escape', 'topic:a\\b', 'work:', 42, null]) {
    assert.throws(() => parseInitiativeId({ projectName }), TypeError)
  }
  assert.throws(() => parseInitiativeId({ initiativeId: 'one', projectName: 'two' }), /Conflicting/)
  assert.equal(parseInitiativeId({ initiativeId: 'one', projectName: 'one' }), 'one')
})
