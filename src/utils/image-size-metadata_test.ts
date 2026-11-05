import assert from 'node:assert/strict'
import test from 'node:test'
import { base64SizeMetadata, imageUrlSizeMetadata } from './image-size-metadata.ts'

test('base64 lengths distinguish encoded payload from strictly computable decoded bytes', () => {
  for (const [payload, decodedBytes] of [['', 0], ['YQ==', 1], ['YQ', 1], ['YWI=', 2], ['YWI', 2], ['YWJj', 3]] as const) {
    assert.deepEqual(base64SizeMetadata(payload), { base64Characters: payload.length, base64Bytes: payload.length, decodedBytes })
  }
  for (const payload of ['A', 'YQ=', 'YQ===', 'YR==', 'YWJ=', 'Y Q==', '-_==', '图片']) {
    assert.deepEqual(base64SizeMetadata(payload), { base64Characters: payload.length, base64Bytes: Buffer.byteLength(payload) })
  }
  assert.equal(imageUrlSizeMetadata('https://private.example/a'), undefined)
  assert.deepEqual(imageUrlSizeMetadata('data:image/png;base64,YQ=='), { base64Characters: 4, base64Bytes: 4, decodedBytes: 1 })
})
