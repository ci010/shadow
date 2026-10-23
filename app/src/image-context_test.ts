import assert from 'node:assert/strict'
import test from 'node:test'
import { hasImageReference, imageSourcePath, IMAGE_REFERENCE_MIME, readImageReference, startImageReferenceDrag } from './image-context.ts'

function transfer(): Pick<DataTransfer, 'effectAllowed' | 'types' | 'setData' | 'getData'> {
  const values = new Map<string, string>()
  return {
    effectAllowed: 'none',
    get types() { return Array.from(values.keys()) },
    setData: (type: string, value: string) => { values.set(type, value) },
    getData: (type: string) => values.get(type) ?? '',
  }
}

test('image drags carry an owned File snapshot, not a fetchable URL or serialized file path', () => {
  const data = transfer()
  const reference = { sourceKey: 'session-a/image.png', file: new File(['original'], 'image.png', { type: 'image/png' }),
    source: { path: 'C:\\folder\\image.png', modified: false } }
  const release = startImageReferenceDrag(data, reference)
  assert.equal(data.effectAllowed, 'copy')
  assert.deepEqual(data.types, [IMAGE_REFERENCE_MIME])
  assert.equal(hasImageReference(data), true)
  assert.equal(readImageReference(data), reference)
  assert.deepEqual(readImageReference(data)?.source, { path: 'C:\\folder\\image.png', modified: false })
  release()
  release()
  assert.throws(() => readImageReference(data), /no longer available/)
})

test('external URLs and forged references are never resolved into image attachments', () => {
  const data = transfer()
  data.setData('text/uri-list', 'file:///private/image.png')
  assert.equal(hasImageReference(data), false)
  assert.equal(readImageReference(data), undefined)
  data.setData(IMAGE_REFERENCE_MIME, 'https://untrusted.example/image')
  assert.throws(() => readImageReference(data), /Drag the image again/)
  assert.equal(readImageReference(null), undefined)
})

test('simultaneous drags retain independent snapshots and cleanup does not affect another image', () => {
  const a = transfer(), b = transfer()
  const file = new File(['marked'], 'marked.png', { type: 'image/png' })
  const releaseA = startImageReferenceDrag(a, { sourceKey: 'a', file, source: { path: '/folder-a/image.png', modified: true } })
  const releaseB = startImageReferenceDrag(b, { sourceKey: 'b', file, source: { path: '/folder-b/image.png', modified: true } })
  assert.notEqual(a.getData(IMAGE_REFERENCE_MIME), b.getData(IMAGE_REFERENCE_MIME))
  releaseA()
  assert.equal(readImageReference(b)?.file, file)
  assert.deepEqual(readImageReference(b)?.source, { path: '/folder-b/image.png', modified: true })
  releaseB()
})

test('image provenance decodes canonical source headers without interpreting display paths or raw URLs', () => {
  for (const path of ['C:\\folder\\images\\\u56fe\u7247 % #.png', '/home/user/images/diagram.png', '\\\\server\\share\\image.png']) {
    assert.equal(imageSourcePath(new Headers({ 'X-Shadow-Source-Path': encodeURIComponent(path) })), path)
  }
  assert.throws(() => imageSourcePath(new Headers()), /Restart Main/)
  for (const encoded of ['%ZZ', 'image.png', encodeURIComponent('C:relative.png'), encodeURIComponent('/path/\0.png')]) {
    assert.throws(() => imageSourcePath(new Headers({ 'X-Shadow-Source-Path': encoded })), /source path is invalid/)
  }
})
