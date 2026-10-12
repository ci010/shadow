import assert from 'node:assert/strict'
import test from 'node:test'
import { canShowInExplorer, fileTreePaths, fileTreeShortcut } from './file-tree-menu.ts'

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

test('file shortcuts match explicit modifiers and respect handled keys and composition', () => {
  const key = { key: 'c', ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, isComposing: false, defaultPrevented: false }
  assert.equal(fileTreeShortcut(key), 'copy-full')
  assert.equal(fileTreeShortcut({ ...key, key: 'C', shiftKey: true }), 'copy-relative')
  assert.equal(fileTreeShortcut({ ...key, key: 'R', ctrlKey: false, shiftKey: true, altKey: true }), 'reveal')
  for (const override of [{ altKey: true }, { metaKey: true }, { ctrlKey: false }, { isComposing: true }, { defaultPrevented: true }, { key: 'x' }]) {
    assert.equal(fileTreeShortcut({ ...key, ...override }), undefined)
  }
})
