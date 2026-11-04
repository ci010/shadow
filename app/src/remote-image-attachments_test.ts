import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { assertRemoteChatImages, appendChatAttachments, clipboardChatFiles, uploadChatAttachments } from './chat-attachments.ts'

test('first pasted image in a remote draft and existing session uses Main upload, not Child files', async () => {
  const file = new File(['fixture'], 'paste.png', { type: 'image/png' })
  const files = clipboardChatFiles({ items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }] })
  assertRemoteChatImages(files)
  const attachments = appendChatAttachments([], files, { createObjectUrl: () => 'blob:fixture' })
  for (const id of ['prepared-remote-draft', 'existing-remote']) {
    const uploaded = await uploadChatAttachments('http://fixture/projects/p/', id, attachments, new AbortController().signal, async (url, init) => {
      assert.equal(String(url), 'http://fixture/projects/p/api/chat/upload')
      const form = init!.body as FormData
      assert.equal(form.get('chatId'), id)
      assert.equal((form.get('file') as File).name, 'paste.png')
      assert.equal(form.has('workdir'), false)
      return Response.json({ path: `/main/session/${id}/uploads/image.png` })
    })
    assert.equal(uploaded[0].kind, 'image')
  }
  assert.throws(() => assertRemoteChatImages([new File(['text'], 'note.txt')]), /images only/)
  assert.throws(() => assertRemoteChatImages([new File(['svg'], 'image.svg', { type: 'image/svg+xml' })]), /images only/)
  const source = await readFile(new URL('./components/ChatTab.vue', import.meta.url), 'utf8')
  assert.match(source, /const canAttachFiles = computed\(\(\) => .*typeof File/)
  assert.doesNotMatch(source.match(/const canAttachFiles = .*/)?.[0] ?? '', /!remoteConversation/)
  assert.ok(source.indexOf('await draft.value.prepare(controller.signal)') < source.indexOf('const uploadedAttachments = retry'))
  assert.match(source, /attachments.some\(item => item.kind !== 'image'\)/)
})
