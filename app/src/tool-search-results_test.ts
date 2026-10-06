import assert from 'node:assert/strict'
import test from 'node:test'
import { parseToolSearchResult } from './tool-search-results.ts'

test('grep results preserve Windows paths, original code lines, pagination and line numbers', () => {
  const text = '    for (const [file, checksum] of Object.entries(proc.outputs)) {'
  const result = parseToolSearchResult(`Found 13 matches (showing 1-2)
C:\\project\\packages\\profile.ts:
  Line 158: ${text}

C:\\project\\other.py:
  Line 9: \tprint("<script>")

(Showing 2 of 13 results; continue with offset: 2.)`)
  assert.deepEqual(result, {
    heading: 'Found 13 matches (showing 1-2)',
    files: [
      { path: 'C:\\project\\packages\\profile.ts', matches: [{ line: 158, text }] },
      { path: 'C:\\project\\other.py', matches: [{ line: 9, text: '\tprint("<script>")' }] },
    ],
    notices: ['(Showing 2 of 13 results; continue with offset: 2.)'],
  })
})

test('virtual grep keeps warning and continuation metadata visible', () => {
  const parsed = parseToolSearchResult('v:memory/a.md:  Line 2: # Title\r\nv:memory/a.md:  Line 9: text\r\n(Showing 2 of 3 results; continue with offset: 2.)\r\nWarning: v:memory/b: unavailable')
  assert.equal(parsed?.files.length, 1)
  assert.deepEqual(parsed?.files[0].matches.map(match => match.line), [2, 9])
  assert.deepEqual(parsed?.notices, ['(Showing 2 of 3 results; continue with offset: 2.)', 'Warning: v:memory/b: unavailable'])
})

test('a single local match and an empty matched line retain their structure', () => {
  assert.deepEqual(parseToolSearchResult('Found 1 match\nfile.ts:\n  Line 158: '), {
    heading: 'Found 1 match', files: [{ path: 'file.ts', matches: [{ line: 158, text: '' }] }], notices: [],
  })
  assert.deepEqual(parseToolSearchResult('v:memory/a.md:  Line 2: output:  Line 158: code')?.files, [
    { path: 'v:memory/a.md', matches: [{ line: 2, text: 'output:  Line 158: code' }] },
  ])
})

test('unrecognized, malformed and incomplete output stays in the raw renderer without dropping content', () => {
  for (const text of [
    '', 'No matches found', 'Error: permission denied', '{"matches":[]}', 'web search content',
    'Found 1 match\nfile.ts:', 'Found 1 match\n  Line 1: missing path',
    'Found 1 match\nfile.ts:\n  Line 0: invalid',
    'Found 1 match\nfile.ts:\n  Line 9007199254740992: invalid',
    'Found 1 match\nfile.ts:\n  Line 1: text\nunrecognized diagnostic',
    'Found 1 match\nfile.ts:\n  Line 1: text\nempty.ts:',
  ]) assert.equal(parseToolSearchResult(text), undefined, text)
})
