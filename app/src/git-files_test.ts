import assert from 'node:assert/strict'
import test from 'node:test'
import { changedDirectory, createGitFilesClient, diffLines, gitDecoration, parseGitDiff, parseGitStatus, type GitChange } from './git-files.ts'
import { splitHighlightLines } from './git-diff-selection.ts'

const changes: GitChange[] = [
  { path: 'src/a.ts', status: 'modified' },
  { path: 'src/deleted/deep.ts', status: 'deleted' },
  { path: 'src/added.ts', status: 'untracked' },
  { path: 'src2/outside.ts', status: 'modified' },
  { path: '.gitmodules', status: 'modified' },
  { path: 'new name.ts', originalPath: 'old name.ts', status: 'renamed' },
]
const hunk = { oldStart: 4, oldLines: 2, newStart: 4, newLines: 2, lines: [' context', '-old', '+new', '\\ No newline at end of file'] }

test('changes remain a directory tree and include deleted paths absent from the filesystem', () => {
  assert.deepEqual(changedDirectory(changes).map(entry => [entry.name, entry.type]),
    [['src', 'dir'], ['src2', 'dir'], ['.gitmodules', 'file'], ['new name.ts', 'file']])
  assert.deepEqual(changedDirectory(changes, 'src').map(entry => [entry.name, entry.type]),
    [['deleted', 'dir'], ['a.ts', 'file'], ['added.ts', 'file']])
  assert.deepEqual(changedDirectory(changes, 'src/deleted').map(entry => entry.name), ['deep.ts'])
  assert.equal(changedDirectory(changes, 'src').some(entry => entry.name === 'outside.ts'), false)
})

test('files and ancestors receive deterministic status without mistaking prefix siblings', () => {
  assert.equal(gitDecoration('src/a.ts', false, changes), 'modified')
  assert.equal(gitDecoration('src/added.ts', false, changes), 'untracked')
  assert.equal(gitDecoration('src', true, changes), 'modified')
  assert.equal(gitDecoration('sr', true, changes), undefined)
  assert.equal(gitDecoration('src', true, [...changes, { path: 'src/conflict.ts', status: 'conflicted' }]), 'conflicted')
})

test('Git wire data rejects unsafe paths and malformed diff line counts', () => {
  assert.deepEqual(parseGitStatus({ available: true, entries: changes }).entries, changes)
  assert.deepEqual(parseGitStatus({ available: false, reason: 'not_repository', entries: [] }), { available: false, reason: 'not_repository', entries: [] })
  for (const path of ['../outside', '/absolute', 'a//b', 'a\\b', '\0diff:a']) {
    assert.throws(() => parseGitStatus({ available: true, entries: [{ path, status: 'modified' }] }), /Invalid Git/)
  }
  assert.throws(() => parseGitStatus({ available: false, entries: changes }), /Unavailable Git/)
  const data = { path: 'src/a.ts', status: 'modified', base: 'HEAD', binary: false, truncated: false, hunks: [hunk] }
  assert.deepEqual(parseGitDiff(data, 'src/a.ts').hunks, [hunk])
  assert.equal(parseGitDiff({ ...data, sourcePath: 'C:\\home\\src\\a.ts' }, 'src/a.ts').sourcePath, 'C:\\home\\src\\a.ts')
  assert.throws(() => parseGitDiff({ ...data, sourcePath: 42 }, 'src/a.ts'), /Invalid file diff/)
  assert.throws(() => parseGitDiff(data, 'other.ts'), /Invalid file diff/)
  assert.throws(() => parseGitDiff({ ...data, hunks: [{ ...hunk, newLines: 3 }] }, 'src/a.ts'), /Invalid file diff/)
})

test('unified rows track old and new source lines independently', () => {
  assert.deepEqual(diffLines(hunk), [
    { kind: 'context', text: 'context', oldLine: 4, newLine: 4 },
    { kind: 'removed', text: 'old', oldLine: 5 },
    { kind: 'added', text: 'new', newLine: 5 },
    { kind: 'note', text: '\\ No newline at end of file' },
  ])
  assert.deepEqual(diffLines({ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ['+new'] }), [{ kind: 'added', text: 'new', newLine: 1 }])
})

test('splitting highlighted diff tokens preserves content, colors, empty lines and CR', () => {
  const lines = splitHighlightLines([{ text: '-old\r\n+new\n', light: 'red', dark: 'pink' }, { text: '\n context' }])
  assert.deepEqual(lines.map(line => line.map(token => token.text).join('')), ['-old\r', '+new', '', ' context'])
  assert.equal(lines[1]![0]!.dark, 'pink')
})

test('Git clients use registered IDs, preserve abort signals and report server errors', async t => {
  const signal = new AbortController().signal
  t.mock.method(globalThis, 'fetch', async (input: URL, init?: RequestInit) => {
    assert.equal(init?.signal, signal)
    if (input.pathname.endsWith('/diff')) {
      assert.equal(input.pathname, '/api/sessions/web%3Achat-one/git/diff')
      assert.equal(input.searchParams.get('path'), 'src/a.ts')
      return Response.json({ path: 'src/a.ts', status: 'modified', base: 'HEAD', binary: false, truncated: false, hunks: [hunk] })
    }
    assert.equal(input.pathname, '/api/folders/folder-a/git/status')
    return Response.json({ available: true, entries: changes })
  })
  assert.equal((await createGitFilesClient('http://main', '', 'folder-a').status(signal)).entries.length, changes.length)
  assert.equal((await createGitFilesClient('http://main', 'web:chat-one').diff('src/a.ts', signal)).path, 'src/a.ts')
  t.mock.method(globalThis, 'fetch', async () => Response.json({ message: 'Git command timed out. Retry.' }, { status: 503 }))
  await assert.rejects(createGitFilesClient('http://main', '', 'folder-a').status(signal), /timed out/)
  const diagnostic = 'Git inspection failed. Check repository access and integrity; no changes were made. [Git status; stage=exit; exit=128; cause=unsafe_ownership]'
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'git_failed', message: diagnostic }, { status: 500 }))
  await assert.rejects(createGitFilesClient('http://main', 'web:chat-fixture').status(signal), { message: diagnostic })
})
