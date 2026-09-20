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
