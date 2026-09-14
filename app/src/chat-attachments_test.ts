import assert from 'node:assert/strict'
import test from 'node:test'
import {
  appendChatAttachments,
  canSendChatMessage,
  clipboardImageFiles,
  composeImageReferenceMessage,
  isImageAttachment,
  revokeChatAttachmentPreviews,
  updateImageAttachment,
  uploadChatAttachments,
} from './chat-attachments.ts'

test('image detection recognizes supported image files by mime or extension', () => {
  assert.equal(isImageAttachment(new File(['a'], 'photo.png', { type: 'application/octet-stream' })), true)
  assert.equal(isImageAttachment(new File(['a'], 'diagram.bin', { type: 'image/webp' })), true)
  assert.equal(isImageAttachment(new File(['a'], 'notes.txt', { type: 'text/plain' })), false)
})

test('clipboard images use the file list once and ignore text and non-image files', () => {
  const image = new File(['image'], 'clipboard.png', { type: 'image/png' })
  const text = new File(['notes'], 'notes.txt', { type: 'text/plain' })
  assert.deepEqual(clipboardImageFiles(null), [])
  assert.deepEqual(clipboardImageFiles({ files: [text] }), [])
  assert.deepEqual(clipboardImageFiles({
    files: [text, image],
    items: [{ kind: 'file', type: 'image/png', getAsFile: () => { assert.fail('Do not duplicate the file list') } }],
  }), [image])
})

test('clipboard item fallback supports multiple images without treating HTML or text as files', () => {
  const first = new File(['a'], 'image.png', { type: 'image/png' })
  const second = new File(['b'], 'image.webp', { type: 'image/webp' })
  assert.deepEqual(clipboardImageFiles({ items: [
    { kind: 'string', type: 'text/html', getAsFile: () => { assert.fail('Do not read HTML as an image') } },
    { kind: 'file', type: 'image/png', getAsFile: () => first },
    { kind: 'file', type: 'image/webp', getAsFile: () => second },
    { kind: 'file', type: 'text/plain', getAsFile: () => null },
  ] }), [first, second])
  assert.throws(() => clipboardImageFiles({ items: [
    { kind: 'file', type: 'image/png', getAsFile: () => null },
  ] }), /Could not read the clipboard image/)
})

test('attachments are deduplicated, preserve order, and only images get previews', () => {
  const shared = new File(['one'], 'photo.png', { type: 'image/png', lastModified: 1 })
  const text = new File(['two'], 'notes.txt', { type: 'text/plain', lastModified: 2 })
  const urls: string[] = []
  const attachments = appendChatAttachments([], [shared, shared, text], {
    createId: (() => {
      let id = 0
      return () => `attachment-${++id}`
    })(),
    createObjectUrl: file => {
      const url = `blob:${file.name}`
      urls.push(url)
      return url
    },
  })
  assert.deepEqual(attachments.map(attachment => ({
    key: attachment.key,
    name: attachment.file.name,
    kind: attachment.kind,
    previewUrl: attachment.previewUrl,
  })), [
    { key: 'attachment-1', name: 'photo.png', kind: 'image', previewUrl: 'blob:photo.png' },
    { key: 'attachment-2', name: 'notes.txt', kind: 'file', previewUrl: undefined },
  ])
  assert.deepEqual(urls, ['blob:photo.png'])
})

test('image-only drafts remain sendable without text or context references', () => {
  assert.equal(canSendChatMessage('', 0, 1), true)
  assert.equal(canSendChatMessage('   ', 0, 0), false)
  assert.equal(canSendChatMessage('', 1, 0), true)
})

test('preview URLs are revoked when attachments are cleared', () => {
  const revoked: string[] = []
  revokeChatAttachmentPreviews([
    { previewUrl: 'blob:one' },
    { previewUrl: undefined },
    { previewUrl: 'blob:two' },
  ], url => { revoked.push(url) })
  assert.deepEqual(revoked, ['blob:one', 'blob:two'])
})

test('marked images update a single pending attachment, preserve other attachments and clear without uploading', () => {
  const first = new File(['one'], 'image-marked.png', { type: 'image/png' })
  const second = new File(['two'], 'image-marked.png', { type: 'image/png' })
  const revoked: string[] = []
  let sequence = 0
  const options = {
    createObjectUrl: () => `blob:${++sequence}`,
    revokeObjectUrl: (url: string) => { revoked.push(url) },
    createId: () => 'marked',
  }
  const original = appendChatAttachments([], [new File(['notes'], 'notes.txt')], { createId: () => 'notes' })
  const added = updateImageAttachment(original, 'session-a/image', first, options)
  assert.equal(added.length, 2)
  assert.equal(added[1]?.file, first)
  assert.equal(added[1]?.sourceKey, 'session-a/image')
  const updated = updateImageAttachment(added, 'session-a/image', second, options)
  assert.equal(updated.length, 2)
  assert.equal(updated[0], original[0])
  assert.equal(updated[1]?.key, added[1]?.key)
  assert.equal(updated[1]?.file, second)
  assert.deepEqual(revoked, ['blob:1'])
  const droppedAgain = updateImageAttachment(updated, 'session-a/image', second, options)
  assert.equal(droppedAgain[1], updated[1])
  assert.equal(sequence, 2)
  assert.deepEqual(updateImageAttachment(droppedAgain, 'session-a/image', null, options), original)
  assert.deepEqual(revoked, ['blob:1', 'blob:2'])
})

test('failed image replacement leaves the previous attachment and its preview valid', () => {
  const file = new File(['one'], 'image.png', { type: 'image/png' })
  const existing = updateImageAttachment([], 'image', file, { createObjectUrl: () => 'blob:previous' })
  const options = { createObjectUrl: () => { throw new Error('out of memory') },
    revokeObjectUrl: () => assert.fail('Do not revoke the retained preview') }
  assert.throws(() => updateImageAttachment(existing, 'image', new File(['two'], 'new.png'), options), /out of memory/)
  assert.equal(existing[0]?.file, file)
  assert.throws(() => updateImageAttachment(existing, 'image', new File(['text'], 'not-image.txt')), /Only an image/)
})

test('source metadata follows replacement, repeat drag and upload; removal drops the reference text', async () => {
  const source = { path: 'C:\\project\\diagrams\\image.png', modified: true }
  let urls = 0
  const options = { source, createObjectUrl: () => `blob:${++urls}`, revokeObjectUrl: () => {} }
  const first = updateImageAttachment([], 'stable-image', new File(['first'], 'image-marked.png'), options)
  const second = updateImageAttachment(first, 'stable-image', new File(['undo'], 'image-marked.png'), options)
  assert.deepEqual(second[0]?.source, source)
  assert.equal(second[0]?.key, first[0]?.key)
  const repeated = updateImageAttachment(second, 'stable-image', second[0]!.file, options)
  assert.equal(urls, 2)
  assert.deepEqual(repeated[0]?.source, source)
  const uploaded = await uploadChatAttachments('http://main', 'chat', repeated, new AbortController().signal,
    async () => Response.json({ path: 'uploads/123-image-marked.png' }))
  assert.deepEqual(uploaded[0]?.source, source)
  assert.equal(composeImageReferenceMessage('Fix the marked area.', uploaded),
    'Fix the marked area.\n\nImage references (source metadata):\n'
    + '- Attached image: "uploads/123-image-marked.png"\n'
    + `  Original file: ${JSON.stringify(source.path)}\n`
    + '  Version: marked copy; original file unchanged.\n'
    + '  Media item: 1 of 1 (message attachment order).')
  const removed = updateImageAttachment(repeated, 'stable-image', null, options)
  assert.equal(composeImageReferenceMessage('No image', await uploadChatAttachments('http://main', 'chat', removed, new AbortController().signal)), 'No image')
})

test('same-named images remain paired with their exact upload and source paths; plain uploads invent no origin', () => {
  const attachments = [
    { key: 'one', path: 'uploads/first.png', file: new File(['first'], 'image.png'), kind: 'image' as const,
      source: { path: '/project-a/images/image.png', modified: true } },
    { key: 'two', path: 'uploads/second.png', file: new File(['second'], 'image.png'), kind: 'image' as const,
      source: { path: '/project-b/images/image.png', modified: false } },
    { key: 'paste', path: 'uploads/clipboard.png', file: new File(['clipboard'], 'clipboard.png'), kind: 'image' as const },
  ]
  const content = composeImageReferenceMessage('', attachments)
  assert.ok(content.includes('Attached image: "uploads/first.png"\n  Original file: "/project-a/images/image.png"\n  Version: marked copy; original file unchanged.'))
  assert.ok(content.includes('Attached image: "uploads/second.png"\n  Original file: "/project-b/images/image.png"\n  Version: original image (unmarked).'))
  assert.ok(!content.includes('clipboard'))
  const mixed = composeImageReferenceMessage('', [attachments[2]!, attachments[0]!, attachments[1]!])
  assert.ok(mixed.includes('Media item: 2 of 3 (message attachment order).'))
  assert.ok(mixed.includes('Media item: 3 of 3 (message attachment order).'))
  assert.ok(!mixed.includes('Media item: 1 of 3'))
  assert.equal(composeImageReferenceMessage('Pasted image', [attachments[2]!]), 'Pasted image')
  const unusual = { ...attachments[0]!, source: { path: '/project/"quoted"\nname.png', modified: true } }
  assert.ok(composeImageReferenceMessage('', [unusual]).includes(JSON.stringify(unusual.source.path)))
})

test('chat attachments upload as multipart form data and return backend media paths', async () => {
  const files = [
    { key: 'image', file: new File(['image'], 'photo.png', { type: 'image/png' }), kind: 'image' as const, previewUrl: 'blob:photo' },
    { key: 'doc', file: new File(['doc'], 'notes.txt', { type: 'text/plain' }), kind: 'file' as const },
  ]
  const requests: Array<{ url: string; chatId: FormDataEntryValue | null; file: FormDataEntryValue | null }> = []
  const uploaded = await uploadChatAttachments(
    'http://main',
    'chat-upload',
    files,
    new AbortController().signal,
    async (input, init) => {
      assert.equal(init?.method, 'POST')
      assert.ok(init?.body instanceof FormData)
      const form = init.body
      requests.push({
        url: String(input),
        chatId: form.get('chatId'),
        file: form.get('file'),
      })

      const file = form.get('file')
      assert.ok(file instanceof File)
      return Response.json({
        path: `C:\\uploads\\${file.name}`,
      })
    },
  )
  assert.deepEqual(requests.map(request => ({
    url: request.url,
    chatId: request.chatId,
    filename: request.file instanceof File ? request.file.name : null,
  })), [
    { url: 'http://main/api/chat/upload', chatId: 'chat-upload', filename: 'photo.png' },
    { url: 'http://main/api/chat/upload', chatId: 'chat-upload', filename: 'notes.txt' },
  ])
  assert.deepEqual(uploaded.map(item => ({ key: item.key, path: item.path })), [
    { key: 'image', path: 'C:\\uploads\\photo.png' },
    { key: 'doc', path: 'C:\\uploads\\notes.txt' },
  ])
})

test('invalid uploads fail and cancellation propagates to the whole batch', async () => {
  const attachment = { key: 'one', file: new File(['image'], 'image.png'), kind: 'image' as const }
  for (const response of [Response.json({}), Response.json({ path: '' }), new Response('<html>error</html>')]) {
    await assert.rejects(uploadChatAttachments('http://main', 'chat-one', [attachment], new AbortController().signal, async () => response), /invalid attachment/)
  }
  const signals: AbortSignal[] = []
  await assert.rejects(uploadChatAttachments('http://main', 'chat-one', [attachment, { ...attachment, key: 'two' }], new AbortController().signal,
    async (_url, init) => {
      assert.ok(init?.signal)
      signals.push(init.signal)
      return new Response('unavailable', { status: 503 })
    }), /Could not upload/)
  assert.equal(signals.length, 2)
  assert.ok(signals.every(signal => signal.aborted))
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(uploadChatAttachments('http://main', 'chat-one', [attachment], controller.signal, async () => {
    assert.fail('Aborted uploads must not start')
  }), { name: 'AbortError' })
})

test('fork uploads carry parent locality without materializing the conversation', async () => {
  await uploadChatAttachments('http://main', 'chat-child',
    [{ key: 'image', file: new File(['image'], 'photo.png'), kind: 'image' }],
    new AbortController().signal,
    async (_url, init) => {
      assert.ok(init?.body instanceof FormData)
      assert.equal(init.body.get('parentSessionId'), 'web:chat-parent')
      return Response.json({ path: 'C:\\uploads\\photo.png' })
    }, 'web:chat-parent')
})
