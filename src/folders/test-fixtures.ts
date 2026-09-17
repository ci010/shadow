import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { TestContext } from 'node:test'

export async function folderFixture(t: TestContext) {
  const root = await mkdtemp(resolve('.folder-tests-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'main')
  const folders = join(root, 'folders')
  await Promise.all([mkdir(workspace), mkdir(folders)])
  return { root, workspace, folders }
}
