import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupToolActivity, parseLineChanges, toolPayloadPath, type ToolActivityMessage } from './tool-activity.ts'
import { countLineChanges } from '../../src/tools/line-changes.ts'
import { formatWriteResult } from '../../src/tools/write-result.ts'

const call = (name: string, args: Record<string, unknown>): ToolActivityMessage => ({ event: 'tool_call', content: '', toolCall: { name, arguments: args } })
const result = (text: string): ToolActivityMessage => ({ event: 'tool_result', content: text })
const success = (added: number, removed: number) => result(`Success: edit a.ts\nUTF-8 bytes written: 42; result lines: 5.\nLine changes: +${added} -${removed}.\nL1: output`)

test('tool payloads highlight valid JSON without treating plain output or malformed arguments as code', () => {
  for (const source of ['{"path":"file.ts","value":42}', '[true,null,"<script>"]', '"text"', '42', 'null', ' \r\n{"ok": true}\r\n']) {
    assert.equal(toolPayloadPath(source), 'payload.json')
  }
  for (const source of ['', '(Empty result)', 'Message sent to web:chat.', 'Error: missing file', '{"incomplete":', '<script>alert(1)</script>']) {
    assert.equal(toolPayloadPath(source), 'payload.txt')
  }
})

test('read results carry file grammars and numbering, including imported and legacy calls', () => {
  const entries = groupToolActivity([
    call('read', { path: 'src\\main.ts', flag: 'n' }), result('158  const value = true'),
    call('invoke_tool', { name: 'read_file', args: { path: 'main.py' } }), result('print("hello")'),
    { event: 'tool_call', content: 'view({"path":"App.vue"})' }, result('<template />'),
    call('read', { path: 'failed.ts' }), result('Error: missing'),
    call('read', { path: 'v:memory/list.md', flag: 'l' }), result('list'),
    call('write', { path: 'out.ts' }), result('OK write +1 -0'),
    call('search', { handler: 'grep', include: '*.ts', query: 'needle' }), result('No matches found'),
    call('search', { handler: 'web', query: 'needle' }), result('web'),
  ]).get(0)!.entries
  assert.deepEqual(entries.map(entry => entry.readPath), ['src\\main.ts', 'main.py', 'App.vue', undefined, undefined, undefined, undefined, undefined])
  assert.equal(entries[0].lineNumbers, true)
  assert.equal(entries[1].lineNumbers, false)
  assert.equal(entries[6].grep, true)
  assert.equal(entries[7].grep, false)
})

test('actual backend write reports feed operation counts into tool activity', () => {
  const content = 'same\nnew\nextra\n'
  const report = formatWriteResult({
    mode: 'write',
    lineChanges: countLineChanges('same\nold\n', content),
  })
  const batch = groupToolActivity([call('write', { path: 'a.ts', content }), result(report)]).get(0)!
  assert.deepEqual(batch.changes, { added: 2, removed: 1 })
  assert.equal(batch.files, 1)
})

test('line counts only come from valid success metadata, never arguments or preview text', () => {
  assert.deepEqual(parseLineChanges(success(12, 3).content), { added: 12, removed: 3 })
  assert.deepEqual(parseLineChanges('OK edit +12 -3 edit=fixture\nReplacements: 1; match: exact.'), { added: 12, removed: 3 })
  assert.equal(parseLineChanges('OK write edit=fixture\nDiff unavailable: Size limit'), undefined)
  for (const content of ['Error: write failed', 'Success: edit a.ts\nL1: Line changes: +1 -2.', 'Success: edit a.ts\nUTF-8 bytes written: 3; result lines: 1.\nLine changes: unavailable.', success(1, 2).content.replace('+1', '+9007199254740992')]) {
    assert.equal(parseLineChanges(content), undefined)
  }
})

test('group counts sum successful operations and deduplicate files without crossing prose', () => {
  const groups = groupToolActivity([
    call('read', { path: 'a.ts' }), result('text'),
    call('write', { path: 'src\\a.ts', match: 'old', content: 'new' }), success(3, 1),
    call('write', { path: 'src\\a.ts', flag: 'a', content: 'more' }), success(2, 0),
    { content: 'Assistant explanation' },
    call('exec', { command: 'pnpm test', description: 'Run focused tests' }), result('Passed'),
  ])
  assert.equal(groups.size, 2)
  assert.equal(groups.get(0)?.entries.length, 3)
  assert.equal(groups.get(0)?.files, 1)
  assert.deepEqual(groups.get(0)?.changes, { added: 5, removed: 1 })
  assert.equal(groups.get(0)?.entries[1].title, 'Edit a.ts')
  assert.equal(groups.get(7)?.entries[0].title, 'Run focused tests')
})

test('failed, legacy and pending edits never invent counts; partial aggregates are marked', () => {
  const batch = groupToolActivity([
    call('write', { path: 'a' }), success(1, 0),
    call('write', { path: 'b' }), result('Success: write b\nOld format'),
    call('write', { path: 'c' }), result('Error: permission denied'),
    call('write', { path: 'd' }),
  ]).get(0)!
  assert.equal(batch.files, 2)
  assert.equal(batch.incomplete, true)
  assert.deepEqual(batch.changes, { added: 1, removed: 0 })
  assert.equal(batch.entries[2].failed, true)
  assert.equal(batch.entries[3].changes, undefined)
})

test('read and write entries keep file paths even before results or on failure', () => {
  const entries = groupToolActivity([
    call('read', { path: 'src\\server.py' }), result('contents'),
    call('write', { path: 'src/server.py', match: 'before' }), result('Error: permission denied'),
    call('write', { path: 'src/mystery.xyz', match: 'before' }),
    call('exec', { command: 'echo server.py' }),
  ]).get(0)!.entries
  assert.deepEqual(entries.map(entry => entry.path), ['src\\server.py', 'src/server.py', 'src/mystery.xyz', undefined])
  assert.equal(entries[1].file, undefined, 'Failed edits are not counted as completed file changes')
  assert.equal(entries[2].file, undefined, 'Pending edits are not counted as completed file changes')
})

test('dynamic writes, legacy JSON calls and orphan results retain detail', () => {
  const batch = groupToolActivity([
    call('invoke_tool', { name: 'write', args: { path: '/folder/a.ts', match: 'old' } }), success(1, 1),
    { event: 'tool_call', content: 'read({"path":"a.ts"})' }, result('read result'),
    result('orphan'),
  ]).get(0)!
  assert.equal(batch.entries[0].title, 'Edit a.ts')
  assert.equal(batch.entries[0].file, '/folder/a.ts')
  assert.match(batch.entries[0].arguments, /"args"/)
  assert.equal(batch.entries[1].title, 'View a.ts')
  assert.equal(batch.entries[2].result, 'orphan')
})

test('a mismatched tool result cannot contribute counts to a pending file edit', () => {
  const batch = groupToolActivity([
    { ...call('write', { path: 'pending.ts' }), toolCallId: 'pending' },
    { ...success(50, 4), toolCallId: 'other' },
  ]).get(0)!
  assert.equal(batch.entries.length, 2)
  assert.equal(batch.entries[0].result, undefined)
  assert.equal(batch.entries[0].toolCallId, 'pending')
  assert.equal(batch.changes, undefined)
  assert.equal(batch.files, 0)
})

test('successful dynamic edits retain the outer tool-call identity for historical preview lookup', () => {
  const batch = groupToolActivity([
    { ...call('invoke_tool', { name: 'write', args: { path: 'file.ts', match: 'old', content: 'new' } }), toolCallId: 'edit-1' },
    { ...success(1, 1), toolCallId: 'edit-1' },
  ]).get(0)!
  assert.equal(batch.entries[0].toolCallId, 'edit-1')
  assert.equal(batch.entries[0].file, 'file.ts')
  assert.equal(batch.files, 1)
})


test('search activity recognizes new handlers and stored legacy calls without treating web as grep', () => {
  const entries = groupToolActivity([
    call('search', { handler: 'grep', path: 'v:tools', query: 'needle' }), result('match'),
    call('search', { space: 'grep:v:tools', query: 'needle' }), result('match'),
    call('search', { handler: 'web', domain: 'example.com', query: 'needle' }), result('web'),
    call('search', { handler: 'glob', path: 'v:tools', query: '*' }), result('path'),
  ]).get(0)!.entries
  assert.deepEqual(entries.map(entry => entry.grep), [true, true, false, false])
})
