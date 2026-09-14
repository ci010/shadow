import assert from 'node:assert/strict'
import test from 'node:test'
import { isMemoryEventFile, memoryEventTime, parseMemoryEvents } from './memory-events.ts'
import { formatFileQuote, renderedSelectionLines } from './file-selection.ts'

const event = {
  when: '2026-09-10T16:45:44.093Z', who: 'Coding Assistant', what: 'Updated documentation.',
  why: 'Keep instructions current.', challenge: 'The original path differed.',
  refs: ['memory/topics/project.md'], origin: 'web:chat-fixture',
}

test('only memory event JSONL files use the record view', () => {
  for (const path of ['memory/events/2026-09-10.jsonl', 'Home/memory/events/test.jsonl', 'C:\\Home\\memory\\events\\test.jsonl']) {
    assert.equal(isMemoryEventFile(path), true)
  }
  for (const path of ['events/test.jsonl', 'memory/identities/test.jsonl', 'memory/events/test.json', 'other.jsonl']) {
    assert.equal(isMemoryEventFile(path), false)
  }
})

test('records preserve file order, duplicate events, CRLF source lines and unknown fields', () => {
  const record = { ...event, extra: { status: 'new' }, count: 0 }
  const source = `\uFEFF${JSON.stringify(record)}\r\n\r\n${JSON.stringify(event)}\r\n`
  const records = parseMemoryEvents(source)
  assert.deepEqual(records.map(row => [row.kind, row.start, row.end]), [['event', 1, 1], ['event', 3, 3]])
  assert.equal(records[0]?.kind, 'event')
  if (records[0]?.kind !== 'event') return
  assert.deepEqual(records[0].event, record)
  assert.deepEqual(records[0].extra, [{ name: 'extra', value: '{\n  "status": "new"\n}' }, { name: 'count', value: '0' }])
  assert.deepEqual(parseMemoryEvents(' \r\n\t\n'), [])
  assert.equal(memoryEventTime(event.when), '2026-09-10 16:45:44.093 UTC')
  assert.equal(memoryEventTime('unknown time'), 'unknown time')
})

test('invalid records remain visible and a truncated last line is identified explicitly', () => {
  const invalid = ['{"who":', '[]', '{"what":"missing actor"}', JSON.stringify({ ...event, refs: [1] })]
  const records = parseMemoryEvents(invalid.join('\n'))
  assert.deepEqual(records.map(row => row.kind), ['invalid', 'invalid', 'invalid', 'invalid'])
  records.forEach((row, index) => {
    assert.notEqual(row.kind, 'event')
    if (row.kind !== 'event') assert.equal(row.raw, invalid[index])
  })
  const partial = parseMemoryEvents(`${JSON.stringify(event)}\n{"who":"Cut off`, true)
  assert.deepEqual(partial.map(row => [row.kind, row.start]), [['event', 1], ['partial', 2]])
  assert.equal(parseMemoryEvents(JSON.stringify(event), true)[0]?.kind, 'event')
  assert.equal(parseMemoryEvents('not JSON\n', true)[0]?.kind, 'invalid')
})

test('rendered record selections quote the original JSONL line range and Home path', () => {
  const records = parseMemoryEvents(`\n${JSON.stringify(event)}\n\n${JSON.stringify(event)}`)
  const node = {}
  const root = {
    children: records.map(() => ({})),
    contains: (candidate: unknown) => candidate === node,
    ownerDocument: { createRange: () => ({
      collapsed: false, selectNodeContents() {}, toString: () => event.what,
    }) },
  } as unknown as HTMLElement
  const range = { startContainer: node, endContainer: node, compareBoundaryPoints: () => 0 } as unknown as Range
  const lines = renderedSelectionLines(root, range, records)
  assert.deepEqual(lines, { start: 2, end: 4, provenance: 'source block' })
  assert.equal(formatFileQuote('C:\\Home\\memory\\events\\test.jsonl', event.what, lines!),
    'File: C:\\Home\\memory\\events\\test.jsonl\nLines: 2-4 (source block)\n\nUpdated documentation.')
})
