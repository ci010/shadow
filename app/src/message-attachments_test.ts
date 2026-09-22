import assert from 'node:assert/strict'
import test from 'node:test'
import { attachmentKind, attachmentName, messageAttachments } from './message-attachments.ts'

test('history file markers and live media produce one attachment list without altering source messages', () => {
  const content = 'Please check this\n[file: uploads/movie.mp4]\n[file: uploads/logs.zip]'
  assert.deepEqual(messageAttachments(content, ['uploads/movie.mp4']), {
    text: 'Please check this', paths: ['uploads/movie.mp4', 'uploads/logs.zip'],
  })
  assert.deepEqual(messageAttachments('[file: C:\\private session\\uploads\\image.png]'), {
    text: '', paths: ['C:\\private session\\uploads\\image.png'],
  })
  assert.deepEqual(messageAttachments('', ['uploads/a.webm']), { text: '', paths: ['uploads/a.webm'] })
})

test('literal attachment examples in code remain text, including unfinished code fences', () => {
  for (const content of [
    '`[file: demo.zip]`',
    '```text\n[file: demo.zip]\n```',
    '~~~text\n[file: demo.zip]\n~~~',
    '```text\n[file: demo.zip]',
  ]) assert.deepEqual(messageAttachments(content), { text: content, paths: [] })
  assert.deepEqual(messageAttachments('`[file: example]`\n[file: uploads/actual.zip]'), {
    text: '`[file: example]`', paths: ['uploads/actual.zip'],
  })
})

test('inline MEDIA markers become deduplicated cards in both persisted and live messages', () => {
  const path = 'C:\\workspace\\runs\\review notes\\OWNER-INPUTS.md'
  assert.deepEqual(messageAttachments(`材料清单：MEDIA:${path}`, [path]), { text: '材料清单：', paths: [path] })
  assert.deepEqual(messageAttachments(`Report: MEDIA:"${path}"\n[file: ${path}]`), { text: 'Report:', paths: [path] })
  assert.deepEqual(messageAttachments('`MEDIA:example.html`\nMEDIA:actual.html'), {
    text: '`MEDIA:example.html`', paths: ['actual.html'],
  })
})

test('attachment labels and kinds support local paths and signed URLs without exposing query data', () => {
  assert.equal(attachmentName('https://example.test/media/Screen%20Recording.MP4?token=private'), 'Screen Recording.MP4')
  assert.equal(attachmentKind('https://example.test/media/Screen%20Recording.MP4?token=private'), 'video')
  assert.equal(attachmentName('C:\\uploads\\archive.zip'), 'archive.zip')
  assert.equal(attachmentKind('uploads/clip.webm'), 'video')
  assert.equal(attachmentKind('uploads/audio.m4a'), 'audio')
  assert.equal(attachmentKind('uploads/archive.zip'), 'file')
  assert.equal(attachmentKind('data:image/png;base64,AA'), 'image')
  assert.equal(attachmentName('data:image/png;base64,AA'), 'Image')
})
