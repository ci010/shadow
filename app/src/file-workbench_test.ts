import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canCloseAllDocuments, canHandleDocumentShortcut, closeAllFileTabs, closeOtherFileTabs, closeFileTab, cycleDocumentTab, documentTabDirection, documentTabScrollLeft, fileTabKey, isCloseAllDocumentsKey, isCloseDocumentKey, isToggleExplorerKey, knowledgeHistoryDirection, nextDocumentTab, openFileTab, selectedFileToClose, type DocumentTabKey, type DocumentTabWheel, type FileTabs } from './file-workbench.ts'
import { documentTabKeys, DIAGNOSIS_TAB_KEY, KNOWLEDGE_TAB_KEY, knowledgeEntryTabKey, openKnowledgeTab, openProjectTab, projectTabFromKey, projectTabKey, withDiagnosisTab } from './file-workbench.ts'

const file = (path: string) => ({ path, entry: { name: path.split('/').at(-1)!, ext: '.md', type: 'file' as const, size: 12, mtime: null } })
test('archive tabs retain their member identity without colliding with workspace paths or nested containers', () => {
  const source = file('bundle.zip/inner.zip/notes.txt')
  const member = { ...source, entry: { ...source.entry, archive: { path: 'bundle.zip', members: ['inner.zip/notes.txt'] } } }
  const nested = { ...source, entry: { ...source.entry, archive: { path: 'bundle.zip', members: ['inner.zip', 'notes.txt'] } } }
  assert.notEqual(fileTabKey(source), fileTabKey(member))
  assert.notEqual(fileTabKey(member), fileTabKey(nested))
  const tabs = openFileTab(openFileTab({ files: [], selected: '' }, member), nested)
  assert.equal(tabs.files.length, 2)
  assert.equal(openFileTab(tabs, member).selected, fileTabKey(member))
})
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
test('file writes do not add a permanent document to the conversation workbench', () => {
  const state = withDiagnosisTab(openFileTab({ files: [], selected: '' }, file('memory.md')), true)
  assert.deepEqual(documentTabKeys(state), ['', DIAGNOSIS_TAB_KEY, 'memory.md'])
  assert.deepEqual(documentTabKeys(closeAllFileTabs(state)), ['', DIAGNOSIS_TAB_KEY])
})
test('Alt+Left and Alt+Right use browser history only for unhandled, nonrepeating keys', () => {
  const back = { ...tabKey, key: 'ArrowLeft', altKey: true, ctrlKey: false }
  assert.equal(knowledgeHistoryDirection(back), -1)
  assert.equal(knowledgeHistoryDirection({ ...back, key: 'ArrowRight' }), 1)
  for (const patch of [{ altKey: false }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true },
    { isComposing: true }, { keyCode: 229 }, { defaultPrevented: true }, { repeat: true }]) {
    assert.equal(knowledgeHistoryDirection({ ...back, ...patch }), undefined)
  }
})

test('Ctrl+Shift+E toggles the explorer only for an exact, unhandled, nonrepeating shortcut', () => {
  const event = { ...tabKey, key: 'E', keyCode: 69, shiftKey: true }
  assert.equal(isToggleExplorerKey(event), true)
  assert.equal(isToggleExplorerKey({ ...event, key: 'e' }), true)
  for (const patch of [{ key: 'w' }, { key: 'Process' }, { ctrlKey: false }, { shiftKey: false },
    { altKey: true }, { metaKey: true }, { isComposing: true }, { keyCode: 229 },
    { defaultPrevented: true }, { repeat: true }]) {
    assert.equal(isToggleExplorerKey({ ...event, ...patch }), false)
  }
})

test('explorer shortcut uses active workbench guards without requiring an open file', () => {
  assert.equal(canHandleDocumentShortcut(available), true)
  for (const patch of [{ active: false }, { keyboardActive: false }, { visible: false },
    { explorerEnabled: false }, { overlayOpen: true }, { composing: true }]) {
    assert.equal(canHandleDocumentShortcut({ ...available, ...patch }), false)
  }
})

test('optional Diagnosis is a permanent peer of Conversation, including keyboard navigation', () => {
  const state = withDiagnosisTab(openKnowledgeTab(openFileTab({ files: [], selected: '' }, file('notes.md'))), true)
  assert.deepEqual(documentTabKeys(state), ['', DIAGNOSIS_TAB_KEY, KNOWLEDGE_TAB_KEY, 'notes.md'])
  assert.equal(cycleDocumentTab({ ...state, selected: '' }, 1, available), DIAGNOSIS_TAB_KEY)
  assert.equal(cycleDocumentTab({ ...state, selected: DIAGNOSIS_TAB_KEY }, 1, available), KNOWLEDGE_TAB_KEY)
  const selected = { ...state, selected: DIAGNOSIS_TAB_KEY }
  assert.equal(selectedFileToClose(selected, available), undefined)
  assert.equal(closeFileTab(selected, DIAGNOSIS_TAB_KEY), selected)
  assert.deepEqual(closeAllFileTabs(selected), { files: [], diagnosis: true, selected: DIAGNOSIS_TAB_KEY })
  assert.equal(closeOtherFileTabs(selected, 'notes.md').diagnosis, true)
  assert.equal(closeOtherFileTabs(selected, KNOWLEDGE_TAB_KEY).diagnosis, true)
  assert.equal(closeAllFileTabs(state).selected, '')
  const pinned = closeAllFileTabs(selected)
  assert.equal(canCloseAllDocuments(pinned, available), false)
  assert.equal(cycleDocumentTab(pinned, 1, available), '')
  assert.equal(cycleDocumentTab({ ...pinned, selected: '' }, -1, available), DIAGNOSIS_TAB_KEY)
  const draft = withDiagnosisTab(pinned, false)
  assert.deepEqual(draft, { files: [], selected: '' })
  assert.deepEqual(documentTabKeys(draft), [''])
  assert.equal(withDiagnosisTab({ ...state, selected: 'notes.md' }, false).selected, 'notes.md')
})

test('Knowledge shares document navigation and closing without impersonating a file or discarding other tabs', () => {
  const initial = openFileTab({ files: [], selected: '' }, file('notes.md'))
  const opened = openKnowledgeTab(initial, 'memory/wiki.md')
  const entryKey = knowledgeEntryTabKey('memory/wiki.md')
  assert.deepEqual(documentTabKeys(opened), ['', KNOWLEDGE_TAB_KEY, entryKey, 'notes.md'])
  assert.equal(opened.selected, entryKey)
  const reopened = openKnowledgeTab(opened)
  assert.equal(reopened.files, initial.files)
  assert.equal(reopened.selected, KNOWLEDGE_TAB_KEY)
  assert.equal(openKnowledgeTab(reopened, 'memory/wiki.md').knowledgeEntries?.length, 1)
  assert.equal(documentTabKeys(reopened).length, 4)
  const source = openFileTab(reopened, file('other.md'))
  assert.deepEqual(source.knowledgeEntries, ['memory/wiki.md'])
  assert.equal(closeFileTab(source, KNOWLEDGE_TAB_KEY).selected, 'other.md')
  assert.equal(closeFileTab(opened, KNOWLEDGE_TAB_KEY).selected, '')
  assert.equal(closeFileTab(opened, KNOWLEDGE_TAB_KEY).knowledge, undefined)
  assert.equal(closeFileTab(opened, entryKey).selected, KNOWLEDGE_TAB_KEY)
  assert.deepEqual(closeFileTab(opened, entryKey).knowledgeEntries, [])
  assert.deepEqual(closeOtherFileTabs(source, KNOWLEDGE_TAB_KEY), {
    files: [], knowledge: {}, knowledgeEntries: [], selected: KNOWLEDGE_TAB_KEY,
  })
  test('Project Settings and Agents are independent, deduplicated documents with normal closing and cycling', () => {
    const initial = openFileTab(openKnowledgeTab({ files: [], selected: '' }), file('notes.md'))
    const settings = openProjectTab(initial, 'settings')
    const agents = openProjectTab(settings, 'agents')
    assert.deepEqual(documentTabKeys(agents), ['', KNOWLEDGE_TAB_KEY, projectTabKey('settings'), projectTabKey('agents'), 'notes.md'])
    assert.equal(openProjectTab(agents, 'settings').projectTabs, agents.projectTabs)
    assert.equal(projectTabFromKey('agents'), undefined)
    assert.equal(projectTabFromKey(projectTabKey('agents')), 'agents')
    assert.equal(cycleDocumentTab(agents, 1, available), 'notes.md')
    assert.equal(closeFileTab(agents, projectTabKey('agents')).selected, '')
    assert.deepEqual(closeFileTab(agents, projectTabKey('agents')).projectTabs, ['settings'])
    assert.equal(closeFileTab(settings, projectTabKey('settings')).selected, '')
    assert.deepEqual(closeOtherFileTabs(agents, projectTabKey('agents')).projectTabs, ['agents'])
    assert.equal(closeOtherFileTabs(agents, projectTabKey('agents')).knowledge, undefined)
    assert.deepEqual(closeAllFileTabs(agents), { files: [], selected: '' })
    assert.equal(canCloseAllDocuments(openProjectTab({ files: [], selected: '' }, 'settings'), available), true)
  })
  assert.deepEqual(closeOtherFileTabs(opened, entryKey).knowledgeEntries, ['memory/wiki.md'])
  assert.equal(closeOtherFileTabs(source, 'notes.md').knowledge, undefined)
  assert.deepEqual(closeAllFileTabs(opened), { files: [], selected: '' })
  const knowledgeOnly = openKnowledgeTab({ files: [], selected: '' })
  assert.equal(selectedFileToClose(knowledgeOnly, available), KNOWLEDGE_TAB_KEY)
  assert.equal(canCloseAllDocuments(knowledgeOnly, available), true)
  assert.equal(cycleDocumentTab(knowledgeOnly, 1, available), '')
  assert.equal(cycleDocumentTab({ ...knowledgeOnly, selected: '' }, -1, available), KNOWLEDGE_TAB_KEY)
  assert.equal(selectedFileToClose(knowledgeOnly, { ...available, active: false }), undefined)
  assert.equal(initial.knowledge, undefined)
})

test('bulk close preserves Conversation and isolates source/diff keys and original state', () => {
  const source = file('a.md')
  const diff = { ...source, view: 'diff' as const }
  const state: FileTabs = { files: [source, diff, file('b.md')], selected: 'b.md' }
  assert.deepEqual(closeAllFileTabs(state), { files: [], selected: '' })
  assert.deepEqual(closeOtherFileTabs(state, fileTabKey(diff)), { files: [diff], selected: fileTabKey(diff) })
  assert.deepEqual(closeOtherFileTabs({ ...state, selected: '' }, source.path), { files: [source], selected: source.path })
  assert.equal(closeOtherFileTabs(state, 'missing'), state)
  assert.equal(closeOtherFileTabs(state, ''), state)
  assert.equal(state.files.length, 3)
  assert.equal(state.selected, 'b.md')
})

test('Ctrl+Shift+W is available from Conversation but ignores inactive panes, overlays and IME', () => {
  assert.equal(isCloseAllDocumentsKey({ ...tabKey, key: 'W', shiftKey: true }), true)
  for (const patch of [{ shiftKey: false }, { ctrlKey: false }, { altKey: true }, { metaKey: true },
    { isComposing: true }, { keyCode: 229 }, { defaultPrevented: true }, { repeat: true }]) {
    assert.equal(isCloseAllDocumentsKey({ ...tabKey, key: 'w', shiftKey: true, ...patch }), false)
  }
  const state: FileTabs = { files: [file('a.md')], selected: '' }
  assert.equal(canCloseAllDocuments(state, available), true)
  assert.equal(canCloseAllDocuments({ files: [], selected: '' }, available), false)
  for (const patch of [{ active: false }, { keyboardActive: false }, { visible: false },
    { explorerEnabled: false }, { overlayOpen: true }, { composing: true }]) {
    assert.equal(canCloseAllDocuments(state, { ...available, ...patch }), false)
  }
})

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
