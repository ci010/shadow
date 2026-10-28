import assert from 'node:assert/strict'
import test from 'node:test'
import { editorDemoSamples, editorWavePath, editorWaveThumbnail } from './alignment-editor.ts'
test('editor waveform represents actual source samples within caller source width', () => {
  assert.equal(editorDemoSamples.length, 192000)
  const path = editorWavePath(576)
  assert.ok(path.startsWith('M0,'))
  assert.ok(path.includes('M574,'))
  assert.ok(!path.includes('M576,'))
  assert.equal(editorWavePath(0), '')
  assert.equal(editorWavePath(4, new Float32Array(40)), 'M0,30v0 M2,30v0 ')
  assert.ok(editorWaveThumbnail(editorDemoSamples).startsWith('data:image/svg+xml,'))
})
