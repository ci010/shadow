import assert from 'node:assert/strict'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { folderFixture } from '../../folders/test-fixtures.ts'
import { searchWorkspaceFiles } from './search-files.ts'

test('ripgrep searches nested relative paths using ignore rules without traversing symlinks', async t => {
  const { root, folders } = await folderFixture(t)
  await mkdir(join(folders, 'deep'))
  await mkdir(join(root, 'outside'))
  await writeFile(join(folders, '.gitignore'), 'ignored.md\n')
  await writeFile(join(folders, 'deep', 'Notes.MD'), 'inside')
  await writeFile(join(folders, 'ignored.md'), 'ignored')
  await writeFile(join(root, 'outside', 'Notes.MD'), 'outside')
  await symlink(join(root, 'outside'), join(folders, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  const signal = new AbortController().signal
  assert.deepEqual(await searchWorkspaceFiles(folders, 'notes', signal), { paths: ['deep/Notes.MD'], truncated: false })
  assert.deepEqual(await searchWorkspaceFiles(folders, 'ignored', signal), { paths: [], truncated: false })
  assert.deepEqual(await searchWorkspaceFiles(folders, 'linked', signal), { paths: [], truncated: false })
  const controller = new AbortController()
  controller.abort(new Error('cancelled'))
  await assert.rejects(searchWorkspaceFiles(folders, 'notes', controller.signal), /cancelled/)
  await assert.rejects(searchWorkspaceFiles(folders, 'bad\nquery', signal), /Invalid file search query/)
})

test('ripgrep path search bounds large result sets', async t => {
  const { folders } = await folderFixture(t)
  await Promise.all(Array.from({ length: 205 }, (_, index) =>
    writeFile(join(folders, `match-${index}.txt`), '')))
  const result = await searchWorkspaceFiles(folders, 'match-', new AbortController().signal)
  assert.equal(result.paths.length, 200)
  assert.equal(result.truncated, true)
})
