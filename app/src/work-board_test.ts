import assert from 'node:assert/strict'
import test from 'node:test'
import { measuredOffsets, measuredRange, workBoardColumns } from './work-board.ts'
import { filterWork } from './project-work.ts'
import type { ProjectWorkItem } from '../../src/projects/work-overview.ts'
const item = (key: string, extra: Partial<ProjectWorkItem> = {}): ProjectWorkItem => ({ key, title: key, revision: 1, sequence: 1,
  status: 'done', parentKey: null, dependencies: [], blockedReason: null, manager: null, assignee: null, paused: false,
  changedAt: '', ...extra })
test('board includes finished roots and descendants with consistent search and assignee filters', () => {
  const all = [item('finished'), item('child', { parentKey: 'finished', assignee: 'worker' }), item('active', { status: 'in_progress' })]
  const filtered = filterWork(all, { query: '', root: '', assignee: '', terminal: true })
  const done = workBoardColumns(filtered, all).find(column => column.status === 'done')!
  assert.deepEqual(done.rows.map(row => [row.key, row.groupTitle, row.startsGroup]), [['finished', 'finished', true], ['child', 'finished', false]])
  const match = filterWork(all, { query: 'child', root: 'finished', assignee: 'worker', terminal: true })
  assert.deepEqual(workBoardColumns(match, all).find(column => column.status === 'done')!.rows.map(row => row.key), ['child'])
  all[1]!.status = 'in_progress'
  assert.deepEqual(workBoardColumns(match, all).find(column => column.status === 'done')!.rows, [])
})
test('measured geometry handles variable heights and bounds large list windows', () => {
  const keys = Array.from({ length: 10000 }, (_, i) => String(i))
  const sizes = new Map(keys.map((key, index) => [key, index % 2 ? 520 : 120]))
  const offsets = measuredOffsets(keys, sizes)
  assert.deepEqual(offsets.slice(0, 4), [0, 120, 640, 760])
  for (const top of [0, 120, 100000, offsets.at(-1)! - 700]) {
    const range = measuredRange(offsets, top, 700)
    assert.ok(range.end - range.start < 15)
    assert.ok(offsets[range.start]! <= top)
    assert.ok(offsets[range.end]! >= Math.min(offsets.at(-1)!, top + 700))
  }
  assert.deepEqual(measuredRange([0], 0, 700), { start: 0, end: 0 })
})
