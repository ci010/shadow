import assert from 'node:assert/strict'
import { mkdir, realpath, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { projectFixture } from '../../projects/test-fixtures.ts'
import { filePreviewLimit } from './contracts.ts'
import { FileReadError, localFiles } from './local-files.ts'

test('local filesystem reads expose sorted entries and bounded previews without HTTP identities', async t => {
  const { folders } = await projectFixture(t)
  await mkdir(join(folders, 'folder'))
  await writeFile(join(folders, 'z.TXT'), 'z'.repeat(300))
  await writeFile(join(folders, 'a.txt'), 'a')
  const signal = new AbortController().signal
  const listing = await localFiles(folders, 'files', '/', signal)
  assert.equal(listing.operation, 'files')
  if (listing.operation !== 'files') assert.fail('Expected directory listing')
  assert.equal(listing.base, await realpath(folders))
  assert.equal(listing.path, '')
  assert.deepEqual(listing.entries.map(({ name, type, ext }) => ({ name, type, ext })), [
    { name: 'folder', type: 'dir', ext: '' },
    { name: 'a.txt', type: 'file', ext: '.txt' },
    { name: 'z.TXT', type: 'file', ext: '.txt' },
  ])
  const preview = await localFiles(folders, 'preview', 'z.TXT', signal, 256)
  assert.equal(preview.operation, 'preview')
  if (preview.operation !== 'preview') assert.fail('Expected preview')
  assert.deepEqual(preview.preview, {
    path: 'z.TXT', size: 300, truncated: true, binary: false, encoding: 'utf-8', content: 'z'.repeat(256),
  })
  assert.equal(preview.target, join(await realpath(folders), 'z.TXT'))
  assert.deepEqual([undefined, '0', 'bad', '1', '999999'].map(filePreviewLimit), [4096, 4096, 4096, 256, 65536])
})

test('local filesystem core preserves path/type errors, missing files and abort reasons', async t => {
  const { root, folders } = await projectFixture(t)
  const outside = join(root, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'secret.txt'), 'outside')
  await symlink(outside, join(folders, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  const signal = new AbortController().signal
  for (const path of ['../outside/secret.txt', 'escape/secret.txt', 'bad\0path']) {
    await assert.rejects(localFiles(folders, 'preview', path, signal),
      error => error instanceof FileReadError && error.code === 'invalid_path')
  }
  await assert.rejects(localFiles(folders, 'preview', '.', signal),
    error => error instanceof FileReadError && error.code === 'not_a_file')
  await assert.rejects(localFiles(folders, 'preview', 'missing', signal), { code: 'ENOENT' })
  const controller = new AbortController()
  const reason = new Error('cancelled by caller')
  controller.abort(reason)
  for (const operation of ['files', 'raw', 'preview'] as const) {
    await assert.rejects(localFiles(folders, operation, 'missing', controller.signal), error => error === reason)
  }
})

test('local raw streams preserve bytes and remain cancellable after ownership transfer', async t => {
  const { folders } = await projectFixture(t)
  const bytes = Buffer.from([0, 255, 17, 128])
  await writeFile(join(folders, 'image.png'), bytes)
  const result = await localFiles(folders, 'raw', 'image.png', new AbortController().signal)
  if (result.operation !== 'raw') assert.fail('Expected raw stream')
  assert.equal(result.size, bytes.length)
  assert.deepEqual(Buffer.from(await new Response(result.stream).arrayBuffer()), bytes)

  const controller = new AbortController()
  const cancelled = await localFiles(folders, 'raw', 'image.png', controller.signal)
  if (cancelled.operation !== 'raw') assert.fail('Expected raw stream')
  controller.abort()
  await assert.rejects(new Response(cancelled.stream).arrayBuffer(), { name: 'AbortError' })
})
