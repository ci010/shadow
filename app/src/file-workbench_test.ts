import { test } from 'node:test'
import assert from 'node:assert/strict'
import { closeFileTab, cycleDocumentTab, documentTabDirection, documentTabScrollLeft, fileTabKey, isCloseDocumentKey, nextDocumentTab, openFileTab, selectedFileToClose, type DocumentTabKey, type DocumentTabWheel, type FileTabs } from './file-workbench.ts'

const file = (path: string) => ({ path, entry: { name: path.split('/').at(-1)!, ext: '.md', type: 'file' as const, size: 12, mtime: null } })
test('opening files retains existing tabs, deduplicates by full path and selects without replacing state', () => {
  const initial: FileTabs = { files: [], selected: '' }
  const first = openFileTab(initial, file('README.md'))
  const second = openFileTab(first, file('docs/README.md'))
  const reopened = openFileTab(second, file('README.md'))
  assert.equal(initial.files.length, 0)
  assert.equal(second.files.length, 2)
  assert.equal(reopened.files, second.files)
  assert.equal(reopened.selected, 'README.md')
})
test('closing a file selects the nearest remaining file or conversation without changing other tabs', () => {
  const state = openFileTab(openFileTab({ files: [], selected: '' }, file('a.md')), file('b.md'))
  assert.equal(closeFileTab(state, 'a.md').selected, 'b.md')
  const closed = closeFileTab(state, 'b.md')
  assert.equal(closed.selected, 'a.md')
  assert.equal(closeFileTab(closed, 'a.md').selected, '')
  assert.equal(closeFileTab(state, 'missing'), state)
  assert.equal(closeFileTab({ ...state, selected: '' }, 'b.md').selected, '')
})
test('document keyboard navigation wraps and includes conversation', () => {
  const paths = ['', 'a.md', 'b.md']
  assert.equal(nextDocumentTab(paths, '', 'ArrowLeft'), 'b.md')
  assert.equal(nextDocumentTab(paths, 'b.md', 'ArrowRight'), '')
  assert.equal(nextDocumentTab(paths, 'a.md', 'Home'), '')
  assert.equal(nextDocumentTab(paths, '', 'End'), 'b.md')
  assert.equal(nextDocumentTab(paths, '', 'Escape'), undefined)
})

test('source and diff documents for the same path remain independently selectable and closable', () => {
  const source = file('src/main.ts')
  const diff = { ...source, view: 'diff' as const }
  const state = openFileTab(openFileTab({ files: [], selected: '' }, source), diff)
  assert.equal(state.files.length, 2)
  assert.equal(state.selected, fileTabKey(diff))
  assert.equal(openFileTab(state, diff).files, state.files)
  assert.equal(openFileTab(state, source).selected, source.path)
  assert.equal(closeFileTab(state, source.path).selected, fileTabKey(diff))
  assert.equal(closeFileTab(state, fileTabKey(diff)).selected, source.path)
  assert.notEqual(fileTabKey(diff), fileTabKey(file('diff:src/main.ts')))
})

const tabKey: DocumentTabKey = {
  key: 'Tab', ctrlKey: true, shiftKey: false, altKey: false, metaKey: false,
  isComposing: false, keyCode: 9, defaultPrevented: false,
}
const available = {
  active: true, keyboardActive: true, visible: true, explorerEnabled: true,
  overlayOpen: false, composing: false,
}

test('Ctrl+W closes only the active source or diff document, never Conversation or an inactive pane', () => {
  assert.equal(isCloseDocumentKey({ ...tabKey, key: 'w' }), true)
  assert.equal(isCloseDocumentKey({ ...tabKey, key: 'W' }), true)
  for (const patch of [{ ctrlKey: false }, { shiftKey: true }, { altKey: true }, { metaKey: true },
    { isComposing: true }, { keyCode: 229 }, { defaultPrevented: true }, { repeat: true }]) {
    assert.equal(isCloseDocumentKey({ ...tabKey, key: 'w', ...patch }), false)
  }
  const source = file('a.md')
  const diff = { ...source, view: 'diff' as const }
  const state = openFileTab(openFileTab({ files: [], selected: '' }, source), diff)
  assert.equal(selectedFileToClose(state, available), fileTabKey(diff))
  const after = closeFileTab(state, selectedFileToClose(state, available)!)
  assert.equal(after.selected, source.path)
  assert.equal(closeFileTab(after, selectedFileToClose(after, available)!).selected, '')
  assert.equal(selectedFileToClose({ ...state, selected: '' }, available), undefined)
  for (const patch of [{ active: false }, { keyboardActive: false }, { visible: false },
    { explorerEnabled: false }, { overlayOpen: true }, { composing: true }]) {
    assert.equal(selectedFileToClose(state, { ...available, ...patch }), undefined)
  }
})

const wheel: DocumentTabWheel = { deltaX: 0, deltaY: 40, deltaMode: 0, ctrlKey: false, defaultPrevented: false }
const strip = { scrollLeft: 100, scrollWidth: 1000, clientWidth: 400 }
test('tab wheel maps vertical movement while preserving horizontal trackpad direction and units', () => {
  assert.equal(documentTabScrollLeft(wheel, strip), 140)
  assert.equal(documentTabScrollLeft({ ...wheel, deltaX: -25 }, strip), 75)
  assert.equal(documentTabScrollLeft({ ...wheel, deltaY: 2, deltaMode: 1 }, strip), 132)
  assert.equal(documentTabScrollLeft({ ...wheel, deltaY: 1, deltaMode: 2 }, strip), 500)
})

test('tab wheel clamps and leaves zoom, handled events and nonoverflowing strips alone', () => {
  assert.equal(documentTabScrollLeft({ ...wheel, deltaY: 1000 }, strip), 600)
  assert.equal(documentTabScrollLeft({ ...wheel, deltaY: -1000 }, strip), 0)
  for (const patch of [{ ctrlKey: true }, { defaultPrevented: true }, { deltaY: 0 }]) {
    assert.equal(documentTabScrollLeft({ ...wheel, ...patch }, strip), undefined)
  }
  assert.equal(documentTabScrollLeft(wheel, { ...strip, scrollLeft: 600 }), undefined)
  assert.equal(documentTabScrollLeft(wheel, { scrollLeft: 0, scrollWidth: 100, clientWidth: 400 }), undefined)
})

test('only unhandled Ctrl+Tab and Ctrl+Shift+Tab cycle documents', () => {
  assert.equal(documentTabDirection(tabKey), 1)
  assert.equal(documentTabDirection({ ...tabKey, shiftKey: true }), -1)
  for (const patch of [
    { ctrlKey: false }, { ctrlKey: false, shiftKey: true }, { altKey: true },
    { metaKey: true }, { isComposing: true }, { keyCode: 229 },
    { defaultPrevented: true }, { key: 'ArrowRight' }, { key: 'Process' },
  ]) assert.equal(documentTabDirection({ ...tabKey, ...patch }), undefined)
})

test('shortcut cycles sequential document order, wraps both ways and leaves tab state intact', () => {
  const state: FileTabs = { files: [file('a.md'), file('b.md')], selected: '' }
  assert.equal(cycleDocumentTab(state, 1, available), 'a.md')
  assert.equal(cycleDocumentTab({ ...state, selected: 'a.md' }, 1, available), 'b.md')
  assert.equal(cycleDocumentTab({ ...state, selected: 'b.md' }, 1, available), '')
  assert.equal(cycleDocumentTab(state, -1, available), 'b.md')
  assert.equal(cycleDocumentTab({ ...state, selected: 'b.md' }, -1, available), 'a.md')
  assert.equal(cycleDocumentTab({ ...state, selected: 'a.md' }, -1, available), '')
  assert.deepEqual(state, { files: [file('a.md'), file('b.md')], selected: '' })
})

test('shortcuts ignore inactive, hidden, embedded, overlay and IME contexts and one-tab workbenches', () => {
  const state: FileTabs = { files: [file('a.md')], selected: '' }
  for (const patch of [
    { active: false }, { keyboardActive: false }, { visible: false },
    { explorerEnabled: false }, { overlayOpen: true }, { composing: true },
  ]) {
    assert.equal(cycleDocumentTab(state, 1, { ...available, ...patch }), undefined)
    assert.equal(cycleDocumentTab(state, -1, { ...available, ...patch }), undefined)
  }
  for (const direction of [-1, 1] as const) {
    assert.equal(cycleDocumentTab({ files: [], selected: '' }, direction, available), undefined)
    assert.equal(cycleDocumentTab(state, direction, available), 'a.md')
    assert.equal(cycleDocumentTab({ ...state, selected: 'a.md' }, direction, available), '')
  }
})
