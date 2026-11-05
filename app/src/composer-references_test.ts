import assert from 'node:assert/strict'
import { test } from 'node:test'
import { composerReferences } from './composer-references.ts'
import { insertSessionReference } from './session-references.ts'

test('session chips project existing serialization without changing protocol or escaped titles', () => {
  const inserted = insertSessionReference('before @ after', { start: 7, end: 8 }, { sessionId: 'web:other', title: 'A [test] <tag>' }, 'project a')
  const [chip] = composerReferences(inserted.text)
  assert.equal(chip?.label, 'A [test] <tag>')
  assert.equal(chip?.href, '/projects/project%20a/chat/web%3Aother')
  assert.equal(inserted.text.slice(chip!.start, chip!.end), chip!.raw)
  assert.equal(inserted.text.slice(0, chip!.start) + chip!.raw + inserted.text.slice(chip!.end), inserted.text)
  assert.deepEqual(composerReferences('[ordinary](https://example.com) `not an image`'), [])
})
test('image chips match exact stable references, repeated occurrences and ignore missing attachments', () => {
  const images = [{ key: 'id', label: 'a.png', reference: '` "a.png" · image:id `' }]
  const text = `compare ${images[0]!.reference} and ${images[0]!.reference}`
  const chips = composerReferences(text, images)
  assert.equal(chips.length, 2)
  assert.ok(chips[0]!.end < chips[1]!.start)
  assert.equal(chips[1]!.key, 'id')
  assert.deepEqual(composerReferences(text), [])
})
