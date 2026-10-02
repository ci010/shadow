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

async function fixture(t: TestContext) {
  const scratch = resolve('.tmp')
  await mkdir(scratch, { recursive: true })
  const root = await mkdtemp(join(scratch, 'write-result-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const context: ExecutionContext = {
    channel: 'test', chatId: 'chat', senderId: 'user', messageId: 'turn',
    sessionId: 'test:write', physicalSessionId: 'test-write-0', cwd: root,
    signal: new AbortController().signal, tools: new SessionTools(new Tools(root), root),
  }
  return { root, context, tool: new WriteTool(root) }
}

test('full writes report UTF-8 size, real line labels and bounded head/tail excerpts', async t => {
  const { root, context, tool } = await fixture(t)
  const content = Array.from({ length: 50 }, (_, i) => `row ${i + 1}`).join('\n') + '\n'
  const result = await tool.execute({ path: 'nested/file.txt', content }, context)
  assert.equal(await readFile(join(root, 'nested', 'file.txt'), 'utf8'), content)
  assert.match(result, /Success: write/)
  assert.match(result, /result lines: 50/)
  assert.match(result, /L1: row 1/)
  assert.match(result, /L50: row 50/)
  assert.match(result, /lines 4-47 omitted/)
  assert.match(result, /not a post-write read-back/)
  assert.equal(result.split('\n')[2], 'Line changes: +50 -0.')
  const unicode = '\u4f60\u597d\n'
  assert.match(await tool.execute({ path: 'unicode.txt', content: unicode }, context), /UTF-8 bytes written: 7/)
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
test('exact edits show final-file boundaries and adjacent unchanged lines', async t => {
  const { root, context, tool } = await fixture(t)
  await writeFile(join(root, 'edit.txt'), 'one\ntwo\nold\nfour\nfive\n')
  const result = await tool.execute({ path: 'edit.txt', match: 'old', content: 'new\nsecond' }, context)
  assert.equal(await readFile(join(root, 'edit.txt'), 'utf8'), 'one\ntwo\nnew\nsecond\nfour\nfive\n')
  assert.match(result, /Replacements: 1; match: exact/)
  assert.match(result, /Written range: L3-L4/)
  assert.match(result, /L2: two/)
  assert.match(result, /L4: second/)
  assert.match(result, /L5: four/)
  assert.equal(result.split('\n')[2], 'Line changes: +2 -1.')
})

test('global replacements use literal replacement text and final offsets', () => {
  const edit = applyReplacementDetailed('a\nx\na\nx\na\n', 'a', '$&\nnew', true)
  assert.ok(edit)
  assert.equal(edit.content, '$&\nnew\nx\n$&\nnew\nx\n$&\nnew\n')
  assert.equal(edit.count, 3)
  for (const range of edit.ranges) assert.equal(edit.content.slice(range.start, range.end), '$&\nnew')
  assert.equal(applyReplacement('a a', 'a', "$`-$'-$&-$$", true), "$`-$'-$&-$$ $`-$'-$&-$$")
  assert.equal(applyReplacement('ab', '', '-', true), '-a-b-')
})

test('fuzzy matching and CRLF normalization are disclosed without changing fallback semantics', async t => {
  const { root, context, tool } = await fixture(t)
  await writeFile(join(root, 'fuzzy.txt'), 'before\r\n  old  \r\n  old  \r\nafter\r\n')
  const result = await tool.execute({ path: 'fuzzy.txt', match: 'old\n', content: 'new', flag: 'g' }, context)
  assert.match(result, /^Error:/)
  const fuzzy = await tool.execute({ path: 'fuzzy.txt', match: '\told', content: 'new', flag: 'g' }, context)
  assert.match(fuzzy, /match: line-trimmed/)
  assert.match(fuzzy, /fuzzy fallback replaces one region only/)
  assert.match(fuzzy, /CRLF line endings were normalized/)
  assert.match(fuzzy, /Written range: L2-L2/)
  assert.equal(fuzzy.split('\n')[2], 'Line changes: +1 -1.')
  assert.equal(await readFile(join(root, 'fuzzy.txt'), 'utf8'), 'before\nnew\n  old  \nafter\n')
})

test('append previews show the joining line with and without a trailing newline', async t => {
  const { root, context, tool } = await fixture(t)
  await writeFile(join(root, 'append.txt'), 'before\nseam')
  const result = await tool.execute({ path: 'append.txt', content: '+next\nlast\n', flag: 'a' }, context)
  assert.match(result, /Appended range: L2-L3/)
  assert.match(result, /L2: seam\+next/)
  assert.match(result, /L3: last/)
  assert.equal(result.split('\n')[2], 'Line changes: +2 -1.')
  assert.equal(await readFile(join(root, 'append.txt'), 'utf8'), 'before\nseam+next\nlast\n')
  const next = await tool.execute({ path: 'append.txt', content: 'tail', flag: 'a' }, context)
  assert.match(next, /Appended range: L4-L4/)
  assert.match(next, /L3: last/)
  assert.match(next, /L4: tail/)
  assert.equal(next.split('\n')[2], 'Line changes: +1 -0.')
})

test('deletion, no-op and empty writes do not invent content', async t => {
  const { root, context, tool } = await fixture(t)
  await writeFile(join(root, 'empty.txt'), 'old')
  const unchanged = await tool.execute({ path: 'empty.txt', match: 'old', content: 'old' }, context)
  assert.match(unchanged, /Content unchanged/)
  assert.equal(unchanged.split('\n')[2], 'Line changes: +0 -0.')
  const deleted = await tool.execute({ path: 'empty.txt', match: 'old', content: '' }, context)
  assert.match(deleted, /Empty replacement at L1/)
  assert.match(deleted, /\(File is empty\.\)/)
  assert.equal(deleted.split('\n')[2], 'Line changes: +0 -1.')
  assert.equal(await readFile(join(root, 'empty.txt'), 'utf8'), '')
  assert.match(await tool.execute({ path: 'empty.txt', content: '', flag: 'a' }, context), /No text appended/)
})

test('no-match, I/O failures, workspace restrictions and aborts never return success', async t => {
  const { root, context, tool } = await fixture(t)
  await writeFile(join(root, 'safe.txt'), 'unchanged')
  assert.match(await tool.execute({ path: 'safe.txt', match: 'missing', content: 'bad' }, context), /^Error:/)
  assert.equal(await readFile(join(root, 'safe.txt'), 'utf8'), 'unchanged')
  await assert.rejects(tool.execute({ path: '.', content: 'bad', flag: 'a' }, context))
  assert.match(await new WriteTool(root, undefined, true).execute({ path: join('..', 'outside.txt'), content: 'bad' }, context), /^Error:/)
  await assert.rejects(tool.execute({ path: 'safe.txt', content: 'bad' }, { ...context, signal: AbortSignal.abort() }), { name: 'AbortError' })
  assert.equal(await readFile(join(root, 'safe.txt'), 'utf8'), 'unchanged')
})

test('long lines retain edit boundary text and many replacements have a hard output cap', () => {
  const edit = applyReplacementDetailed('x'.repeat(5000) + 'old' + 'y'.repeat(5000), 'old', 'BOUNDARY')
  assert.ok(edit)
  const result = formatWriteResult({ path: 'long.txt', mode: 'edit', content: edit.content, edit, writtenBytes: edit.content.length })
  assert.match(result, /BOUNDARY/)
  assert.match(result, /UTF-16 columns/)
  assert.ok(result.length <= MAX_WRITE_RESULT_CHARS)
  assert.equal(result.split('\n')[2], 'Line changes: unavailable.')
  assert.match(result, /Previous file text was not observed/)
  const longFile = 'HEAD' + 'x'.repeat(10000) + 'TAIL'
  const full = formatWriteResult({ path: 'single-line.txt', mode: 'write', content: longFile, writtenBytes: longFile.length })
  assert.match(full, /HEAD/)
  assert.match(full, /TAIL/)
  const many = applyReplacementDetailed('old\n'.repeat(10000), 'old', 'value'.repeat(100), true)
  assert.ok(many)
  const bounded = formatWriteResult({
    path: 'many\nlines.txt', mode: 'edit', content: many.content, edit: many, writtenBytes: many.content.length,
    lineChanges: { added: 10000, removed: 10000 },
  })
  assert.match(bounded.split('\n')[0], /^Success: edit many\\nlines.txt$/)
  assert.match(bounded.split('\n')[1], /^UTF-8 bytes written:/)
  assert.equal(bounded.split('\n')[2], 'Line changes: +10000 -10000.')
  assert.match(bounded, /Replacements: 10000/)
  assert.match(bounded, /Showing first 4 of 10000/)
  assert.ok(bounded.length <= MAX_WRITE_RESULT_CHARS)
})

test('remote append previews and disk writes use only the capability workdir', async t => {
  const { root, context, tool } = await fixture(t)
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
  assert.match(result, /L1: remote seam\+next/)
  assert.equal(result.split('\n')[2], 'Line changes: +1 -1.')
  assert.equal(await readFile(join(child, 'notes.txt'), 'utf8'), 'remote seam+next')
  assert.equal(await readFile(join(root, 'notes.txt'), 'utf8'), 'main sentinel')
  const overwritten = await tool.execute({ path: 'notes.txt', content: 'different\ntext\n' }, {
    ...context, remoteWorkdir: { executor, nodeId: 'child', capabilityId: 'child-root' },
  })
  assert.equal(overwritten.split('\n')[2], 'Line changes: +2 -1.')
  assert.equal(await readFile(join(child, 'notes.txt'), 'utf8'), 'different\ntext\n')
  assert.equal(await readFile(join(root, 'notes.txt'), 'utf8'), 'main sentinel')
})

test('overwrites compare the complete previous file including duplicate and unchanged regions', async t => {
  const { root, context, tool } = await fixture(t)
  const before = 'keep\nold\nkeep\nold\nlast\n'
  const content = 'keep\nnew\nkeep\nnew\nlast\n'
  await writeFile(join(root, 'overwrite.txt'), before)
  const result = await tool.execute({ path: 'overwrite.txt', content }, context)
  assert.equal(result.split('\n')[2], 'Line changes: +2 -2.')
  assert.equal(await readFile(join(root, 'overwrite.txt'), 'utf8'), content)
  const noOp = await tool.execute({ path: 'overwrite.txt', content }, context)
  assert.equal(noOp.split('\n')[2], 'Line changes: +0 -0.')
  const deleted = await tool.execute({ path: 'overwrite.txt', content: '' }, context)
  assert.equal(deleted.split('\n')[2], 'Line changes: +0 -5.')
})

test('global replacement counts include regions beyond the preview cap and no double counting per line', async t => {
  const { root, context, tool } = await fixture(t)
  await writeFile(join(root, 'global.txt'), 'old old\nkeep\n'.repeat(6))
  const result = await tool.execute({ path: 'global.txt', match: 'old', content: 'new', flag: 'g' }, context)
  assert.match(result, /Replacements: 12/)
  assert.match(result, /Showing first 4 of 12/)
  assert.equal(result.split('\n')[2], 'Line changes: +6 -6.')
})

test('newline normalization alone is not a line change while indentation remains meaningful', async t => {
  const { root, context, tool } = await fixture(t)
  await writeFile(join(root, 'crlf.txt'), 'one\r\ntwo\r\n')
  const edit = await tool.execute({ path: 'crlf.txt', match: 'one', content: 'one' }, context)
  assert.equal(edit.split('\n')[2], 'Line changes: +0 -0.')
  await writeFile(join(root, 'crlf.txt'), 'one\r\ntwo\r\n')
  const overwrite = await tool.execute({ path: 'crlf.txt', content: 'one\ntwo\n' }, context)
  assert.equal(overwrite.split('\n')[2], 'Line changes: +0 -0.')
  await writeFile(join(root, 'indent.txt'), '    first\n      second\nlast\n')
  const fuzzy = await tool.execute({
    path: 'indent.txt', match: 'first\n  second', content: 'first\n  changed',
  }, context)
  assert.match(fuzzy, /match: line-trimmed/)
  assert.equal(fuzzy.split('\n')[2], 'Line changes: +2 -2.')
})

test('full writes still succeed when previous content is too large or not UTF-8 text', async t => {
  const { root, context, tool } = await fixture(t)
  for (const before of ['x'.repeat(MAX_LINE_DIFF_CHARS + 1), Buffer.from([0xff])]) {
    await writeFile(join(root, 'unavailable.txt'), before)
    const result = await tool.execute({ path: 'unavailable.txt', content: 'new' }, context)
    assert.match(result, /^Success: write/)
    assert.equal(result.split('\n')[2], 'Line changes: unavailable.')
    assert.match(result, /Line changes unavailable: Previous file/)
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
  assert.match(stdout, /^Success: write/)
  assert.equal(stdout.split('\n')[2], 'Line changes: unavailable.')
  assert.match(stdout, /Reading the previous file was not permitted/)
  assert.equal(await readFile(join(root, 'write-only.txt'), 'utf8'), 'after')
})
