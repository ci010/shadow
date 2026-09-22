import assert from 'node:assert/strict'
import test from 'node:test'
import { parseMediaFromContent } from './media-parse.ts'

test('media directives support inline labels, Windows paths, spaces, quotes, and CRLF', () => {
  for (const path of ['C:\\workspace\\runs\\review\\OWNER-INPUTS.md', 'C:\\Review notes\\report.html', '/work/review notes/report.html', 'uploads/report.pdf', 'https://example.test/report.pdf?q=1']) {
    assert.deepEqual(parseMediaFromContent(`Materials: MEDIA:${path}`), { text: 'Materials: ', media: [path] })
    assert.deepEqual(parseMediaFromContent(`  MEDIA: "${path}"  \r\nNext line`), { text: 'Next line', media: [path] })
    assert.deepEqual(parseMediaFromContent(`MEDIA:\`${path}\``), { text: '', media: [path] })
  }
  assert.deepEqual(parseMediaFromContent('MEDIA:uploads/a.png\nMEDIA:uploads/a.png'), { text: '', media: ['uploads/a.png'] })
})

test('media examples inside code and empty or embedded identifiers remain literal', () => {
  for (const content of [
    '`MEDIA:example.png`', '```text\nMEDIA:example.png\n```', '~~~text\nMEDIA:example.png\n~~~',
    '```text\nMEDIA:example.png', 'MEDIA:', 'MEDIA:   ', 'NOTMEDIA:example.png',
  ]) assert.deepEqual(parseMediaFromContent(content), { text: content, media: undefined })
  assert.deepEqual(parseMediaFromContent('`MEDIA:example.png`\nResult: MEDIA:real.png'), {
    text: '`MEDIA:example.png`\nResult: ', media: ['real.png'],
  })
})
