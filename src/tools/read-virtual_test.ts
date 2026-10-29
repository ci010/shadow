import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ReadTool } from './read.ts'
import type { ExecutionContext } from './context.ts'
import { VirtualFs } from '../vfs/virtual-fs.ts'

const context = { sessionId: 'virtual', physicalSessionId: 'virtual-0', signal: new AbortController().signal } as ExecutionContext
function reader(content: string) {
  const vfs = new VirtualFs()
  vfs.mount('v:fixture', 'fixture', () => content)
  return new ReadTool(process.cwd(), vfs)
}

test('virtual normal paging preserves output and source line coordinates', async () => {
  const tool = reader('one\ntwo\nthree')
  assert.equal(await tool.execute({ path: 'v:fixture' }, context), 'one\ntwo\nthree')
  assert.equal(await tool.execute({ path: 'v:fixture', offset: 2, limit: 1, flag: 'n' }, context), '2  two\n\n[truncated: showing lines 2-2 of 3; use offset=3 to continue]')
})

test('giant virtual line returns bounded useful prefix with honest inaccessible remainder', async () => {
  for (const args of [{}, { limit: 10 }, { offset: 1, limit: 10, flag: 'n' }]) {
    const output = String(await reader('BEGIN' + 'x'.repeat(800_000) + '\ntail').execute({ path: 'v:fixture', ...args }, context))
    assert.match(output, /BEGINx+/)
    assert.ok(output.length <= 100_000)
    assert.match(output, /0 complete line\(s\)/)
    assert.match(output, /line 1 incomplete \(prefix only\)/)
    assert.match(output, /cannot retrieve this line's omitted remainder/)
    assert.match(output, /offset=1 restarts the same line/)
    assert.doesNotMatch(output, /to continue|\ntail/)
  }
})

test('multi-line overflow retains original coordinates and later lines remain readable', async () => {
  const tool = reader('first\nsecond\n' + 'z'.repeat(200_000) + '\nlast')
  const output = String(await tool.execute({ path: 'v:fixture', offset: 2, limit: 3, flag: 'n' }, context))
  assert.match(output, /^2  second\n3  z/)
  assert.match(output, /1 complete line\(s\) starting at 2; line 3 incomplete/)
  assert.ok(output.length <= 100_000)
  assert.equal(await tool.execute({ path: 'v:fixture', offset: 4, limit: 1, flag: 'n' }, context), '4  last')
})

test('overflow at a line boundary reports only fully delivered lines', async () => {
  const output = String(await reader('a'.repeat(97_951) + '\n' + 'b'.repeat(5000)).execute({ path: 'v:fixture' }, context))
  assert.match(output, /showing complete lines 1-1 of 2; use offset=2 to continue/)
  assert.doesNotMatch(output, /incomplete/)
})
