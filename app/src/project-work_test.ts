import assert from 'node:assert/strict'
import test from 'node:test'
import { projectWorkOverviewSchema, type ProjectWorkItem } from '../../src/projects/work-overview.ts'
import { filterWork, groupWork, workAttention, workGraph, workRoots } from './project-work.ts'

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
  const data = { items: [item('review', { proposals: 1 }), item('clarify', { interpretationReview: true })], sessions: [], requests: [], effects: [] }
  assert.deepEqual(workAttention(projectWorkOverviewSchema.parse(data)).map(item => item.key), ['review', 'clarify'])
  assert.equal(data.items[0].status, 'pending')
  assert.equal(projectWorkOverviewSchema.safeParse({ ...data, items: [item('bad', { status: 'working' as 'pending' })] }).success, false)
  assert.equal(projectWorkOverviewSchema.safeParse({ ...data, items: [item('a'), item('a')] }).success, false)
  assert.equal(projectWorkOverviewSchema.safeParse({ ...data, items: [item('a', { parentKey: 'b' }), item('b', { parentKey: 'a' })] }).success, false)
})
