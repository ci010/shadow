import assert from 'node:assert/strict'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { withTempWorkspace } from '../testing/workspace.ts'
import { projectDataPaths } from './data-paths.ts'
import { readOutputSpill, removeSessionOutput, sessionOutputDirectory, SESSION_OUTPUT_DIR, spillOutputPreview } from './output-spill.ts'
import { cleanupTempFiles, sessionWorkspacePath } from './paths.ts'

const signal = new AbortController().signal

function reference(preview: string): string {
  const path = /Full output saved to: (v:output\/[^\n]+)/.exec(preview)?.[1]
  assert(path, preview)
  return path
}

test('safe-ID collisions do not share spill namespaces; legacy references and cleanup are unchanged', async () => withTempWorkspace(async home => {
  const owner = 'web:family:one'
  const sibling = 'web:family_one'
  assert.equal(sessionWorkspacePath(home, owner), sessionWorkspacePath(home, sibling))
  const own = reference(await spillOutputPreview(home, owner, 'tool-result-exec', 'mine', 2))
  const other = reference(await spillOutputPreview(home, sibling, 'tool-result-exec', 'other', 2))
  assert.equal(await readOutputSpill(home, owner, own, 1, 10, signal), 'mine')
  await assert.rejects(readOutputSpill(home, sibling, own, 1, 10, signal), { code: 'ENOENT' })
  await assert.rejects(readOutputSpill(home, owner, `${own}\n`, 1, 10, signal), /only for generated tool-output/)

  const legacy = 'tool-result-exec-00000000-0000-0000-0000-000000000000.txt'
  const { tmp } = projectDataPaths(home)
  await mkdir(tmp)
  await writeFile(join(tmp, legacy), 'old output')
  assert.equal(await readOutputSpill(home, owner, `.tmp/${legacy}`, 5, 6, signal), 'output')
  await cleanupTempFiles(home, -1000)
  await assert.rejects(readFile(join(tmp, legacy)), { code: 'ENOENT' })
  assert.equal(await readOutputSpill(home, owner, own, 1, 10, signal), 'mine')
  await removeSessionOutput(home, owner)
  await assert.rejects(readOutputSpill(home, owner, own, 1, 10, signal), { code: 'ENOENT' })
  assert.equal(await readOutputSpill(home, sibling, other, 1, 10, signal), 'other')
}))

test('a linked output directory is not traversed for capture, reads, or cleanup', async t => withTempWorkspace(async home => {
  const owner = 'web:here'
  const other = 'web:there'
  const path = reference(await spillOutputPreview(home, other, 'tool-result-exec', 'other', 2))
  await mkdir(sessionWorkspacePath(home, owner))
  try {
    await symlink(join(sessionWorkspacePath(home, other), SESSION_OUTPUT_DIR),
      join(sessionWorkspacePath(home, owner), SESSION_OUTPUT_DIR), 'junction')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error
    t.skip('directory links unavailable')
    return
  }
  assert.match(await spillOutputPreview(home, owner, 'tool-result-exec', 'mine', 2), /Full output was NOT saved/)
  await assert.rejects(readOutputSpill(home, owner, path, 1, 10, signal), /not a link/)
  await assert.rejects(removeSessionOutput(home, owner), /not a link/)
  assert.equal(await readFile(join(sessionOutputDirectory(home, other), path.slice('v:output/'.length)), 'utf8'), 'other')
}))
