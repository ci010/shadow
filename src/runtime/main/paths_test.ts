import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { test } from 'node:test'
import { withTempWorkspace } from '../../testing/workspace.ts'
import { resolveSelfCodeRoot, resolveUiDistDirectory } from './paths.ts'

test('Main self-code root preserves workspace preference and sibling fallback', async () => {
  await withTempWorkspace(async root => {
    const workspace = join(root, 'home')
    const sibling = join(root, 'src')
    const local = join(workspace, 'src')
    await mkdir(workspace)
    assert.equal(await resolveSelfCodeRoot(workspace), sibling)
    await mkdir(sibling)
    assert.equal(await resolveSelfCodeRoot(workspace), sibling)
    await mkdir(local)
    assert.equal(await resolveSelfCodeRoot(workspace), local)
    assert.equal(await resolveSelfCodeRoot(relative(process.cwd(), workspace)), local)
    await rm(local, { recursive: true })
    await writeFile(local, 'not a source directory')
    assert.equal(await resolveSelfCodeRoot(workspace), sibling)
  })
})

test('Main UI fallback preserves source and emitted module-relative locations', () => {
  const root = resolve('fixture')
  assert.equal(resolveUiDistDirectory(join(root, 'src', 'runtime', 'main')), join(root, 'app', 'dist'))
  assert.equal(resolveUiDistDirectory(join(root, 'dist', 'src', 'runtime', 'main')), join(root, 'dist', 'app', 'dist'))
  assert.equal(resolveUiDistDirectory(undefined), undefined)
})
