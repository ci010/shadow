import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { overviewGraph, overviewLayout } from './project-overview-graph.ts'
import { organizationDiagnostic, organizationErrorMessage } from './organization-error.ts'
import { projectWorkOverviewSchema } from '../../src/projects/work-overview.ts'
import type { YieldDecisionRecord } from '../../src/sessions/yield-contract.ts'
const item = { key: 'root', title: 'Release', revision: 2, sequence: 2, status: 'done', parentKey: null, dependencies: [], blockedReason: null, manager: null, assignee: null, paused: false, adopted: false, proposals: 0, interpretationReview: false, changedAt: '2026-10-10T00:00:00Z', notes: { kind: 'goal', summary: 'Reported delivery' } }
test('one graph distinguishes hierarchy, dependencies, time, references and evidenced applied influence', () => {
  const data = projectWorkOverviewSchema.parse({ items: [item, { ...item, key: 'plan', title: 'Approach', parentKey: 'root', dependencies: ['root'], changedAt: '2026-10-11T00:00:00Z', notes: { kind: 'approach' }, decisionInfluences: [{ reason: 'Changed acceptance after decision', baseRevision: 1, appliedRevision: 2, request: { sessionId: 's', physicalId: 'p', requestId: 'd' } }] }], sessions: [], requests: [], effects: [] })
  const record = { request: { id: 'd', sessionId: 's', question: 'Change approach?', createdAt: '2026-10-10T12:00:00Z', origin: { physicalId: 'p' }, sources: [{ sessionId: 's', physicalId: 'p', requestId: 'old' }], reconsiders: { sessionId: 's', physicalId: 'p', requestId: 'old' } }, answer: { answeredBy: 'user', option: 'Change approach', answeredAt: '2026-10-10T13:00:00Z' } } as YieldDecisionRecord
  const graph = overviewGraph(data, [record])
  for (const kind of ['hierarchy', 'dependency', 'precedence', 'reference', 'reconsiders', 'causal']) assert(graph.edges.some(edge => edge.kind === kind), kind)
  assert(graph.nodes.some(node => node.kind === 'approach'))
  assert(graph.nodes.some(node => node.kind === 'result' && node.authority === 'reported'))
  assert(graph.nodes.some(node => node.kind === 'unavailable'))
  assert.equal(graph.edges.filter(edge => edge.kind === 'causal').length, 1)
  assert.equal(overviewGraph({ ...data, items: data.items.map(item => ({ ...item, decisionInfluences: undefined })) }, [record]).edges.filter(edge => edge.kind === 'causal').length, 0)
  assert(graph.edges.filter(edge => edge.kind === 'precedence').every(edge => edge.evidence.includes('not causal')))
})
test('UI failure diagnostics retain bounded safe codes and never raw server messages', () => {
  const detail = organizationDiagnostic({ error: 'invalid_request', stage: 'validation', correlationId: 'abc-123', message: 'SECRET', extra: 'SECRET' }, 400)
  assert(detail.includes('abc-123')); assert(detail.includes('validation')); assert(!detail.includes('SECRET'))
  assert(!organizationDiagnostic({ correlationId: 'secret\nunsafe' }, 502).includes('secret'))
  assert.notEqual(organizationErrorMessage('organization_network_failed'), organizationErrorMessage(undefined))
})
test('overview integrates a single native graph, not legacy transplanted folds', async () => {
  const source = await readFile(new URL('./components/ProjectWorkbench.vue', import.meta.url), 'utf8')
  assert.equal((source.match(/<ProjectOverviewGraph /g) ?? []).length, 1)
  assert(!source.includes('<WorkGraph')); assert(!source.includes('<ProjectContextCanvas')); assert(!source.includes('<ProjectTopicHistory'))
  assert(!source.includes('organizing || data?.observer?.running'))
  assert(source.includes('projectWorkOverviewSchema.safeParse(await response.json())'))
})

test('ownership disclosure starts at horizontal roots and independently expands downward', () => {
  const data = projectWorkOverviewSchema.parse({ items: [item,
    { ...item, key: 'other', title: 'Other root', notes: {} },
    { ...item, key: 'child', parentKey: 'root', dependencies: ['other'], notes: {} },
    { ...item, key: 'nested', parentKey: 'child', notes: {} }], sessions: [], requests: [], effects: [] })
  const graph = overviewGraph(data)
  const initial = overviewLayout(graph, new Set())
  assert.deepEqual(initial.nodes.map(node => node.id), ['root', 'other'])
  assert.equal(initial.positions.get('root')?.y, initial.positions.get('other')?.y)
  assert.notEqual(initial.positions.get('root')?.x, initial.positions.get('other')?.x)
  assert.equal(initial.edges.length, 0)
  const open = overviewLayout(graph, new Set(['root']))
  assert(open.nodes.some(node => node.id === 'report:root'))
  assert(open.nodes.some(node => node.id === 'child'))
  assert(!open.nodes.some(node => node.id === 'nested'))
  assert(open.edges.some(edge => edge.kind === 'dependency'))
  assert.equal(open.positions.get('root')!.x, (open.positions.get('report:root')!.x + open.positions.get('child')!.x) / 2)
  assert.equal(open.positions.get('report:root')!.y, open.positions.get('child')!.y)
  assert(open.positions.get('child')!.y > open.positions.get('root')!.y)
  const nested = overviewLayout(graph, new Set(['root', 'child']))
  assert(nested.nodes.some(node => node.id === 'nested'))
  assert(nested.positions.get('nested')!.y > nested.positions.get('child')!.y)
  assert.deepEqual(overviewLayout(graph, new Set(['child'])).nodes.map(node => node.id), ['root', 'other'])
  for (const view of [initial, open, nested]) for (const edge of view.edges) {
    assert(view.positions.has(edge.from)); assert(view.positions.has(edge.to))
  }
})
test('decisions belong to deepest recorded owner; cross references do not open branches', () => {
  const data = projectWorkOverviewSchema.parse({ items: [item, { ...item, key: 'child', parentKey: 'root', notes: {} }], sessions: [], requests: [], effects: [] })
  const record = { request: { id: 'd', sessionId: 's', question: 'Choose?', createdAt: item.changedAt, origin: { physicalId: 'p' }, workContext: { path: [{ key: 'root' }, { key: 'child' }] }, sources: [{ sessionId: 's', physicalId: 'p', requestId: 'missing' }] } } as YieldDecisionRecord
  const graph = overviewGraph(data, [record])
  assert.equal(graph.nodes.find(node => node.kind === 'question')?.parentId, 'child')
  assert(!overviewLayout(graph, new Set(['root'])).nodes.some(node => node.kind === 'question'))
  const open = overviewLayout(graph, new Set(['root', 'child']))
  assert(open.nodes.some(node => node.kind === 'question'))
  assert(!open.nodes.some(node => node.kind === 'unavailable'))
  assert(!open.edges.some(edge => edge.kind === 'reference'))
})


test('expanded siblings at every depth reserve their full unbalanced subtree width', () => {
  const ownership = [['root', null], ['wide', 'root'], ['narrow', 'root'], ['a', 'wide'], ['b', 'wide'], ['c', 'wide'], ['deep1', 'b'], ['deep2', 'b'], ['tip', 'narrow'], ['other', null], ['otherChild', 'other']] as const
  const data = projectWorkOverviewSchema.parse({ items: ownership.map(([key, parentKey]) => ({ ...item, key, parentKey, notes: {} })), sessions: [], requests: [], effects: [] })
  const graph = overviewGraph(data)
  const view = overviewLayout(graph, new Set(['root', 'wide', 'b', 'narrow', 'other']))
  const pos = (id: string) => view.positions.get(id)!
  for (const siblings of [['root', 'other'], ['wide', 'narrow'], ['a', 'b', 'c'], ['deep1', 'deep2']]) {
    assert(siblings.every(id => pos(id).y === pos(siblings[0]!).y))
    for (let i = 1; i < siblings.length; i++) assert(pos(siblings[i]!).x >= pos(siblings[i - 1]!).x + 280 + 40)
  }
  for (const [id, parent] of ownership) if (parent) assert.equal(pos(id).y - pos(parent).y, 136)
  for (const node of view.nodes) {
    assert(pos(node.id).x >= 16)
    assert(pos(node.id).x + 280 <= view.width - 16)
    assert(pos(node.id).y + 112 <= view.height)
    for (const other of view.nodes) if (node.id !== other.id && pos(node.id).y === pos(other.id).y) assert(Math.abs(pos(node.id).x - pos(other.id).x) >= 320)
  }
  assert(pos('tip').x > pos('c').x + 280)
  assert(pos('otherChild').x > pos('tip').x + 280)
  assert.deepEqual(view.edges.filter(edge => edge.kind === 'hierarchy').map(edge => [edge.from, edge.to]), ownership.filter(([, parent]) => parent).map(([id, parent]) => [parent, id]))
  const collapsed = overviewLayout(graph, new Set(['root']))
  assert(collapsed.width < view.width)
  assert.equal(collapsed.positions.get('wide')!.y, collapsed.positions.get('narrow')!.y)
  const filtered = overviewLayout(graph, new Set(['root', 'wide', 'b']), node => node.id === 'deep2')
  assert.deepEqual(filtered.nodes.map(node => node.id), ['root', 'wide', 'b', 'deep2'])
  assert(filtered.nodes.every(node => filtered.positions.get(node.id)!.x === 16))
})
