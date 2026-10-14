import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { parse } from 'yaml'

test('dependency patches retain LF line endings in Windows checkouts', async () => {
  const attributes = await readFile(new URL('../.gitattributes', import.meta.url), 'utf8')
  assert.match(attributes, /^patches\/\*\.patch text eol=lf$/m)
  const workspace = parse(await readFile(new URL('../pnpm-workspace.yaml', import.meta.url), 'utf8'))
  for (const path of Object.values(workspace.patchedDependencies)) {
    assert.equal(typeof path, 'string')
    const patch = await readFile(new URL(`../${path}`, import.meta.url), 'utf8')
    assert.doesNotMatch(patch, /\r/, `pnpm requires LF patch headers: ${path}`)
    assert.match(patch, /^diff --git /m)
  }
})
