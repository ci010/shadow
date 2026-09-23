import assert from 'node:assert/strict'
import test from 'node:test'
import { conversationFileLink } from './conversation-file-link.ts'

test('conversation file links resolve relative Markdown paths without a browser route base', () => {
  for (const href of ['Theme-Brandkit-daily-20260923-76f4a23/REPORT.md', './docs/../docs/report.md#summary', 'docs\\report.md']) {
    const file = conversationFileLink(href)!
    assert.equal(file.entry.type, 'file')
    assert.equal(file.entry.ext, '.md')
    assert.equal(file.path, href.startsWith('Theme-') ? href : 'docs/report.md')
  }
  assert.equal(conversationFileLink('review%20notes/%E6%8A%A5%E5%91%8A.md')?.path, 'review notes/报告.md')
  assert.equal(conversationFileLink('README')?.entry.ext, '')
  assert.equal(conversationFileLink('.gitignore')?.entry.ext, '')
  assert.equal(conversationFileLink('report.html?version=1')?.entry.ext, '.html')
})

test('file preview does not intercept external, application, fragment, absolute or escaping links', () => {
  for (const href of [
    '', '#summary', '?view=chat', 'https://example.test/report.md', 'mailto:a@example.test',
    '//example.test/report.md', '/projects/a/chat/web%3Achat-one', '/tmp/report.md',
    'file:///tmp/report.md', 'C:\\work\\report.md', '\\\\server\\report.md', '../report.md',
    'docs/../../report.md', '%2e%2e/report.md', '%2freport.md', '%5creport.md',
    'javascript:alert(1)', 'data:text/plain,report', 'file%3a/report.md', 'bad%ZZ.md',
    'bad%00.md', 'folder/', './',
  ]) assert.equal(conversationFileLink(href), undefined, href)
})
