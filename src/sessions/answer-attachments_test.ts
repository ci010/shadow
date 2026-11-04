import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createTempWorkspace } from '../testing/workspace.ts'
import { sessionWorkspacePath } from '../utils/paths.ts'
import { validateAnswerUploads } from './answer-attachments.ts'

test('remote custom answers accept own validated images but reject plain files and other sessions', async () => {
  const workspace = await createTempWorkspace()
  try {
    const root = join(sessionWorkspacePath(workspace, 'web:remote'), 'uploads')
    const other = join(sessionWorkspacePath(workspace, 'web:other'), 'uploads')
    await mkdir(root, { recursive: true }); await mkdir(other, { recursive: true })
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
    await writeFile(join(root, 'image.png'), png)
    await writeFile(join(other, 'image.png'), png)
    await writeFile(join(root, 'file.txt'), 'fixture')
    await validateAnswerUploads(workspace, 'web:remote', [join(root, 'image.png')], undefined, true)
    for (const path of [join(other, 'image.png'), join(root, 'file.txt'), 'child.png']) {
      await assert.rejects(validateAnswerUploads(workspace, 'web:remote', [path], undefined, true), TypeError)
    }
    await validateAnswerUploads(workspace, 'web:remote', [join(root, 'file.txt')])
  } finally { await rm(workspace, { recursive: true }) }
})
