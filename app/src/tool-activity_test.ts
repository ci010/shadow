import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupToolActivity, parseLineChanges, type ToolActivityMessage } from './tool-activity.ts'
import { countLineChanges } from '../../src/tools/line-changes.ts'
import { formatWriteResult } from '../../src/tools/write-result.ts'

const call = (name: string, args: Record<string, unknown>): ToolActivityMessage => ({ event: 'tool_call', content: '', toolCall: { name, arguments: args } })
const result = (text: string): ToolActivityMessage => ({ event: 'tool_result', content: text })
const success = (added: number, removed: number) => result(`Success: edit a.ts\nUTF-8 bytes written: 42; result lines: 5.\nLine changes: +${added} -${removed}.\nL1: output`)

test('actual backend write reports feed operation counts into tool activity', () => {
  const content = 'same\nnew\nextra\n'
  const report = formatWriteResult({
    path: 'a.ts', mode: 'write', content, writtenBytes: Buffer.byteLength(content),
    lineChanges: countLineChanges('same\nold\n', content),
  })
  const batch = groupToolActivity([call('write', { path: 'a.ts', content }), result(report)]).get(0)!
  assert.deepEqual(batch.changes, { added: 2, removed: 1 })
  assert.equal(batch.files, 1)
})

test('line counts only come from valid success metadata, never arguments or preview text', () => {
  assert.deepEqual(parseLineChanges(success(12, 3).content), { added: 12, removed: 3 })
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

test('dynamic writes, legacy JSON calls and orphan results retain detail', () => {
  const batch = groupToolActivity([
    call('invoke_tool', { name: 'write', args: { path: '/project/a.ts', match: 'old' } }), success(1, 1),
    { event: 'tool_call', content: 'read({"path":"a.ts"})' }, result('read result'),
    result('orphan'),
  ]).get(0)!
  assert.equal(batch.entries[0].title, 'Edit a.ts')
  assert.equal(batch.entries[0].file, '/project/a.ts')
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
  assert.equal(batch.changes, undefined)
  assert.equal(batch.files, 0)
})
