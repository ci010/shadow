import assert from 'node:assert/strict'
import test from 'node:test'
import { overviewFlowEdges } from './project-overview-flow.ts'
import type { OverviewEdge } from './project-overview-graph.ts'
test('Vue Flow presentation preserves typed evidence, direction and non-editable edges', () => {
  const kinds: OverviewEdge['kind'][] = ['hierarchy', 'dependency', 'precedence', 'causal', 'reference', 'context', 'relation', 'reconsiders']
  const recorded = kinds.map(kind => ({ from: 'a', to: 'b', kind, evidence: `Recorded ${kind}` }))
  const edges = overviewFlowEdges(recorded, kind => kind)
  assert.equal(new Set(edges.map(edge => edge.id)).size, kinds.length)
  edges.forEach((edge, index) => { assert.equal(edge.source, 'a'); assert.equal(edge.target, 'b'); assert.equal(edge.data, recorded[index]); assert.equal(edge.deletable, false); assert.equal(edge.selectable, false) })
  assert.equal(edges[2]!.label, undefined)
  assert.equal(edges[3]!.label, 'causal')
  assert.equal(edges[4]!.label, undefined)
  assert.notDeepEqual(edges[2]!.style, edges[3]!.style)
})
