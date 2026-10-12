import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createNewConversationShortcut, resolveConversationFolder, type NewConversationContext } from './new-conversation-shortcut.ts'
import type { FolderRecord } from './folders-client.ts'

const folder: FolderRecord = { id: 'folder', projectId: 'project', name: 'Folder', path: '/folder', createdAt: '' }
function key(overrides = {}) {
  return { key: 'n', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, repeat: false,
    defaultPrevented: false, isComposing: false, consumed: false,
    preventDefault() { this.consumed = true }, ...overrides }
}
test('folder metadata retains registered folder; scratch avoids folder list; missing metadata fails closed', async () => {
  const list = async () => [folder]
  assert.equal(await resolveConversationFolder('chat', [{ sessionId: 'chat', folderId: 'folder' }], list), folder)
  assert.equal(await resolveConversationFolder('chat', [{ sessionId: 'chat' }], async () => { throw Error('not needed') }), undefined)
  await assert.rejects(resolveConversationFolder('missing', [], list), /unavailable/)
  await assert.rejects(resolveConversationFolder('chat', [{ sessionId: 'chat', folderId: 'missing' }], list), /folder is unavailable/)
  await assert.rejects(resolveConversationFolder('chat', [{ sessionId: 'chat', folderId: 'folder' }], async () => { throw Error('network') }), /network/)
})
test('Ctrl/Cmd+N consumes default and starts project draft with resolved folder', async () => {
  const started: unknown[] = []
  const shortcut = createNewConversationShortcut({ context: () => ({ projectId: 'project', sessionId: 'chat' }),
    resolveFolder: async () => folder, start: (context, resolved) => started.push([context.projectId, resolved]), failed: assert.fail })
  for (const event of [key(), key({ ctrlKey: false, metaKey: true, key: 'N' })]) {
    await shortcut.keydown(event)
    assert.equal(event.consumed, true)
  }
  assert.deepEqual(started, [['project', folder], ['project', folder]])
})
test('draft keeps folder, scratch stays in project, inactive or denied contexts and guarded keys do nothing', async () => {
  let context: NewConversationContext | undefined = { projectId: 'project', sessionId: '', folder }
  const started: unknown[] = []
  const shortcut = createNewConversationShortcut({ context: () => context, resolveFolder: async () => { throw Error('not needed') },
    start: (current, resolved) => started.push([current.projectId, resolved]), failed: assert.fail })
  for (const override of [{ repeat: true }, { altKey: true }, { shiftKey: true }, { defaultPrevented: true },
    { ctrlKey: false }, { ctrlKey: true, metaKey: true }, { isComposing: true }, { key: 'w' }]) {
    const event = key(override); await shortcut.keydown(event); assert.equal(event.consumed, false)
  }
  await shortcut.keydown(key())
  context = { projectId: 'project', sessionId: '' }
  await shortcut.keydown(key())
  context = undefined
  const event = key(); await shortcut.keydown(event); assert.equal(event.consumed, false)
  assert.deepEqual(started, [['project', folder], ['project', undefined]])
})
test('pending resolution consumes immediately, deduplicates presses, cancels on selection/lifecycle change', async () => {
  let finish!: (folder: FolderRecord) => void
  let reads = 0; let starts = 0; let failures = 0
  const shortcut = createNewConversationShortcut({ context: () => ({ projectId: 'project', sessionId: 'chat' }),
    resolveFolder: () => { reads++; return new Promise(resolve => { finish = resolve }) },
    start: () => { starts++ }, failed: () => { failures++ } })
  const event = key(); const pending = shortcut.keydown(event)
  assert.equal(event.consumed, true)
  const duplicate = key(); await shortcut.keydown(duplicate)
  assert.equal(duplicate.consumed, true); assert.equal(reads, 1)
  shortcut.cancel(); finish(folder); await pending
  assert.equal(starts, 0); assert.equal(failures, 0)
})
test('resolution failures report error without opening scratch', async () => {
  const failures: unknown[] = []
  const shortcut = createNewConversationShortcut({ context: () => ({ projectId: 'project', sessionId: 'chat' }),
    resolveFolder: async () => { throw Error('folder lookup failed') }, start: assert.fail, failed: cause => failures.push(cause) })
  await shortcut.keydown(key())
  assert.equal((failures[0] as Error).message, 'folder lookup failed')
})
