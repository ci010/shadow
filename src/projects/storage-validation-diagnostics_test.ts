import assert from 'node:assert/strict'
import { test } from 'node:test'
import { storageValidationFrames } from './storage-validation-diagnostics.ts'
import { safeStorageValidationFailure, BackendStartupDiagnostics } from '../../desktop/src/sidecar/backend-startup-diagnostics.ts'

test('storage source frames use exact files, bounded positions, and never exception text or private paths', () => {
  const frames = storageValidationFrames({ stack: `TypeError: private-secret
    at privateFunction (C:\\private\\src\\sessions\\session-metadata.ts:12:3)
    at hidden (file:///private/dist/src/sessions/session-store-jsonl.js:91:2)
    at secret (C:/private/src/sessions/unknown.ts:2:3)
    at hidden (C:/private/src/sessions/session-name.ts:0:3)
    at hidden (C:/private/src/sessions/session-name.ts:1234567:3)
    at hidden (C:/private/src/sessions/session-name.ts:2:3) private-secret
    at hidden (C:/private/src/sessions/session-metadata.ts:12:3)` })
  assert.deepEqual(frames, ['src/sessions/session-metadata.ts:12:3', 'src/sessions/session-store-jsonl.js:91:2'])
  const base = { stage: 'jsonl', source: 'jsonl', error: 'TypeError' }
  assert.deepEqual(safeStorageValidationFailure({ ...base, frames }), { ...base, frames })
  for (const invalid of [[], Array(5).fill(frames[0]), ['src/sessions/secret.ts:1:1'], ['C:/private/' + frames[0]], ['src/sessions/session-metadata.ts:0:1'], ['src/sessions/session-metadata.ts:9999999:1'], [1]]) {
    assert.equal(safeStorageValidationFailure({ ...base, frames: invalid }), undefined)
  }
  for (const error of [null, 1, 'secret', { stack: 1 }, { get stack() { throw new Error('private') } }]) assert.deepEqual(storageValidationFrames(error), [])
  assert.equal(storageValidationFrames({ stack: 'Error\n' + Array.from({ length: 10 }, (_, i) => `    at secret (/private/src/sessions/session-name.ts:${i + 1}:1)`).join('\n') }).length, 4)
  const failures: unknown[] = []
  const parser = new BackendStartupDiagnostics(() => {}, entry => failures.push(entry))
  for (const suffix of ['', ' frames=' + frames.join(','), ' frames=C:/private/' + frames[0], ' frames=' + frames[0] + ' message=private']) {
    parser.push('stderr', `[projects] session_storage_validation_failed stage=jsonl source=jsonl error=TypeError${suffix}\n`)
  }
  assert.deepEqual(failures, [base, { ...base, frames }])
})


test('bundled frames permit only dist chunk basenames, eight-character hashes and bounded positions', () => {
  const valid = 'dist/_chunks/session-ownership-B-Ydy7Ep.js:999999:1'
  const base = { stage: 'jsonl', source: 'jsonl', error: 'TypeError' }
  assert.deepEqual(storageValidationFrames({ stack: `TypeError: private\n    at hidden (file:///private/${valid})` }), [valid])
  assert.deepEqual(safeStorageValidationFailure({ ...base, frames: [valid] }), { ...base, frames: [valid] })
  for (const invalid of [
    valid.replace('dist/', ''), valid.replace('_chunks/', '_chunks/private/'),
    valid.replace('_chunks/', '_chunks/../'), valid.replace('dist/', 'other/'),
    valid.replace('B-Ydy7Ep', 'short'), valid.replace('.js', '.ts'),
    valid.replace('999999', '1000000'), valid.replace(':1', ':0'),
    valid.replace('session-ownership', 'x'.repeat(81)), valid + ' secret',
  ]) {
    assert.deepEqual(storageValidationFrames({ stack: `TypeError: private\n    at hidden (file:///private/${invalid})` }), [])
    assert.equal(safeStorageValidationFailure({ ...base, frames: [invalid] }), undefined)
  }
  assert.equal(safeStorageValidationFailure({ ...base, frames: ['C:/private/' + valid] }), undefined)
  assert.equal(safeStorageValidationFailure({ ...base, frames: [valid], message: 'private' }), undefined)
})


test('exact production index entry survives Windows and file URLs, long positions and mixed frames', () => {
  const frames = ['dist/src/index.js:64856:18', 'dist/src/index.js:102408:7', 'dist/src/index.js:999999:999999', 'dist/_chunks/startup-profile-D54eSUnH.js:23:18']
  const stack = `TypeError: private\n    at hidden (C:\\private\\${frames[0].replaceAll('/', '\\')})\n    at hidden (file:///private/${frames[0]})\n` + frames.slice(1).map(frame => `    at hidden (file:///private/${frame})`).join('\n') + '\n    at hidden (/private/src/sessions/session-name.ts:1:1)'
  assert.deepEqual(storageValidationFrames({ stack }), frames)
  const base = { stage: 'jsonl', source: 'jsonl', error: 'TypeError' }
  assert.deepEqual(safeStorageValidationFailure({ ...base, frames }), { ...base, frames })
  for (const invalid of ['dist/src/other.js:1:1', 'dist/src/index.ts:1:1', 'src/index.js:1:1', 'dist/src/nested/index.js:1:1', 'dist/src/../src/index.js:1:1', 'dist/src/index.js:0:1', 'dist/src/index.js:1:0', 'dist/src/index.js:1000000:1', 'dist/src/index.js:1:1000000', 'dist/src/index.js:01:1', 'dist/src/index.js:1:1?secret', 'dist/src/index.js:1:1 secret']) {
    assert.deepEqual(storageValidationFrames({ stack: `TypeError\n    at hidden (file:///private/${invalid})` }), [], invalid)
    assert.equal(safeStorageValidationFailure({ ...base, frames: [invalid] }), undefined, invalid)
  }
  const failures: unknown[] = []
  const parser = new BackendStartupDiagnostics(() => {}, value => failures.push(value))
  const wire = `[projects] session_storage_validation_failed stage=jsonl source=jsonl error=TypeError frames=${frames.join(',')}\r\n`
  for (const char of wire) parser.push('stderr', char)
  assert.deepEqual(failures, [{ ...base, frames }])
})
