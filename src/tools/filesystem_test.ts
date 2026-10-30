import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { test, type TestContext } from 'node:test'
import { promisify } from 'node:util'
import type { ExecutionContext } from './context.ts'
import { applyReplacement, applyReplacementDetailed, WriteTool } from './filesystem.ts'
import { SessionTools, Tools } from './registry.ts'
import { formatWriteResult, MAX_WRITE_RESULT_CHARS } from './write-result.ts'
import { CapabilityFilesystem } from '../execution/capability-filesystem.ts'
import type { Executor } from '../execution/executor.ts'
import { MAX_LINE_DIFF_CHARS } from './line-changes.ts'
import type { RecordedFileChange } from '../sessions/file-change-contract.ts'

async function fixture(t: TestContext) {
  const scratch = resolve('.tmp')
  await mkdir(scratch, { recursive: true })
  const root = await mkdtemp(join(scratch, 'write-result-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const context: ExecutionContext = {
    channel: 'test', chatId: 'chat', senderId: 'user', messageId: 'turn',
    sessionId: 'test:write', physicalSessionId: 'test-write-0', cwd: root,
    signal: new AbortController().signal, tools: new SessionTools(new Tools(root), root),
    toolCallId: 'write', recordFileChange: async () => {},
  }
  return { root, context, tool: new WriteTool(root) }
}

test('full writes return compact receipts without echoing file content', async t => {
  const { root, context, tool } = await fixture(t)
  const content = Array.from({ length: 50 }, (_, i) => `row ${i + 1}`).join('\n') + '\n'
  const result = await tool.execute({ path: 'nested/file.txt', content }, context)
  assert.equal(await readFile(join(root, 'nested', 'file.txt'), 'utf8'), content)
  assert.match(result, /^OK write \+50 -0 edit=\S+$/)
  assert.doesNotMatch(result, /row|L1:|@@/)
  assert.ok(result.length < 100)
  const unicode = '\u4f60\u597d\n'
  assert.match(await tool.execute({ path: 'unicode.txt', content: unicode }, context), /^OK write \+1 -0/)
  assert.equal(await readFile(join(root, 'unicode.txt'), 'utf8'), unicode)
})

test('non-admin writes and edits use the same workspace policy for source files', async t => {
  const { root, context } = await fixture(t)
  const tool = new WriteTool(root, true)
  const path = join('src', 'example.ts')
  assert.match(await tool.execute({ path, content: 'export const value = 1\n' }, { ...context, admin: false }), /^OK write/)
  assert.match(await tool.execute({ path, match: 'value = 1', content: 'value = 2' }, { ...context, admin: false }), /^OK edit/)
  assert.match(await tool.execute({ path, content: 'export const other = 3\n', flag: 'a' }, { ...context, admin: false }), /^OK append/)
  assert.equal(await readFile(join(root, path), 'utf8'), 'export const value = 2\nexport const other = 3\n')
  assert.match(await tool.execute({ path: join('..', 'outside.ts'), content: 'bad' }, { ...context, admin: false }), /restricted to workspace/)
})

test('explicit UTF-8 BOM writes preserve exact bytes across edits without changing default encoding', async t => {
  const { root, context, tool } = await fixture(t)
  const text = 'Write-Output "\u4e2d\u6587\u65e5\u672c\u8a9e"\n'
  await tool.execute({ path: 'helper.ps1', content: text, encoding: 'utf8-bom' }, context)
  assert.equal(await readFile(join(root, 'helper.ps1'), 'utf8'), '\uFEFF' + text)
  await tool.execute({ path: 'helper.ps1', content: '\uFEFF' + text, encoding: 'utf8-bom' }, context)
  await tool.execute({ path: 'helper.ps1', match: 'Write-Output', content: 'Write-Host' }, context)
  assert.equal(await readFile(join(root, 'helper.ps1'), 'utf8'), '\uFEFF' + text.replace('Write-Output', 'Write-Host'))
  await tool.execute({ path: 'plain.ps1', content: text }, context)
  assert.equal(await readFile(join(root, 'plain.ps1'), 'utf8'), text)
  for (const args of [{ encoding: 'utf16' }, { encoding: 'utf8-bom', flag: 'a' }, { encoding: 'utf8-bom', match: 'Write-Host' }]) {
    await assert.rejects(tool.execute({ path: 'helper.ps1', content: 'bad', ...args }, context), /encoding/)
  }
})

test('Windows PowerShell helper round-trips non-ASCII JSON using the explicit BOM write mode', { skip: process.platform !== 'win32' }, async t => {
  const { root, context, tool } = await fixture(t)
  await tool.execute({ path: 'roundtrip.ps1', encoding: 'utf8-bom', content:
    `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)\n@{text='\u4e2d\u6587\u3068\u65e5\u672c\u8a9e'} | ConvertTo-Json -Compress` }, context)
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', join(root, 'roundtrip.ps1')],
    { encoding: 'utf8', windowsHide: true, timeout: 10000 })
  assert.deepEqual(JSON.parse(stdout), { text: '\u4e2d\u6587\u3068\u65e5\u672c\u8a9e' })
})
test('exact edits report counts and match strategy without echoing source', async t => {
  const { root, context, tool } = await fixture(t)
  await writeFile(join(root, 'edit.txt'), 'one\ntwo\nold\nfour\nfive\n')
  const result = await tool.execute({ path: 'edit.txt', match: 'old', content: 'new\nsecond' }, context)
  assert.equal(await readFile(join(root, 'edit.txt'), 'utf8'), 'one\ntwo\nnew\nsecond\nfour\nfive\n')
  assert.match(result, /Replacements: 1; match: exact/)
  assert.doesNotMatch(result, /one|two|second|four|L\d:/)
  assert.match(result, /^OK edit \+2 -1 edit=/)
})

test('global replacements use literal replacement text and final offsets', () => {
  const edit = applyReplacementDetailed('a\nx\na\nx\na\n', 'a', '$&\nnew', true)
  assert.ok(edit)
  assert.equal(edit.content, '$&\nnew\nx\n$&\nnew\nx\n$&\nnew\n')
  assert.equal(edit.count, 3)
  for (const range of edit.ranges) assert.equal(edit.content.slice(range.start, range.end), '$&\nnew')
  assert.equal(applyReplacement('a a', 'a', "$`-$'-$&-$$", true), "$`-$'-$&-$$ $`-$'-$&-$$")
  assert.equal(applyReplacement('ab', '', '-', true), null)
  assert.equal(applyReplacement('a a', 'a', 'b'), null)
  assert.equal(applyReplacement('aaa', 'aa', 'b'), null)
  assert.equal(applyReplacement('  a', 'a ', 'b'), null)
})

test('edits reject fuzzy and ambiguous matches without modifying the file', async t => {
  const { root, context, tool } = await fixture(t)
  const original = 'before\r\n  old  \r\n  old  \r\nafter\r\n'
  await writeFile(join(root, 'exact.txt'), original)
  for (const match of ['old\n', '\told', 'old', '']) {
    const result = await tool.execute({ path: 'exact.txt', match, content: 'new' }, context)
    assert.match(result, /^Error:/)
    assert.equal(await readFile(join(root, 'exact.txt'), 'utf8'), original)
  }
  const result = await tool.execute({ path: 'exact.txt', match: 'old', content: 'new', flag: 'g' }, context)
  assert.match(result, /Replacements: 2; match: exact/)
  assert.doesNotMatch(result, /normalized/)
  assert.equal(await readFile(join(root, 'exact.txt'), 'utf8'), original.replaceAll('old', 'new'))
})

test('logical newline matching preserves BOM, mixed untouched endings and final newline state', () => {
  const original = '\uFEFFheader\r\nold\r\nblock\r\ntail\nlast'
  const result = applyReplacementDetailed(original, 'old\nblock', 'new\nlines\nextra')!
  assert.equal(result.content, '\uFEFFheader\r\nnew\r\nlines\r\nextra\r\ntail\nlast')
  assert.equal(result.count, 1)
  assert.equal(result.content.slice(result.ranges[0].start, result.ranges[0].end), 'new\r\nlines\r\nextra')
  assert.equal(applyReplacement('a\nb\n', 'b', 'c\nd'), 'a\nc\nd\n')
  assert.equal(applyReplacement('a\r\nb', 'b', 'c\nd'), 'a\r\nc\r\nd')
  assert.equal(applyReplacement('old\r\nx\nold\n', 'old', 'a\nb', true), 'a\r\nb\r\nx\na\nb\n')
})

test('append receipts count the joining line without returning its content', async t => {
  const { root, context, tool } = await fixture(t)
  await writeFile(join(root, 'append.txt'), 'before\nseam')
  const result = await tool.execute({ path: 'append.txt', content: '+next\nlast\n', flag: 'a' }, context)
  assert.doesNotMatch(result, /seam|next|last|L\d:/)
  assert.match(result, /^OK append \+2 -1 edit=/)
  assert.equal(await readFile(join(root, 'append.txt'), 'utf8'), 'before\nseam+next\nlast\n')
  const next = await tool.execute({ path: 'append.txt', content: 'tail', flag: 'a' }, context)
  assert.match(next, /^OK append \+1 -0 edit=/)
  assert.equal(await readFile(join(root, 'append.txt'), 'utf8'), 'before\nseam+next\nlast\ntail')
})

test('deletion, no-op and empty writes do not invent content', async t => {
  const { root, context, tool } = await fixture(t)
  await writeFile(join(root, 'empty.txt'), 'old')
  const unchanged = await tool.execute({ path: 'empty.txt', match: 'old', content: 'old' }, context)
  assert.match(unchanged, /Content unchanged/)
  assert.match(unchanged, /^OK edit \+0 -0/)
  const deleted = await tool.execute({ path: 'empty.txt', match: 'old', content: '' }, context)
  assert.match(deleted, /^OK edit \+0 -1/)
  assert.equal(await readFile(join(root, 'empty.txt'), 'utf8'), '')
  assert.match(await tool.execute({ path: 'empty.txt', content: '', flag: 'a' }, context), /Content unchanged/)
})

test('no-match, I/O failures, workspace restrictions and aborts never return success', async t => {
  const { root, context, tool } = await fixture(t)
  await writeFile(join(root, 'safe.txt'), 'unchanged')
  assert.match(await tool.execute({ path: 'safe.txt', match: 'missing', content: 'bad' }, context), /^Error:/)
  assert.equal(await readFile(join(root, 'safe.txt'), 'utf8'), 'unchanged')
  await assert.rejects(tool.execute({ path: '.', content: 'bad', flag: 'a' }, context))
  assert.match(await new WriteTool(root, true).execute({ path: join('..', 'outside.txt'), content: 'bad' }, context), /^Error:/)
  await assert.rejects(tool.execute({ path: 'safe.txt', content: 'bad' }, { ...context, signal: AbortSignal.abort() }), { name: 'AbortError' })
  assert.equal(await readFile(join(root, 'safe.txt'), 'utf8'), 'unchanged')
})

test('long lines and many replacements never leak source content into receipts', () => {
  const edit = applyReplacementDetailed('x'.repeat(5000) + 'old' + 'y'.repeat(5000), 'old', 'BOUNDARY')
  assert.ok(edit)
  const result = formatWriteResult({ mode: 'edit', edit, lineChanges: { unavailable: 'Previous file text was not observed.' } })
  assert.doesNotMatch(result, /BOUNDARY|UTF-16 columns/)
  assert.ok(result.length <= MAX_WRITE_RESULT_CHARS)
  assert.match(result, /Diff unavailable/)
  assert.match(result, /Previous file text was not observed/)
  const many = applyReplacementDetailed('old\n'.repeat(10000), 'old', 'value'.repeat(100), true)
  assert.ok(many)
  const bounded = formatWriteResult({
    mode: 'edit', edit: many,
    lineChanges: { added: 10000, removed: 10000 },
  })
  assert.equal(bounded.split('\n')[0], 'OK edit +10000 -10000')
  assert.match(bounded, /Replacements: 10000/)
  assert.doesNotMatch(bounded, /value|old/)
  assert.ok(bounded.length <= MAX_WRITE_RESULT_CHARS)
})

test('remote append previews and disk writes use only the capability workdir', async t => {
  const { root, context, tool } = await fixture(t)
  const changes: RecordedFileChange[] = []
  context.toolCallId = 'remote-write'
  context.recordFileChange = async change => { changes.push(change) }
  const child = join(root, 'child')
  await mkdir(child)
  await writeFile(join(root, 'notes.txt'), 'main sentinel')
  await writeFile(join(child, 'notes.txt'), 'remote seam')
  const filesystem = new CapabilityFilesystem([{ capabilityId: 'child-root', rootPath: child }])
  const executor: Executor = {
    async *execute(request, signal) {
      const text = await filesystem.execute(request, signal ?? AbortSignal.timeout(5000))
      const timestamp = new Date().toISOString()
      yield { version: 1, jobId: request.jobId, sequence: 0, timestamp, type: 'stdout', chunk: text }
      yield { version: 1, jobId: request.jobId, sequence: 1, timestamp, type: 'completed',
        receipt: { version: 1, jobId: request.jobId, nodeId: request.nodeId, state: 'completed', finishedAt: timestamp } }
    },
    async getStatus() { return null },
    async cancel() { throw new Error('Not used') },
  }
  const result = await tool.execute({ path: 'notes.txt', content: '+next', flag: 'a' }, {
    ...context, remoteWorkdir: { executor, nodeId: 'child', capabilityId: 'child-root' },
  })
  assert.doesNotMatch(result, /remote seam/)
  assert.match(result, /^OK append \+1 -1/)
  assert.equal(await readFile(join(child, 'notes.txt'), 'utf8'), 'remote seam+next')
  assert.equal(await readFile(join(root, 'notes.txt'), 'utf8'), 'main sentinel')
  const overwritten = await tool.execute({ path: 'notes.txt', content: 'different\ntext\n' }, {
    ...context, remoteWorkdir: { executor, nodeId: 'child', capabilityId: 'child-root' },
  })
  assert.match(overwritten, /^OK write \+2 -1/)
  assert.equal(await readFile(join(child, 'notes.txt'), 'utf8'), 'different\ntext\n')
  assert.equal(await readFile(join(root, 'notes.txt'), 'utf8'), 'main sentinel')
  assert.equal(changes.length, 2)
  assert.equal(changes[0].path, 'notes.txt', 'Remote paths stay opaque instead of resolving against Main')
  assert.ok(changes[0].patch.includes('-remote seam'))
  assert.ok(changes[0].patch.includes('+remote seam+next'))
})

test('binary append is rejected without changing bytes or recording a successful edit', async t => {
  const { root, context, tool } = await fixture(t)
  const changes: RecordedFileChange[] = []
  context.toolCallId = 'binary-append'
  context.recordFileChange = async change => { changes.push(change) }
  await writeFile(join(root, 'binary.dat'), Buffer.from([0xff, 0xfe]))
  await assert.rejects(tool.execute({ path: 'binary.dat', content: 'tail', flag: 'a' }, context), /requires UTF-8/)
  assert.equal(changes.length, 0)
  assert.deepEqual(await readFile(join(root, 'binary.dat')), Buffer.from([0xff, 0xfe]))
})

test('overwrites compare the complete previous file including duplicate and unchanged regions', async t => {
  const { root, context, tool } = await fixture(t)
  const before = 'keep\nold\nkeep\nold\nlast\n'
  const content = 'keep\nnew\nkeep\nnew\nlast\n'
  await writeFile(join(root, 'overwrite.txt'), before)
  const result = await tool.execute({ path: 'overwrite.txt', content }, context)
  assert.match(result, /^OK write \+2 -2/)
  assert.equal(await readFile(join(root, 'overwrite.txt'), 'utf8'), content)
  const noOp = await tool.execute({ path: 'overwrite.txt', content }, context)
  assert.match(noOp, /^OK write \+0 -0/)
  const deleted = await tool.execute({ path: 'overwrite.txt', content: '' }, context)
  assert.match(deleted, /^OK write \+0 -5/)
})

test('global replacement counts include regions beyond the preview cap and no double counting per line', async t => {
  const { root, context, tool } = await fixture(t)
  await writeFile(join(root, 'global.txt'), 'old old\nkeep\n'.repeat(6))
  const result = await tool.execute({ path: 'global.txt', match: 'old', content: 'new', flag: 'g' }, context)
  assert.match(result, /Replacements: 12/)
  assert.match(result, /^OK edit \+6 -6/)
})

test('newline normalization alone is not a line change while indentation remains meaningful', async t => {
  const { root, context, tool } = await fixture(t)
  await writeFile(join(root, 'crlf.txt'), 'one\r\ntwo\r\n')
  const edit = await tool.execute({ path: 'crlf.txt', match: 'one', content: 'one' }, context)
  assert.match(edit, /^OK edit \+0 -0/)
  await writeFile(join(root, 'crlf.txt'), 'one\r\ntwo\r\n')
  const overwrite = await tool.execute({ path: 'crlf.txt', content: 'one\ntwo\n' }, context)
  assert.match(overwrite, /^OK write \+0 -0/)
  await writeFile(join(root, 'indent.txt'), '    first\n      second\nlast\n')
  const exact = await tool.execute({
    path: 'indent.txt', match: '    first\n      second', content: 'first\n  changed',
  }, context)
  assert.match(exact, /match: exact/)
  assert.match(exact, /^OK edit \+2 -2/)
})

test('full writes still succeed when previous content is too large or not UTF-8 text', async t => {
  const { root, context, tool } = await fixture(t)
  for (const before of ['x'.repeat(MAX_LINE_DIFF_CHARS + 1), Buffer.from([0xff])]) {
    await writeFile(join(root, 'unavailable.txt'), before)
    const result = await tool.execute({ path: 'unavailable.txt', content: 'new' }, context)
    assert.match(result, /^OK write edit=/)
    assert.match(result, /Diff unavailable: Previous file/)
    assert.equal(await readFile(join(root, 'unavailable.txt'), 'utf8'), 'new')
  }
})

test('read-forbidden local overwrite retains write-only permission semantics', async t => {
  const { root } = await fixture(t)
  await writeFile(join(root, 'write-only.txt'), 'before')
  const script = `
    import { WriteTool } from './src/tools/filesystem.ts'
    const root = ${JSON.stringify(root)}
    const result = await new WriteTool(root).execute(
      { path: 'write-only.txt', content: 'after' },
      { cwd: root, signal: new AbortController().signal },
    )
    console.log(result)
  `
  const { stdout } = await promisify(execFile)(process.execPath, [
    '--permission',
    ...['src', 'node_modules', 'package.json', 'tsconfig.json'].map(path => `--allow-fs-read=${resolve(path)}`),
    `--allow-fs-write=${root}`,
    '--experimental-transform-types', '--input-type=module', '--eval', script,
  ], { cwd: resolve('.') })
  assert.match(stdout, /^OK write/)
  assert.match(stdout, /Diff unavailable/)
  assert.match(stdout, /Reading the previous file was not permitted/)
  assert.equal(await readFile(join(root, 'write-only.txt'), 'utf8'), 'after')
})
