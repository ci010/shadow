import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { resolveUiDistDirectory } from './paths.ts'

test('Main UI fallback preserves source and emitted module-relative locations', () => {
  const root = resolve('fixture')
  assert.equal(resolveUiDistDirectory(join(root, 'src', 'runtime', 'main')), join(root, 'app', 'dist'))
  assert.equal(resolveUiDistDirectory(join(root, 'dist', 'src', 'runtime', 'main')), join(root, 'dist', 'app', 'dist'))
  assert.equal(resolveUiDistDirectory(undefined), undefined)
})
