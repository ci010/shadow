import assert from 'node:assert/strict'
import test from 'node:test'
import { addChatContext, chatContextName, composeChatMessage, createChatDraft } from './chat-draft.ts'

const folder = { id: 'folder-a', name: 'demo', path: 'C:\\fixtures\\demo', createdAt: '2026-09-10T00:00:00Z' }

test('opening or replacing scratch and folder drafts does not allocate sessions', () => {
  let calls = 0
  const client = { createSession: async () => { calls++; return { sessionId: 'web:chat-folder', chatId: 'chat-folder' } } }
  const id = () => { calls++; return 'chat-scratch' }
  for (let i = 0; i < 4; i++) {
    createChatDraft(client, undefined, id)
    const draft = createChatDraft(client, folder, id)
    assert.equal(draft.folder, folder)
  }
  assert.equal(calls, 0)
})

test('first scratch send allocates one identity, reused for duplicate sends and retries', async () => {
  let calls = 0
  const draft = createChatDraft({ createSession: async () => { throw new Error('Unexpected folder request') } }, undefined, () => {
    calls++
    return 'chat-scratch'
  })
  assert.deepEqual(await Promise.all([draft.prepare(), draft.prepare()]), ['web:chat-scratch', 'web:chat-scratch'])
  assert.equal(await draft.prepare(), 'web:chat-scratch')
  assert.equal(calls, 1)
})

test('folder creation is deferred to send, deduplicated and retains its registered folder', async () => {
  let calls = 0
  let finish!: (value: { sessionId: string; chatId: string }) => void
  const draft = createChatDraft({
    createSession: async id => {
      assert.equal(id, folder.id)
      calls++
      return new Promise(resolve => { finish = resolve })
    },
  }, folder)
  const first = draft.prepare()
  const second = draft.prepare()
  finish({ sessionId: 'web:chat-folder', chatId: 'chat-folder' })
  assert.deepEqual(await Promise.all([first, second, draft.prepare()]), Array(3).fill('web:chat-folder'))
  assert.equal(calls, 1)
})

test('folder preparation failures surface and allow retry without losing the draft', async () => {
  let calls = 0
  const draft = createChatDraft({
    createSession: async () => {
      if (++calls === 1) throw new Error('Main unavailable')
      return { sessionId: 'web:chat-folder', chatId: 'chat-folder' }
    },
  }, folder)
  await assert.rejects(draft.prepare(), /Main unavailable/)
  assert.equal(draft.folder, folder)
  assert.equal(await draft.prepare(), 'web:chat-folder')
})

test('file and folder context is deduplicated, named across platforms and serialized into the sent message', () => {
  const paths = ['C:\\fixtures\\hello world.ts', '/fixtures/notes.md']
  const files = addChatContext([], 'file', paths)
  assert.deepEqual(addChatContext(files, 'file', paths), files)
  const items = addChatContext(files, 'folder', ['C:\\fixtures\\source'])
  assert.equal(chatContextName(paths[0]), 'hello world.ts')
  assert.equal(chatContextName('/fixtures/source/'), 'source')
  assert.equal(chatContextName('C:\\'), 'C:')
  assert.equal(composeChatMessage('Plain message', []), 'Plain message')
  const content = composeChatMessage('Review this', items)
  assert.ok(content.startsWith('Review this\n\n'))
  for (const item of items) assert.ok(content.includes(JSON.stringify(item.path)))
  assert.ok(composeChatMessage('', files).includes('File:'))
  assert.equal(composeChatMessage('Review this', items.filter(item => item.kind !== 'folder')).includes('Folder:'), false)
})
