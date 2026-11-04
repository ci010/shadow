import assert from 'node:assert/strict'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { withTempWorkspace } from '../testing/workspace.ts'
import { writePrivateFile } from './private-file.ts'

test('private file replacement preserves contents, private permissions and cleans staging files', async () => {
  await withTempWorkspace(async root => {
    const path = join(root, 'credential.json')
    writePrivateFile(path, 'first')
    assert.equal(await readFile(path, 'utf8'), 'first')
    await writeFile(path, 'old', { mode: 0o644 })
    writePrivateFile(path, 'replacement')
    assert.equal(await readFile(path, 'utf8'), 'replacement')
    if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600)
    assert.deepEqual(await readdir(root), ['credential.json'])
    assert.throws(() => writePrivateFile(join(root, 'missing', 'credential.json'), 'never written'))
    assert.deepEqual(await readdir(root), ['credential.json'])
  })
})
