import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeTextPreview, isTextEncoding } from './text-encoding.ts'

test('auto preserves UTF-8 and uses UTF-16 BOMs without treating text as binary', () => {
  assert.deepEqual(decodeTextPreview(new TextEncoder().encode('hello \u65e5\u672c\u8a9e'), 'auto', false),
    { binary: false, encoding: 'utf-8', content: 'hello \u65e5\u672c\u8a9e' })
  assert.equal(decodeTextPreview(Uint8Array.from([0xef, 0xbb, 0xbf, 65]), 'auto', false).content, 'A')
  for (const [encoding, bytes] of [
    ['utf-16le', [0xff, 0xfe, 0xe5, 0x65, 0x2c, 0x67]],
    ['utf-16be', [0xfe, 0xff, 0x65, 0xe5, 0x67, 0x2c]],
  ] as const) {
    assert.deepEqual(decodeTextPreview(Uint8Array.from(bytes), 'auto', false),
      { binary: false, encoding, content: '\u65e5\u672c' })
  }
})

test('legacy bytes warn under UTF-8 rather than silently guessing; explicit encodings decode correctly', () => {
  const japanese = Uint8Array.from([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea, 10])
  assert.match(decodeTextPreview(japanese, 'auto', false).encodingWarning!, /not valid utf-8/)
  assert.deepEqual(decodeTextPreview(japanese, 'shift_jis', false),
    { binary: false, encoding: 'shift_jis', content: '\u65e5\u672c\u8a9e\n' })
  assert.equal(decodeTextPreview(Uint8Array.from([0xd6, 0xd0, 0xce, 0xc4]), 'gb18030', false).content, '\u4e2d\u6587')
  assert.equal(decodeTextPreview(Uint8Array.from([0x63, 0x61, 0x66, 0xe9]), 'windows-1252', false).content, 'caf\u00e9')
  assert.equal(decodeTextPreview(Uint8Array.from([65, 0]), 'utf-16le', false).content, 'A')
})

test('truncated multibyte characters wait for omitted bytes without spurious replacement or warnings', () => {
  for (const [encoding, bytes] of [
    ['utf-8', [65, 0xe6]],
    ['shift_jis', [65, 0x93]],
    ['utf-16le', [65, 0, 0xe5]],
    ['gb18030', [65, 0xd6]],
  ] as const) {
    assert.deepEqual(decodeTextPreview(Uint8Array.from(bytes), encoding, true),
      { binary: false, encoding, content: 'A' })
    assert.ok(decodeTextPreview(Uint8Array.from(bytes), encoding, false).encodingWarning)
  }
})

test('binary detection and supported-encoding validation stay explicit', () => {
  assert.deepEqual(decodeTextPreview(Uint8Array.from([1, 0, 2]), 'auto', false), { binary: true, encoding: 'utf-8' })
  for (const value of [undefined, null, '', 'unknown', 'auto;shift_jis']) assert.equal(isTextEncoding(value), false)
  assert.equal(isTextEncoding('shift_jis'), true)
})
