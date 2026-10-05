import assert from 'node:assert/strict'
import test from 'node:test'
import { attachmentFile, attachmentKind, attachmentName, messageAttachments } from './message-attachments.ts'

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

test('attachment tabs resolve local absolute and relative raw paths without treating them as URLs', () => {
  const workdir = { kind: 'local', displayPath: 'C:\\workspace\\owner' } as const
  for (const path of [
    'C:\\workspace\\owner\\review notes\\自我介绍.md',
    'c:/WORKSPACE/owner/review notes/自我介绍.md',
    'review notes\\自我介绍.md',
    './review notes/../review notes/自我介绍.md',
  ]) {
    assert.deepEqual(attachmentFile(path, workdir), {
      path: 'review notes/自我介绍.md',
      entry: { name: '自我介绍.md', type: 'file', ext: '.md', size: 0, mtime: null },
    })
  }
  for (const path of ['100% done.md', 'literal%20space.md', '#notes.md', 'review?final.md']) {
    assert.equal(attachmentFile(path, workdir)?.path, path)
  }
  assert.equal(attachmentFile('/home/work/report.md', { kind: 'local', displayPath: '/home/work/' })?.path, 'report.md')
  assert.equal(attachmentFile('/report.md', { kind: 'local', displayPath: '/' })?.path, 'report.md')
  assert.equal(attachmentFile('\\\\server\\share\\report.md', { kind: 'local', displayPath: '\\\\server\\share' })?.path, 'report.md')
})

test('attachment tabs do not reinterpret external, escaping, unavailable or remote paths as local files', () => {
  const workdir = { kind: 'local', displayPath: 'C:\\workspace\\owner' } as const
  for (const path of ['', '..\\outside.md', 'sub/../../outside.md', 'C:\\workspace\\owner-two\\report.md',
    'C:\\workspace\\owner\\..\\private\\file.md', 'D:\\report.md', 'C:report.md', 'folder/',
    '/outside/report.md', 'https://example.test/file.md', 'file:///report.md', 'data:text/plain,hello', 'bad\0.md']) {
    assert.equal(attachmentFile(path, workdir), undefined, path)
  }
  assert.equal(attachmentFile('/Home/report.md', { kind: 'local', displayPath: '/home' }), undefined)
  for (const root of [undefined, { ...workdir, available: false }, { ...workdir, displayPath: null },
    { ...workdir, kind: 'remote' as const }]) {
    assert.equal(attachmentFile('report.md', root), undefined)
    assert.equal(attachmentFile('C:\\workspace\\owner\\report.md', root), undefined)
  }
})
