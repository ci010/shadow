import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { overviewGraph, overviewLayout } from './project-overview-graph.ts'
import { organizationDiagnostic, organizationErrorMessage } from './organization-error.ts'
import { projectWorkOverviewSchema } from '../../src/projects/work-overview.ts'
import type { YieldDecisionRecord } from '../../src/sessions/yield-contract.ts'
const rootKey = 'work:160bec09-e455-5d33-a661-3b95f7c3879b'
const planKey = 'work:ba6d7aa7-fc44-570e-9ce7-854bb21e9cdb'
const otherKey = 'work:aac83d5f-626c-5df6-9a7d-8d18b62f6cf6'
const childKey = 'work:8c8ff788-c562-5c9d-9f73-d137264beca0'
const nestedKey = 'work:80c34e9a-0cce-517c-8191-c57bcad0d3f6'
const wideKey = 'work:89a3c8b5-1155-5d89-9e7c-0d13214b2c95'
const narrowKey = 'work:d07a8d6f-e087-56f5-a12a-85f5cdfbe4ae'
const aKey = 'work:2f690ad9-8bf8-5406-b130-17da5a24f43d'
const bKey = 'work:73411762-aa52-57b4-8117-2d1b9ada77bb'
const cKey = 'work:18949470-b138-5e49-a3c3-1e7b7fc8f757'
const deep1Key = 'work:344a6c39-d80c-5322-bbe7-33271044de59'
const deep2Key = 'work:8b34b360-c241-5c30-bba5-9877b8dbe00b'
const tipKey = 'work:5fbaea6f-464c-5c81-baa5-15a59ed88d93'
const otherChildKey = 'work:f5c12f3c-af9d-59d8-b0d9-4f0225773156'

const item = { key: rootKey, title: 'Release', revision: 2, sequence: 2, status: 'done', parentKey: null, dependencies: [], blockedReason: null, manager: null, assignee: null, changedAt: '2026-10-10T00:00:00Z', kind: 'goal', summary: 'Reported delivery' }
test('one graph distinguishes hierarchy, dependencies, time, references without retired proposal influence', () => {
  const data = projectWorkOverviewSchema.parse({ items: [item, { ...item, key: planKey, title: 'Approach', parentKey: rootKey, dependencies: [rootKey], changedAt: '2026-10-11T00:00:00Z', kind: 'approach' }], sessions: [], requests: [], effects: [] })
  const record = { request: { id: 'd', sessionId: 's', question: 'Change approach?', createdAt: '2026-10-10T12:00:00Z', origin: { physicalId: 'p' }, sources: [{ sessionId: 's', physicalId: 'p', requestId: 'old' }], reconsiders: { sessionId: 's', physicalId: 'p', requestId: 'old' } }, answer: { answeredBy: 'user', option: 'Change approach', answeredAt: '2026-10-10T13:00:00Z' } } as YieldDecisionRecord
  const graph = overviewGraph(data, [record])
  for (const kind of ['hierarchy', 'dependency', 'precedence', 'reference', 'reconsiders']) assert(graph.edges.some(edge => edge.kind === kind), kind)
  assert(graph.nodes.some(node => node.kind === 'approach'))
  assert(graph.nodes.some(node => node.kind === 'result' && node.authority === 'reported'))
  assert(graph.nodes.some(node => node.kind === 'unavailable'))
  assert.equal(graph.edges.filter(edge => edge.kind === 'causal').length, 0)
  assert(graph.edges.filter(edge => edge.kind === 'precedence').every(edge => edge.evidence.includes('not causal')))
})
test('UI failure diagnostics retain bounded safe codes and never raw server messages', () => {
  const detail = organizationDiagnostic({ error: 'invalid_request', stage: 'validation', correlationId: 'abc-123', message: 'SECRET', extra: 'SECRET' }, 400)
  assert(detail.includes('abc-123')); assert(detail.includes('validation')); assert(!detail.includes('SECRET'))
  assert(!organizationDiagnostic({ correlationId: 'secret\nunsafe' }, 502).includes('secret'))
  assert.notEqual(organizationErrorMessage('organization_network_failed'), organizationErrorMessage(undefined))
})
test('organization HTTP 404, including non-JSON HTML, is distinct from model failures', () => {
  const missing = organizationErrorMessage(undefined, 404) // HTML response cannot supply a machine code.
  assert.match(missing, /interface was not found/)
  assert.equal(organizationErrorMessage('not_found'), missing)
  assert.equal(organizationErrorMessage('organization_failed', 404), missing)
  assert.match(organizationErrorMessage('project_not_found', 404), /Project was not found/)
  for (const code of ['model_json_invalid', 'model_schema_invalid', 'organization_cancelled', 'organization_failed']) {
    assert.notEqual(organizationErrorMessage(code, 502), missing)
  }
  assert.match(organizationErrorMessage('model_json_invalid', 502), /invalid JSON/)
  assert.equal(organizationDiagnostic('<html>SECRET</html>', 404), ' [HTTP 404]')
})
test('Board no longer mounts the topic graph or dispatches topic organization', async () => {
  const source = await readFile(new URL('./components/ProjectWorkbench.vue', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /ProjectOverviewGraph|organizeTopics|work\/organize/)
})

test('ownership disclosure starts at horizontal roots and independently expands downward', () => {
  const data = projectWorkOverviewSchema.parse({ items: [item,
    { ...item, key: otherKey, title: 'Other root',  },
    { ...item, key: childKey, parentKey: rootKey, dependencies: [otherKey],  },
    { ...item, key: nestedKey, parentKey: childKey,  }], sessions: [], requests: [], effects: [] })
  const graph = overviewGraph(data)
  assert.deepEqual(overviewLayout(graph, new Set()).nodes.map(node => node.id), ['display-group:unclassified']);
  const initial = overviewLayout(graph, new Set(['display-group:unclassified']))
  assert.deepEqual(initial.nodes.map(node => node.id), ['display-group:unclassified', rootKey, otherKey])
  assert.equal(initial.positions.get(rootKey)?.y, initial.positions.get(otherKey)?.y)
  assert.notEqual(initial.positions.get(rootKey)?.x, initial.positions.get(otherKey)?.x)
  assert.equal(initial.edges.length, 0) // hidden internal links do not leak source roots
  const open = overviewLayout(graph, new Set(['display-group:unclassified', rootKey]))
  assert(open.nodes.some(node => node.id === `report:${rootKey}`))
  assert(open.nodes.some(node => node.id === childKey))
  assert(!open.nodes.some(node => node.id === nestedKey))
  assert(open.edges.some(edge => edge.kind === 'dependency'))
  assert(open.regions.some(region => region.owner === rootKey))
  assert.equal(open.positions.get(`report:${rootKey}`)!.y, open.positions.get(childKey)!.y)
  assert(open.positions.get(childKey)!.y > open.positions.get(rootKey)!.y)
  const nested = overviewLayout(graph, new Set(['display-group:unclassified', rootKey, childKey]))
  assert(nested.nodes.some(node => node.id === nestedKey))
  assert(nested.positions.get(nestedKey)!.y > nested.positions.get(childKey)!.y)
  assert.deepEqual(overviewLayout(graph, new Set(['display-group:unclassified', childKey])).nodes.map(node => node.id), ['display-group:unclassified', rootKey, otherKey])
  for (const view of [initial, open, nested]) for (const edge of view.edges) {
    assert(view.positions.has(edge.source) || view.regions.some(r => r.id === edge.source)); assert(view.positions.has(edge.target) || view.regions.some(r => r.id === edge.target))
  }
})
test('decisions belong to deepest recorded owner; cross references do not open branches', () => {
  const data = projectWorkOverviewSchema.parse({ items: [item, { ...item, key: childKey, parentKey: rootKey,  }], sessions: [], requests: [], effects: [] })
  const record = { request: { id: 'd', sessionId: 's', question: 'Choose?', createdAt: item.changedAt, origin: { physicalId: 'p' }, workContext: { path: [{ key: rootKey }, { key: childKey }] }, sources: [{ sessionId: 's', physicalId: 'p', requestId: 'missing' }] } } as YieldDecisionRecord
  const graph = overviewGraph(data, [record])
  assert.equal(graph.nodes.find(node => node.kind === 'question')?.parentId, childKey)
  assert(!overviewLayout(graph, new Set(['display-group:unclassified', rootKey])).nodes.some(node => node.kind === 'question'))
  const open = overviewLayout(graph, new Set(['display-group:unclassified', rootKey, childKey]))
  assert(open.nodes.some(node => node.kind === 'question'))
  assert(!open.nodes.some(node => node.kind === 'unavailable'))
  assert(!open.edges.some(edge => edge.kind === 'reference'))
})


test('expanded siblings at every depth reserve their full unbalanced subtree width', () => {
  const ownership = [[rootKey, null], [wideKey, rootKey], [narrowKey, rootKey], [aKey, wideKey], [bKey, wideKey], [cKey, wideKey], [deep1Key, bKey], [deep2Key, bKey], [tipKey, narrowKey], [otherKey, null], [otherChildKey, otherKey]] as const
  const data = projectWorkOverviewSchema.parse({ items: ownership.map(([key, parentKey]) => ({ ...item, key, parentKey,  })), sessions: [], requests: [], effects: [] })
  const graph = overviewGraph(data)
  const view = overviewLayout(graph, new Set(['display-group:unclassified', rootKey, wideKey, bKey, narrowKey, otherKey]))
  const pos = (id: string) => view.positions.get(id)!
  for (const [id, parent] of ownership) if (parent) assert(pos(id).y > pos(parent).y)
  for (const node of view.nodes) for (const other of view.nodes) if (node.id !== other.id) {
    const a = pos(node.id), b = pos(other.id)
    assert(a.x + 280 <= b.x || b.x + 280 <= a.x || a.y + 112 <= b.y || b.y + 112 <= a.y)
  }
  assert.equal(view.edges.filter(edge => edge.kind === 'hierarchy').length, 0)
  const collapsed = overviewLayout(graph, new Set(['display-group:unclassified', rootKey]))
  assert(collapsed.width < view.width)
  assert.equal(collapsed.positions.get(wideKey)!.y, collapsed.positions.get(narrowKey)!.y)
  const filtered = overviewLayout(graph, new Set(['display-group:unclassified', rootKey, wideKey, bKey]), node => node.id === deep2Key)
  assert.deepEqual(filtered.nodes.map(node => node.id), ['display-group:unclassified', rootKey, wideKey, bKey, deep2Key])
  assert(filtered.regions.length === 4)
})
