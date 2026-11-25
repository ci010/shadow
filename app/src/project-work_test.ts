import assert from 'node:assert/strict'
import test from 'node:test'
import { projectWorkOverviewSchema, type ProjectWorkItem } from '../../src/projects/work-overview.ts'
import { activeWorkOverview, filterWork, groupWork, workNeedingReassessment, workCanvasRows, workGraph, workPath, workRoots } from './project-work.ts'

const item = (key: string, extra: Partial<ProjectWorkItem> = {}): ProjectWorkItem => ({
  key, title: key, revision: 1, sequence: 1, status: 'pending', parentKey: null, dependencies: [],
  manager: 'web:manager', assignee: null, kind: 'task', summary: '', artifacts: [], basis: [], changedAt: new Date().toISOString(), ...extra,
  blockedReason: extra.blockedReason ?? null,
})
const items = [
  item('work:160bec09-e455-5d33-a661-3b95f7c3879b'), item('work:50cac148-f7fb-5ff3-a278-79e9bc635d4c', { parentKey: 'work:160bec09-e455-5d33-a661-3b95f7c3879b', assignee: 'web:one', status: 'in_progress' }),
  item('work:9869a783-d084-5bab-a5fc-a5db8a242904', { parentKey: 'work:160bec09-e455-5d33-a661-3b95f7c3879b', dependencies: ['work:50cac148-f7fb-5ff3-a278-79e9bc635d4c'], status: 'blocked' }),
  item('work:9681e4dd-a695-591e-9435-188bd414677a', { parentKey: 'work:9869a783-d084-5bab-a5fc-a5db8a242904', status: 'done' }), item('work:1f4b8872-6e28-55e1-9cb8-e259508f8d8b'),
]
test('board filters preserve unassigned work, recursive Work membership and the authoritative progress', () => {
  assert.equal(workRoots(items).get('work:9681e4dd-a695-591e-9435-188bd414677a'), 'work:160bec09-e455-5d33-a661-3b95f7c3879b')
  assert.deepEqual(filterWork(items, { query: '', root: 'work:160bec09-e455-5d33-a661-3b95f7c3879b', assignee: '', terminal: false }).map(item => item.key), ['work:160bec09-e455-5d33-a661-3b95f7c3879b', 'work:50cac148-f7fb-5ff3-a278-79e9bc635d4c', 'work:9869a783-d084-5bab-a5fc-a5db8a242904'])
  assert.deepEqual(filterWork(items, { query: '', root: '', assignee: 'web:one', terminal: true }).map(item => item.key), ['work:50cac148-f7fb-5ff3-a278-79e9bc635d4c'])
  assert.deepEqual(filterWork(items, { query: '', root: '', assignee: 'unassigned', terminal: true }).map(item => item.key), ['work:160bec09-e455-5d33-a661-3b95f7c3879b', 'work:9869a783-d084-5bab-a5fc-a5db8a242904', 'work:9681e4dd-a695-591e-9435-188bd414677a', 'work:1f4b8872-6e28-55e1-9cb8-e259508f8d8b'])
  const groups = groupWork(items.slice(1), items)
  assert.deepEqual(groups.map(group => group.title), ['work:160bec09-e455-5d33-a661-3b95f7c3879b', 'Independent work'])
  assert.equal(groups[0].items.length, 3)
  assert.equal(items[1].status, 'in_progress', 'A session activity change never determines work progress')
})
test('graph separates parent and dependency edges and reports links outside a filtered view', () => {
  const graph = workGraph(items)
  assert.equal(graph.edges.filter(edge => edge.kind === 'child').length, 3)
  assert.deepEqual(graph.edges.filter(edge => edge.kind === 'dependency').map(edge => [edge.from, edge.to]), [['work:50cac148-f7fb-5ff3-a278-79e9bc635d4c', 'work:9869a783-d084-5bab-a5fc-a5db8a242904']])
  assert.equal(graph.edges.find(edge => edge.kind === 'dependency')?.path, 'M 590 92 C 622 92, 622 272, 590 272')
  assert.equal(graph.outside, 0)
  assert.equal(workGraph([items[2]]).outside, 2)
  assert.equal(new Set(graph.nodes.map(node => `${node.x}:${node.y}`)).size, items.length)
  assert.throws(() => workRoots([item('work:2f690ad9-8bf8-5406-b130-17da5a24f43d', { parentKey: 'work:73411762-aa52-57b4-8117-2d1b9ada77bb' }), item('work:73411762-aa52-57b4-8117-2d1b9ada77bb', { parentKey: 'work:2f690ad9-8bf8-5406-b130-17da5a24f43d' })]), /cycle/)
})
test('invalid wire progress fails explicitly and stale ancestry stays separate from status', () => {
  const data = { items: [
    item('work:121b94ac-d3d4-5e9c-a183-2a941f1499e2', { contextChanged: true }),
    item('work:0b3d9b10-9860-54cf-9c14-5304bf7b9696', { contextAssessment: 'The grader is not necessary', contextChanged: false }),
    item('work:e60dc554-4ed1-5e03-aedb-5308fb88c621'),
  ], sessions: [], requests: [], effects: [] }
  assert.deepEqual(workNeedingReassessment(projectWorkOverviewSchema.parse(data)).map(item => item.key), ['work:121b94ac-d3d4-5e9c-a183-2a941f1499e2'])
  assert.equal(data.items[0].status, 'pending')
  assert.equal(projectWorkOverviewSchema.safeParse({ ...data, items: [item('work:e9a650b1-e3a7-5685-b0f8-83c76f5c219a', { status: 'working' as 'pending' })] }).success, false)
  assert.equal(projectWorkOverviewSchema.safeParse({ ...data, items: [item('work:2f690ad9-8bf8-5406-b130-17da5a24f43d'), item('work:2f690ad9-8bf8-5406-b130-17da5a24f43d')] }).success, false)
  assert.equal(projectWorkOverviewSchema.safeParse({ ...data, items: [item('work:2f690ad9-8bf8-5406-b130-17da5a24f43d', { parentKey: 'work:73411762-aa52-57b4-8117-2d1b9ada77bb' }), item('work:73411762-aa52-57b4-8117-2d1b9ada77bb', { parentKey: 'work:2f690ad9-8bf8-5406-b130-17da5a24f43d' })] }).success, false)
})

test('the canvas keeps causal ancestors for filtered descendants and preserves explicit collapsed branches', () => {
  const rows = workCanvasRows(items, new Set(['work:9681e4dd-a695-591e-9435-188bd414677a']), new Set(['work:160bec09-e455-5d33-a661-3b95f7c3879b', 'work:9869a783-d084-5bab-a5fc-a5db8a242904']))
  assert.deepEqual(rows.map(row => [row.item.key, row.depth, row.contextOnly]), [['work:160bec09-e455-5d33-a661-3b95f7c3879b', 0, true], ['work:9869a783-d084-5bab-a5fc-a5db8a242904', 1, true], ['work:9681e4dd-a695-591e-9435-188bd414677a', 2, false]])
  assert.deepEqual(workPath(items, 'work:9681e4dd-a695-591e-9435-188bd414677a').map(item => item.key), ['work:160bec09-e455-5d33-a661-3b95f7c3879b', 'work:9869a783-d084-5bab-a5fc-a5db8a242904', 'work:9681e4dd-a695-591e-9435-188bd414677a'])
  assert.deepEqual(workCanvasRows(items, new Set(['work:9681e4dd-a695-591e-9435-188bd414677a']), new Set(['work:160bec09-e455-5d33-a661-3b95f7c3879b'])).map(row => row.item.key), ['work:160bec09-e455-5d33-a661-3b95f7c3879b', 'work:9869a783-d084-5bab-a5fc-a5db8a242904'])
  const changed = items.map(item => ({ ...item, sequence: item.sequence + 1 }))
  assert.deepEqual(workCanvasRows(changed, new Set(['work:9681e4dd-a695-591e-9435-188bd414677a']), new Set(['work:160bec09-e455-5d33-a661-3b95f7c3879b'])).map(row => row.item.key), ['work:160bec09-e455-5d33-a661-3b95f7c3879b', 'work:9869a783-d084-5bab-a5fc-a5db8a242904'])
  assert.deepEqual(workCanvasRows([item('work:457b4e0e-0371-5d86-988f-12faedcfc130', { parentKey: 'work:ce9d9ff7-bab8-5cd9-a057-996e763f7450' })], new Set(['work:457b4e0e-0371-5d86-988f-12faedcfc130']), new Set()).map(row => row.depth), [0])
  const cycle = [item('work:2f690ad9-8bf8-5406-b130-17da5a24f43d', { parentKey: 'work:73411762-aa52-57b4-8117-2d1b9ada77bb' }), item('work:73411762-aa52-57b4-8117-2d1b9ada77bb', { parentKey: 'work:2f690ad9-8bf8-5406-b130-17da5a24f43d' })]
  assert.throws(() => workCanvasRows(cycle, new Set(['work:2f690ad9-8bf8-5406-b130-17da5a24f43d']), new Set()), /cycle/)
  assert.throws(() => workPath(cycle, 'work:2f690ad9-8bf8-5406-b130-17da5a24f43d'), /cycle/)
})

test('current note search and reassessment do not turn execution state or reported completion into acceptance', () => {
  const reviewed = item('work:a7f087b0-6e08-5091-b40f-e6f5f6dbb5f5', { status: 'done', summary: 'Token usage collected', contextAssessment: 'Use token metrics' })
  assert.deepEqual(filterWork([reviewed], { query: 'token usage', root: '', assignee: '', terminal: true }), [reviewed])
  assert.deepEqual(workNeedingReassessment({ items: [reviewed], sessions: [{ sessionId: 'worker', title: 'Worker', assignable: false, activity: 'running' }], requests: [], effects: [] }), [])
  assert.equal(reviewed.status, 'done')
})

test('active overview hides finished roots and their exclusive sessions without mutating completion history', () => {
  const data = projectWorkOverviewSchema.parse({ items: [item('work:f6befc6d-eb72-52b2-a485-29fc0f2200f7', { status: 'done' }), item('work:8c8ff788-c562-5c9d-9f73-d137264beca0', { parentKey: 'work:f6befc6d-eb72-52b2-a485-29fc0f2200f7', status: 'done', summary: 'Measured throughput' }), item('work:3b173b5d-1ee9-5176-b187-ff26b031dc60')],
    sessions: [
      { sessionId: 'old', title: 'Old', assignable: true, workKeys: ['work:f6befc6d-eb72-52b2-a485-29fc0f2200f7', 'work:8c8ff788-c562-5c9d-9f73-d137264beca0'] },
      { sessionId: 'mixed', title: 'Mixed', assignable: true, workKeys: ['work:f6befc6d-eb72-52b2-a485-29fc0f2200f7', 'work:3b173b5d-1ee9-5176-b187-ff26b031dc60'] },
      { sessionId: 'free', title: 'Conversation', assignable: true },
    ], requests: [], effects: [] })
  const projected = activeWorkOverview(data)
  assert.deepEqual(projected.items.map(item => item.key), ['work:3b173b5d-1ee9-5176-b187-ff26b031dc60'])
  assert.deepEqual(projected.sessions.map(item => item.sessionId), ['mixed', 'free'])
  assert.equal(data.items.length, 3)
  assert.deepEqual(filterWork(data.items, { query: 'throughput', root: 'work:f6befc6d-eb72-52b2-a485-29fc0f2200f7', assignee: '', terminal: true }).map(item => item.key), ['work:8c8ff788-c562-5c9d-9f73-d137264beca0'])
})

test('active projection prunes completed-only organized groups and remaps hierarchy, preserving the saved snapshot', () => {
  const data = projectWorkOverviewSchema.parse({ items: [item('work:8bf348e2-e058-5a41-a76a-144ef0eaf0f0', { status: 'done' }), item('work:000ade64-6965-5b0f-af11-77c1af6afddb')], sessions: [], requests: [], effects: [],
    focus: { inferredAt: '2026-01-01T00:00:00Z', origin: 'model_interpretation', inputCount: 2, omittedCount: 0,
      sources: [{ key: 'work:8bf348e2-e058-5a41-a76a-144ef0eaf0f0', sequence: 1 }, { key: 'work:000ade64-6965-5b0f-af11-77c1af6afddb', sequence: 1 }],
      result: { groups: ['work:8bf348e2-e058-5a41-a76a-144ef0eaf0f0', 'work:000ade64-6965-5b0f-af11-77c1af6afddb'].map(key => ({ category: key === 'work:000ade64-6965-5b0f-af11-77c1af6afddb' ? 'active' : 'done', purpose: key, motivation: key, topicKeys: [key] })),
        hierarchy: [{ id: 'old', title: 'Old', purpose: 'Old', groupIndexes: [0] }, { id: 'work:3b173b5d-1ee9-5176-b187-ff26b031dc60', title: 'Current', purpose: 'Current', groupIndexes: [1] }] } } })
  const projection = activeWorkOverview(data)
  assert.equal(projectWorkOverviewSchema.safeParse(projection).success, true)
  assert.deepEqual(projection.focus?.result.groups.map(group => group.category), ['active'])
  assert.deepEqual(projection.focus?.result.hierarchy?.map(node => node.groupIndexes), [[0]])
  assert.equal(data.focus?.result.groups.length, 2)
})

test('a completed overall Work no longer owns an active group even if an old child remains pending', () => {
  const history = [item('work:f6befc6d-eb72-52b2-a485-29fc0f2200f7', { status: 'done' }), item('work:fc9947f6-b956-5827-ad31-9d79a01cc13a', { parentKey: 'work:f6befc6d-eb72-52b2-a485-29fc0f2200f7' }), item('work:3b173b5d-1ee9-5176-b187-ff26b031dc60')]
  assert.deepEqual(filterWork(history, { query: '', root: '', assignee: '', terminal: false }).map(item => item.key), ['work:3b173b5d-1ee9-5176-b187-ff26b031dc60'])
  assert.equal(filterWork(history, { query: '', root: '', assignee: '', terminal: true }).length, 3)
})
