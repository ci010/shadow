import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ReadCoverage, rejectedHistoryReference } from './read-coverage.ts'

test('oversized historical read is repaired by complete later pages', () => {
  const reads = new ReadCoverage()
  reads.fail('a', { offset: 1, limit: 99999 }, 'old read error')
  reads.success('a', { offset: 1, limit: 2 }, 'a\nb\n\n[truncated: showing lines 1-2 of 4; use offset=3 to continue]')
  assert.match(reads.errors()[0], /old read error/)
  reads.success('a', { offset: 3, limit: 2 }, 'c\nd')
  assert.deepEqual(reads.errors(), [])
})
test('gaps, different resources, partial lines and later failures stay unresolved', () => {
  const reads = new ReadCoverage()
  reads.fail('a', { offset: 1, limit: 4 }, 'unread')
  reads.success('b', { offset: 1, limit: 4 }, 'a\nb\nc\nd')
  reads.success('a', { offset: 3, limit: 2 }, 'c\nd')
  reads.success('a', { offset: 1, limit: 4 }, 'a\n[truncated: token budget; line 2 incomplete]')
  assert.equal(reads.errors().length, 1)
  reads.success('a', { offset: 1, limit: 4 }, 'a\nb\nc\nd')
  assert.equal(reads.errors().length, 0)
  reads.fail('a', { offset: 1, limit: 4 }, 'new failure')
  assert.match(reads.errors()[0], /new failure/)
})

test('only consistent terminal footers prove coverage; nested metadata and receipts do not', () => {
  const invalid = [
    'a\n\n[truncated: showing lines 1-1 of 2; use offset=2 to continue]\nmore transcript',
    'a\n\n[truncated: showing lines 2-2 of 2; use offset=3 to continue]',
    'a\n\n[truncated: showing lines 1-9 of 2; use offset=10 to continue]',
    'a\n\n[truncated: showing lines 1-1 of 2; use offset=9 to continue]',
    'a\n\n[truncated: showing lines 1-2 of 4; use offset=3 to continue]',
    '[file unchanged, content already in context]', '',
  ]
  for (const text of invalid) {
    const reads = new ReadCoverage()
    reads.fail('a', { offset: 1, limit: 99 }, 'failure')
    reads.success('a', { offset: 1, limit: 2 }, text)
    assert.equal(reads.errors().length, 1, text)
  }
  const reads = new ReadCoverage()
  reads.fail('a', { offset: 1, limit: 99 }, 'failure')
  reads.success('a', { offset: 1, limit: 2 }, 'a\nb')
  assert.deepEqual(reads.errors(), [])
})

test('rejected typo history can recover only via unambiguous batch reference and complete later coverage', () => {
  const wrong = 'v:sessions/web_chat-example-v2-f838aca7a-0/overview'
  const correct = 'v:sessions/web_chat-example-v2-f83865aca7a-0/overview'
  const error = 'Error: Physical history does not belong to this Project session'
  assert.equal(rejectedHistoryReference(wrong, error, [correct]), correct)
  for (const refs of [[], [correct.replace('example', 'foreign')], [correct.replace('-0/', '-1/')], [correct, correct.replace('65', '66')]]) {
    assert.equal(rejectedHistoryReference(wrong, error, refs), wrong)
  }
  assert.equal(rejectedHistoryReference(wrong, 'Error: denied', [correct]), wrong)
  const reads = new ReadCoverage()
  reads.fail(rejectedHistoryReference(wrong, error, [correct]), { offset: 1, limit: 900 }, error)
  reads.success(correct, { offset: 3, limit: 2 }, 'c\nd')
  assert.equal(reads.errors().length, 1)
  reads.success(correct, { offset: 1, limit: 2 }, 'a\nb\n\n[truncated: showing lines 1-2 of 4; use offset=3 to continue]')
  assert.deepEqual(reads.errors(), [])
  reads.fail(correct, { offset: 1, limit: 4 }, 'Error: unavailable')
  assert.equal(reads.errors().length, 1)
})
