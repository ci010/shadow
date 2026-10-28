import assert from 'node:assert/strict'
import test from 'node:test'
import { imagePromptExport, parseKeywords, releaseLibraryImage, type LibraryImage } from './image-library.ts'
test('keywords are normalized and export remains image-bound without inventing a prompt', () => {
  assert.deepEqual(parseKeywords('sky, 山，sky\n green , '), ['sky', '山', 'green'])
  const file = new File(['x'], 'local.png')
  assert.deepEqual(JSON.parse(imagePromptExport({ file, prompt: '', keywords: [], demo: false })), { image: 'local.png', provenance: 'manually-entered', prompt: '', keywords: [] })
  assert.equal(JSON.parse(imagePromptExport({ file, prompt: 'example', keywords: ['demo'], demo: true })).provenance, 'synthetic-demo')
})
test('releases source and candidate owned URLs', () => {
  const revoked: string[] = []
  releaseLibraryImage({ url: 'blob:source', candidateUrl: 'blob:result' } as LibraryImage, url => revoked.push(url))
  assert.deepEqual(revoked, ['blob:source', 'blob:result'])
})
