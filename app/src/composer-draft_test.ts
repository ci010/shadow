import assert from 'node:assert/strict'
import test from 'node:test'
import { effectScope, ref } from 'vue'
import { composerDraftKey, composerDraftEditedAt, useComposerDraft } from './composables/useComposerDraft.ts'

function memoryStorage() {
  const values = new Map<string, string>()
  return { values, getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) } }
}

test('composer text survives reload and switches without erasing another session or project draft', () => {
  const storage = memoryStorage()
  const a = composerDraftKey('http://fixture', 'a', 'session')
  const b = composerDraftKey('http://fixture', 'b', 'session')
  const child = composerDraftKey('http://fixture', 'a', 'child')
  const key = ref(a)
  const scope = effectScope()
  const draft = scope.run(() => useComposerDraft(key, () => storage))!
  draft.text.value = 'Line one\nUnsent text'
  key.value = b
  assert.equal(draft.text.value, '')
  draft.text.value = 'Project B'
  key.value = child
  draft.text.value = 'Child message'
  key.value = a
  assert.equal(draft.text.value, 'Line one\nUnsent text')
  scope.stop()
  const reload = effectScope()
  const restored = reload.run(() => useComposerDraft(ref(a), () => storage))!
  assert.equal(restored.text.value, 'Line one\nUnsent text')
  assert.equal(storage.getItem(b), 'Project B')
  assert.equal(storage.getItem(child), 'Child message')
  restored.text.value = ''
  assert.equal(storage.getItem(a), null)
  reload.stop()
})

test('first send transfers its draft before assigning the session identity and clears only admitted text', () => {
  const storage = memoryStorage()
  const initial = composerDraftKey('http://fixture', 'a', '')
  const prepared = composerDraftKey('http://fixture', 'a', 'web:chat-prepared')
  const key = ref(initial)
  const scope = effectScope()
  const draft = scope.run(() => useComposerDraft(key, () => storage))!
  draft.text.value = 'First request'
  draft.migrate(prepared)
  key.value = prepared
  assert.equal(draft.text.value, 'First request')
  assert.equal(storage.getItem(initial), null)
  assert.equal(storage.getItem(prepared), 'First request', 'A rejected send remains recoverable after reload')
  draft.text.value = 'Next request typed while waiting'
  draft.clearSent(prepared, 'First request')
  assert.equal(draft.text.value, 'Next request typed while waiting')
  assert.equal(storage.getItem(prepared), draft.text.value)
  draft.clearSent(prepared, draft.text.value)
  assert.equal(draft.text.value, '')
  assert.equal(storage.getItem(prepared), null)
  scope.stop()
})

test('late admission clears its own saved draft without touching the newly selected conversation', () => {
  const storage = memoryStorage()
  const key = ref('a')
  const scope = effectScope()
  const draft = scope.run(() => useComposerDraft(key, () => storage))!
  draft.text.value = 'Sent A'
  key.value = 'b'
  draft.text.value = 'Unsent B'
  draft.clearSent('a', 'Sent A')
  assert.equal(storage.getItem('a'), null)
  assert.equal(draft.text.value, 'Unsent B')
  draft.remove('a')
  assert.equal(storage.getItem('b'), 'Unsent B')
  scope.stop()
})

test('storage denial and quota failures are visible and do not prevent typing', () => {
  const scope = effectScope()
  const draft = scope.run(() => useComposerDraft(ref('a'), () => { throw new Error('Storage denied') }))!
  assert.match(draft.error.value, /Storage denied/)
  draft.text.value = 'Keep this text'
  assert.equal(draft.text.value, 'Keep this text')
  assert.match(draft.error.value, /Copy your text/)
  draft.migrate('b')
  assert.equal(draft.text.value, 'Keep this text')
  draft.clearSent('b', 'Keep this text')
  assert.match(draft.error.value, /Storage denied/)
  scope.stop()
})


test('submission clears immediately and failure restores without replacing newer input', () => {
  const storage = memoryStorage()
  const key = ref('draft')
  const scope = effectScope()
  const draft = scope.run(() => useComposerDraft(key, () => storage))!
  draft.text.value = 'Send now'
  draft.clearSubmitting()
  assert.equal(draft.text.value, '', 'No network admission is needed to clear the composer')
  draft.migrate('prepared')
  key.value = 'prepared'
  draft.restoreUnsent('prepared', 'Send now')
  assert.equal(draft.text.value, 'Send now')
  assert.equal(storage.getItem('prepared'), 'Send now')
  draft.clearSubmitting()
  draft.text.value = 'Next message'
  draft.restoreUnsent('prepared', 'Send now')
  assert.equal(draft.text.value, 'Next message')
  key.value = 'other'
  draft.restoreUnsent('prepared', 'Send now')
  assert.equal(draft.text.value, '')
  scope.stop()
})


test('only actual nonblank edits set activity; switching, reload, migration and failed-send restoration preserve it', () => {
  const storage = memoryStorage()
  const a = composerDraftKey('/api', 'project', 'old')
  const b = composerDraftKey('/api', 'project', 'other')
  const key = ref(a)
  const scope = effectScope()
  const draft = scope.run(() => useComposerDraft(key, () => storage))!
  const originalNow = Date.now
  let now = 1000
  Date.now = () => now
  try {
    draft.text.value = 'draft'
    assert.equal(composerDraftEditedAt(storage, a), 1000)
    now = 2000
    key.value = b
    key.value = a
    draft.text.value = 'draft'
    assert.equal(composerDraftEditedAt(storage, a), 1000)
    const reload = effectScope()
    reload.run(() => useComposerDraft(ref(a), () => storage))
    reload.stop()
    assert.equal(composerDraftEditedAt(storage, a), 1000)
    assert.equal(composerDraftEditedAt(storage, composerDraftKey('/other', 'project', 'old')), 0)
    assert.equal(composerDraftEditedAt(storage, composerDraftKey('/api', 'other', 'old')), 0)
    draft.migrate(b)
    key.value = b
    assert.equal(composerDraftEditedAt(storage, a), 0)
    assert.equal(composerDraftEditedAt(storage, b), 1000)
    draft.clearSubmitting()
    assert.equal(composerDraftEditedAt(storage, b), 0)
    draft.restoreUnsent(b, 'draft')
    assert.equal(composerDraftEditedAt(storage, b), 1000)
    draft.text.value = 'edited'
    assert.equal(composerDraftEditedAt(storage, b), 2000)
    draft.clearSent(b, 'draft')
    assert.equal(composerDraftEditedAt(storage, b), 2000)
    draft.clearSent(b, 'edited')
    assert.equal(composerDraftEditedAt(storage, b), 0)
    draft.text.value = '  \n\t'
    assert.equal(composerDraftEditedAt(storage, b), 0)
    draft.text.value = 'new'
    draft.remove(b)
    assert.equal(composerDraftEditedAt(storage, b), 0)
    storage.setItem(a, 'legacy plain text')
    key.value = a
    assert.equal(draft.text.value, 'legacy plain text')
    assert.equal(composerDraftEditedAt(storage, a), 0, 'Legacy drafts do not gain activity on opening')
  } finally { Date.now = originalNow; scope.stop() }
})
