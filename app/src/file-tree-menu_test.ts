import assert from 'node:assert/strict'
import test from 'node:test'
import { canShowInExplorer, fileTreePaths } from './file-tree-menu.ts'

test('file paths are relative to the displayed workdir and preserve its platform', () => {
  for (const [root, path, full] of [
    ['C:\\project', 'src/a.ts', 'C:\\project\\src\\a.ts'],
    ['C:\\', 'a.ts', 'C:\\a.ts'],
    ['\\\\host\\share\\', 'src/a.ts', '\\\\host\\share\\src\\a.ts'],
    ['/project/', 'src/a.ts', '/project/src/a.ts'],
    ['/', 'a.ts', '/a.ts'],
  ]) {
    assert.deepEqual(fileTreePaths({ kind: 'local', displayPath: root! }, path!), { full, relative: path })
  }
  assert.deepEqual(fileTreePaths({ kind: 'local', displayPath: '/project' }, ''), { full: '/project', relative: '.' })
  assert.deepEqual(fileTreePaths(undefined, 'src/a.ts'), { full: '', relative: 'src/a.ts' })
})

test('native reveal is only available for local physical paths in Electron', () => {
  const local = { kind: 'local' as const, displayPath: '/project' }
  assert.equal(canShowInExplorer(local, true), true)
  assert.equal(canShowInExplorer(local, false), false)
  assert.equal(canShowInExplorer(local, true, true), false)
  assert.equal(canShowInExplorer({ ...local, kind: 'remote' }, true), false)
  assert.equal(canShowInExplorer({ ...local, displayPath: null }, true), false)
  assert.equal(canShowInExplorer(undefined, true), false)
})
