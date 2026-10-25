import assert from 'node:assert/strict'
import test from 'node:test'
import { projectWorkOverviewSchema, type ProjectWorkItem } from '../../src/projects/work-overview.ts'
import { filterWork, groupWork, workAttention, workCanvasRows, workGraph, workPath, workRoots } from './project-work.ts'
import { workNotesSchema } from '../../src/initiatives/work-notes.ts'

const item = (key: string, extra: Partial<ProjectWorkItem> = {}): ProjectWorkItem => ({
  key, title: key, revision: 1, sequence: 1, status: 'pending', parentKey: null, dependencies: [],
  manager: 'web:manager', assignee: null, paused: false, adopted: false, proposals: 0,
  interpretationReview: false, changedAt: new Date().toISOString(), ...extra,
  blockedReason: extra.blockedReason ?? null,
})
const items = [
  item('root'), item('first', { parentKey: 'root', assignee: 'web:one', status: 'in_progress' }),
  item('second', { parentKey: 'root', dependencies: ['first'], status: 'blocked' }),
  item('third', { parentKey: 'second', status: 'done' }), item('independent'),
]
test('board filters preserve unassigned work, recursive Initiative membership and the authoritative progress', () => {
  assert.equal(workRoots(items).get('third'), 'root')
  assert.deepEqual(filterWork(items, { query: '', root: 'root', assignee: '', terminal: false }).map(item => item.key), ['root', 'first', 'second'])
  assert.deepEqual(filterWork(items, { query: '', root: '', assignee: 'web:one', terminal: true }).map(item => item.key), ['first'])
  assert.deepEqual(filterWork(items, { query: '', root: '', assignee: 'unassigned', terminal: true }).map(item => item.key), ['root', 'second', 'third', 'independent'])
  const groups = groupWork(items.slice(1), items)
  assert.deepEqual(groups.map(group => group.title), ['root', 'Independent work'])
  assert.equal(groups[0].items.length, 3)
  assert.equal(items[1].status, 'in_progress', 'A session activity change never determines work progress')
})
test('graph separates parent and dependency edges and reports links outside a filtered view', () => {
  const graph = workGraph(items)
  assert.equal(graph.edges.filter(edge => edge.kind === 'child').length, 3)
  assert.deepEqual(graph.edges.filter(edge => edge.kind === 'dependency').map(edge => [edge.from, edge.to]), [['first', 'second']])
  assert.equal(graph.edges.find(edge => edge.kind === 'dependency')?.path, 'M 590 92 C 622 92, 622 272, 590 272')
  assert.equal(graph.outside, 0)
  assert.equal(workGraph([items[2]]).outside, 2)
  assert.equal(new Set(graph.nodes.map(node => `${node.x}:${node.y}`)).size, items.length)
  assert.throws(() => workRoots([item('a', { parentKey: 'b' }), item('b', { parentKey: 'a' })]), /cycle/)
})
test('invalid wire progress fails explicitly and attention stays separate from status', () => {
  const data = { items: [
    item('review', { contextChanged: true }),
    item('clarify', { notes: workNotesSchema.parse({ attention: { kind: 'assumption', summary: 'The grader may not be necessary', version: 1, by: 'worker', at: new Date().toISOString() } }) }),
    item('old-proposal', { proposals: 1, interpretationReview: true }),
  ], sessions: [], requests: [], effects: [] }
  assert.deepEqual(workAttention(projectWorkOverviewSchema.parse(data)).map(item => item.key), ['review', 'clarify'])
  assert.equal(data.items[0].status, 'pending')
  assert.equal(projectWorkOverviewSchema.safeParse({ ...data, items: [item('bad', { status: 'working' as 'pending' })] }).success, false)
  assert.equal(projectWorkOverviewSchema.safeParse({ ...data, items: [item('a'), item('a')] }).success, false)
  assert.equal(projectWorkOverviewSchema.safeParse({ ...data, items: [item('a', { parentKey: 'b' }), item('b', { parentKey: 'a' })] }).success, false)
})

test('the canvas keeps causal ancestors for filtered descendants and preserves explicit collapsed branches', () => {
  const rows = workCanvasRows(items, new Set(['third']), new Set(['root', 'second']))
  assert.deepEqual(rows.map(row => [row.item.key, row.depth, row.contextOnly]), [['root', 0, true], ['second', 1, true], ['third', 2, false]])
  assert.deepEqual(workPath(items, 'third').map(item => item.key), ['root', 'second', 'third'])
  assert.deepEqual(workCanvasRows(items, new Set(['third']), new Set(['root'])).map(row => row.item.key), ['root', 'second'])
  const changed = items.map(item => ({ ...item, sequence: item.sequence + 1 }))
  assert.deepEqual(workCanvasRows(changed, new Set(['third']), new Set(['root'])).map(row => row.item.key), ['root', 'second'])
  assert.deepEqual(workCanvasRows([item('orphan', { parentKey: 'missing' })], new Set(['orphan']), new Set()).map(row => row.depth), [0])
  const cycle = [item('a', { parentKey: 'b' }), item('b', { parentKey: 'a' })]
  assert.throws(() => workCanvasRows(cycle, new Set(['a']), new Set()), /cycle/)
  assert.throws(() => workPath(cycle, 'a'), /cycle/)
})

test('current note search and attention do not turn execution state or reported completion into acceptance', () => {
  const at = new Date().toISOString()
  const reviewed = item('reviewed', { status: 'done', notes: workNotesSchema.parse({
    summary: 'Token usage collected', attention: { kind: 'dependency', summary: 'Missing grader', version: 1, by: 'worker', at,
      reviewed: { by: 'admin', at, conclusion: 'Use token metrics' } },
  }) })
  assert.deepEqual(filterWork([reviewed], { query: 'token usage', root: '', assignee: '', terminal: true }), [reviewed])
  assert.deepEqual(workAttention({ items: [reviewed], sessions: [{ sessionId: 'worker', title: 'Worker', assignable: false, activity: 'running' }], requests: [], effects: [] }), [])
  assert.equal(reviewed.status, 'done')
})
