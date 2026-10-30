import assert from 'node:assert/strict'
import { test } from 'node:test'
import { recordedFileChange } from '../../src/tools/file-change.ts'
import { parseFilePatch } from '../../src/sessions/file-change-contract.ts'
import { diffLines } from './git-files.ts'
import { highlightDiffHunks, loadToolFileChanges } from './tool-file-diff.ts'

const signal = new AbortController().signal
const change = recordedFileChange({
  sessionId: 'web:writer', toolCallId: 'edit:/ one', path: 'file.ts', mode: 'edit', before: 'const old = 1;\n', after: 'const value = 2;\n',
})

test('tool previews request only their own invocation through the project-scoped historical API', async () => {
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    assert.equal(url.pathname, '/projects/p/api/sessions/web%3Awriter/file-changes')
    assert.equal(url.searchParams.get('toolCallId'), 'edit:/ one')
    assert.equal(url.searchParams.get('offset'), '0')
    assert.equal(url.searchParams.get('limit'), '30')
    assert.equal(init?.signal, signal)
    assert.equal(init?.cache, 'no-store')
    return Response.json({ changes: [change], total: 1, offset: 0 })
  }
  assert.deepEqual(await loadToolFileChanges('http://fixture/projects/p', 'web:writer', change.toolCallId, signal, request), [{ ...change, hunks: parseFilePatch(change.patch) }])
})

test('preview lookup paginates only matching records and accepts an explicit missing record', async () => {
  const rows = Array.from({ length: 31 }, (_, index) => ({ ...change, id: `change-${index}` }))
  const offsets: number[] = []
  const request: typeof fetch = async input => {
    const offset = Number(new URL(String(input)).searchParams.get('offset'))
    offsets.push(offset)
    return Response.json({ changes: rows.slice(offset, offset + 30), total: rows.length, offset })
  }
  assert.deepEqual(await loadToolFileChanges('http://fixture', 'web:writer', change.toolCallId, signal, request), rows.map(row => ({ ...row, hunks: parseFilePatch(row.patch) })))
  assert.deepEqual(offsets, [0, 30])
  assert.deepEqual(await loadToolFileChanges('http://fixture', 'web:writer', change.toolCallId, signal,
    async () => Response.json({ changes: [], total: 0, offset: 0 })), [])
})

test('access errors, mismatched identities, invalid pages and stale totals never become a successful preview', async () => {
  for (const [value, status, message] of [
    [{}, 403, /denied/], [{}, 404, /no longer available/], [{}, 503, /503/],
    [{ changes: [{ ...change, sessionId: 'other' }], total: 1, offset: 0 }, 200, /Invalid/],
    [{ changes: [{ ...change, toolCallId: 'other' }], total: 1, offset: 0 }, 200, /Invalid/],
    [{ changes: [change], total: 1, offset: 1 }, 200, /Invalid/],
    [{ changes: [], total: 1, offset: 0 }, 200, /Invalid/],
    [{ changes: [change, change], total: 2, offset: 0 }, 200, /Invalid/],
    [{ changes: [{ ...change, patch: '@@ -1,9 +1,1 @@\n+bad\n' }], total: 1, offset: 0 }, 200, /Invalid/],
  ] as const) {
    await assert.rejects(loadToolFileChanges('http://fixture', 'web:writer', change.toolCallId, signal,
      async () => Response.json(value, { status })), message)
  }
  const rows = Array.from({ length: 30 }, (_, index) => ({ ...change, id: String(index) }))
  await assert.rejects(loadToolFileChanges('http://fixture', 'web:writer', change.toolCallId, signal,
    async input => Number(new URL(String(input)).searchParams.get('offset')) === 0
      ? Response.json({ changes: rows, total: 31, offset: 0 })
      : Response.json({ changes: [], total: 30, offset: 30 })), /Invalid/)
})

test('an aborted preview never applies a late successful response', async () => {
  const controller = new AbortController()
  await assert.rejects(loadToolFileChanges('http://fixture', 'web:writer', change.toolCallId, controller.signal, async () => {
    controller.abort()
    return Response.json({ changes: [change], total: 1, offset: 0 })
  }), /abort/i)
})

test('diff highlighting preserves exact code, uses the file grammar and keeps each side independent', async () => {
  const edit = recordedFileChange({
    sessionId: 'web:writer', toolCallId: 'highlight', path: 'src\\file.ts', mode: 'edit',
    before: 'const value = 1;\n/*\n',
    after: 'const value = 1;\nconst next: number = 42;\n',
  })
  const hunks = parseFilePatch(edit.patch)
  const tokens = await highlightDiffHunks(hunks, edit.path)
  for (const [index, hunk] of hunks.entries()) {
    const rows = diffLines(hunk)
    assert.deepEqual(tokens[index].map(line => line.map(token => token.text).join('')), rows.map(row => row.text))
    const added = tokens[index][rows.findIndex(row => row.kind === 'added')]!
    assert.ok(new Set(added.map(token => token.light)).size > 1, 'Deleted open comment must not turn added code into a comment')
    assert.ok(added.every(token => token.light && token.dark))
  }
  const plain = await highlightDiffHunks(parseFilePatch(change.patch), 'unknown.xyz')
  assert.deepEqual(plain[0].map(line => line.map(token => token.text).join('')), diffLines(parseFilePatch(change.patch)[0]).map(row => row.text))
  assert.ok(plain[0].flat().every(token => token.light === undefined))
})

test('Markdown tool diffs highlight frontmatter and incomplete fenced code without changing rows', async () => {
  const edit = recordedFileChange({
    sessionId: 'web:writer', toolCallId: 'markdown-highlight', path: 'notes.md', mode: 'edit',
    before: '---\r\ntitle: Before\r\n---\r\n```js\r\nconst value = 1\r\n```\r\n',
    after: '---\r\ntitle: After\r\n---\r\n```js\r\nconst value = "unfinished',
  })
  const hunks = parseFilePatch(edit.patch)
  const tokens = await highlightDiffHunks(hunks, edit.path)
  for (const [index, hunk] of hunks.entries()) {
    assert.deepEqual(tokens[index]!.map(line => line.map(token => token.text).join('')), diffLines(hunk).map(row => row.text))
  }
  const flat = tokens.flat(2)
  assert.ok(flat.some(token => token.text === 'title' && token.light === '#22863A'))
  assert.ok(flat.some(token => token.text === 'const' && token.light === '#D73A49'))
})


test('historical file-change provenance retains its original V1 or resource target without inferring a current device', async () => {
  for (const target of [undefined, { nodeId: 'old-child', capabilityId: 'old-folder' },
    { nodeId: 'resource-child', workdirId: 'folder-resource', folderId: 'project-folder' }]) {
    const row = { ...change, ...(target ? { target } : {}) }
    const [result] = await loadToolFileChanges('http://fixture/projects/p', 'web:writer', change.toolCallId, signal,
      async () => Response.json({ changes: [row], total: 1, offset: 0 }))
    assert.deepEqual(result.target, target)
    if (!target) assert.equal(Object.hasOwn(result, 'target'), false)
  }
})
