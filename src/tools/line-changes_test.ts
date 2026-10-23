import assert from 'node:assert/strict'
import { test } from 'node:test'
import { countLineChanges, MAX_LINE_DIFF_CHARS, MAX_LINE_DIFF_EDITS, MAX_LINE_DIFF_LINES } from './line-changes.ts'

test('line changes count replacements, duplicates and separated changes rather than net length', () => {
  const cases: Array<[string, string, number, number]> = [
    ['', '', 0, 0],
    ['', 'one\ntwo\n', 2, 0],
    ['one\ntwo\n', '', 0, 2],
    ['old\n', 'new\n', 1, 1],
    ['keep\nold\nkeep\nold\nkeep\n', 'keep\nnew\nkeep\nnew\nkeep\n', 2, 2],
    ['a\nb\na\n', 'a\na\nb\n', 1, 1],
    ['a\na\na\n', 'a\na\n', 0, 1],
    ['a\n\nb\n', 'a\nb\n', 0, 1],
    ['a\n', ' a\n', 1, 1],
    ['a \n', 'a\n', 1, 1],
    ['a\r\nb\r\n', 'a\nb\n', 0, 0],
    ['a\rb\n', 'ab\n', 1, 1],
    ['a', 'a\n', 1, 1],
    ['a\nseam', 'a\nseam+next\nlast\n', 2, 1],
    ['a\n', 'a\nnext\n', 1, 0],
    ['\n', '\n\n', 1, 0],
  ]
  for (const [before, after, added, removed] of cases) {
    assert.deepEqual(countLineChanges(before, after), { added, removed }, JSON.stringify({ before, after }))
  }
})

test('duplicate-rich small inputs agree with an independent longest common subsequence oracle', () => {
  let seed = 1
  const generate = () => Array.from({ length: 8 }, () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return ['a', 'b', 'c', '', ' a'][seed % 5]
  })
  for (let sample = 0; sample < 100; sample++) {
    const before = generate()
    const after = generate()
    const lengths = Array.from({ length: 9 }, () => Array<number>(9).fill(0))
    for (let i = 1; i <= before.length; i++) {
      for (let j = 1; j <= after.length; j++) {
        lengths[i][j] = before[i - 1] === after[j - 1]
          ? lengths[i - 1][j - 1] + 1
          : Math.max(lengths[i - 1][j], lengths[i][j - 1])
      }
    }
    assert.deepEqual(countLineChanges(before.join('\n') + '\n', after.join('\n') + '\n'), {
      added: after.length - lengths[8][8], removed: before.length - lengths[8][8],
    })
  }
})

test('large input and expensive diffs explicitly return unavailable, not approximate counts', () => {
  assert.match(countLineChanges('', 'x'.repeat(MAX_LINE_DIFF_CHARS + 1)).unavailable!, /character diff limit/)
  assert.match(countLineChanges('', '\n'.repeat(MAX_LINE_DIFF_LINES + 1)).unavailable!, /line diff limit/)
  const before = 'old\n'.repeat(MAX_LINE_DIFF_EDITS)
  const after = 'new\n'.repeat(MAX_LINE_DIFF_EDITS)
  const result = countLineChanges(before, after)
  assert.match(result.unavailable!, /computation limit/)
  assert.equal(result.added, undefined)
  assert.equal(result.removed, undefined)
})
