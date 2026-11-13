import assert from 'node:assert/strict'
import test from 'node:test'
import { workflowCanvas } from './workflow-canvas.ts'
import type { WorkflowDefinition, WorkflowRun } from './workflows.ts'
const definition = (id: string): WorkflowDefinition => ({ id, name: id, revision: 2, enabled: true,
  source: { kind: 'schedule', id: 'daily' }, gate: { kind: 'revision-dedupe', first: 'emit' }, nodes: [{ kind: 'transform' }, { kind: 'record' }],
})
test('shared canvas scopes every node and edge to a separate non-editable workflow group', () => {
  const { nodes, edges } = workflowCanvas(['a', 'a:group', '["a","source"]'].map(id => ({ definition: definition(id) })))
  assert.equal(nodes.filter(node => node.type === 'group').length, 3)
  assert.equal(nodes.length, 15); assert.equal(edges.length, 9)
  assert.equal(new Set(nodes.map(node => node.id)).size, nodes.length)
  assert.equal(new Set(edges.map(edge => edge.id)).size, edges.length)
  for (const node of nodes) {
    assert.equal(node.draggable, false); assert.equal(node.connectable, false); assert.equal(node.deletable, false)
    if (node.type === 'group') continue
    const group = nodes.find(group => group.id === node.parentNode)!
    assert.equal(group.type, 'group'); assert.equal(group.data.definition.id, node.data.flowId)
  }
  for (const edge of edges) {
    const source = nodes.find(node => node.id === edge.source)!, target = nodes.find(node => node.id === edge.target)!
    assert.equal(source.parentNode, target.parentNode); assert.equal(source.data.flowId, target.data.flowId)
    assert.equal(edge.deletable, false)
  }
  assert.deepEqual(nodes.filter(node => node.type === 'group').map(node => node.position.y), [0, 220, 440])
})
test('canvas uses recorded node states; enabled does not imply running or animation', () => {
  const flow = definition('schedule:daily')
  const run: WorkflowRun = { id: 'run', workflow: flow.id, definition: flow, timestamp: '2026-11-12T10:00:00Z', status: 'blocked', cursor: 1, attempts: 1, nextAt: 0, started: true }
  const before = JSON.stringify({ flow, run })
  const result = workflowCanvas([{ definition: flow, run }])
  assert.deepEqual(result.nodes.filter(node => node.type === 'workflow').map(node => node.data.status), ['received', 'accepted', 'completed', 'blocked'])
  assert.equal(result.nodes[0]!.data.definition.revision, 2)
  assert.ok(result.edges.every(edge => !edge.animated))
  assert.ok(workflowCanvas([{ definition: flow }]).edges.every(edge => !edge.animated))
  const paused = workflowCanvas([{ definition: { ...flow, enabled: false } }])
  assert.ok(paused.nodes.filter(node => node.type === 'workflow').every(node => !node.data.enabled))
  assert.ok(paused.edges.every(edge => (edge.style as Record<string, unknown>).strokeDasharray && !edge.animated))
  assert.ok(workflowCanvas([{ definition: flow, run: { ...run, status: 'running' } }]).edges.every(edge => edge.animated))
  assert.equal(JSON.stringify({ flow, run }), before)
  assert.deepEqual(workflowCanvas([]), { nodes: [], edges: [] })
})

test('schedule semantics use saved jobs: fixed targets, fresh sessions, maintenance and unknown metadata', async () => {
  const { workflowGraph } = await import('./workflows.ts')
  const { SESSION_CLEANUP_AUTOMATION } = await import('../../src/cron/defaults.ts')
  const flow = definition('schedule:test')
  const fixed = { ...flow, nodes: [{ kind: 'schedule-action', action: 'session', job: { schedule: '0 9 * * 1', timezone: 'Asia/Shanghai', target: { sessionId: 'web:old-target' }, session: 'existing' } }] }
  const graph = workflowGraph(fixed)
  assert.equal(graph[0]!.detail, '0 9 * * 1')
  assert.equal(graph[0]!.description, 'Timezone: Asia/Shanghai')
  assert.equal(graph[2]!.label, 'Deliver to existing session')
  assert.equal(graph[2]!.detail, 'web:old-target')
  const cleanup = workflowGraph({ ...flow, nodes: [{ kind: 'schedule-action', action: 'agent', job: SESSION_CLEANUP_AUTOMATION }] })
  assert.equal(cleanup[0]!.detail, '0 3 * * *')
  assert.equal(cleanup[0]!.description, 'Timezone not recorded')
  assert.equal(cleanup[2]!.label, 'New Agent session')
  assert.match(cleanup[2]!.detail, /Fresh session each run/)
  assert.match(cleanup[2]!.description!, /Perform recoverable session cleanup/)
  const host = workflowGraph({ ...flow, source: { kind: 'internal', id: 'maintenance' }, nodes: [{ kind: 'host-action', handler: 'maintenance-handler', replay: 'safe' }] })
  assert.equal(host[2]!.label, 'Host action'); assert.equal(host[2]!.detail, 'maintenance-handler')
  const unknown = workflowGraph({ ...flow, name: 'Fresh Session cleanup', nodes: [{ kind: 'schedule-action', job: {} }] })
  assert.equal(unknown[0]!.detail, 'Schedule not recorded'); assert.equal(unknown[2]!.detail, 'Session policy not recorded')
  // A later target edit must not rewrite the admitted definition's target.
  const current = { ...fixed, revision: 3, nodes: [{ kind: 'schedule-action', action: 'session', job: { schedule: 'every 2h', target: { sessionId: 'web:new-target' } } }] }
  assert.equal(workflowGraph(current)[2]!.detail, 'web:new-target')
  assert.equal(workflowGraph(fixed)[2]!.detail, 'web:old-target')
})

test('canvas reflects optional leading deduplication from the definition, not a source-kind display exception', async () => {
  const { parseWorkflowDefinition, workflowGraph } = await import('./workflows.ts')
  const { gate: _gate, ...plain } = definition('schedule:no-gate')
  assert.equal(parseWorkflowDefinition(plain).gate, undefined)
  assert.throws(() => parseWorkflowDefinition({ ...plain, gate: null }), /invalid/)
  assert.deepEqual(workflowGraph(plain).map(node => node.id), ['source', 'node-0', 'node-1'])
  assert.deepEqual(workflowGraph({ ...plain, source: { kind: 'external', id: 'feed' } }).map(node => node.id), ['source', 'node-0', 'node-1'])
  const historic = definition('schedule:no-gate')
  assert.deepEqual(workflowGraph(historic).map(node => node.id), ['source', 'gate', 'node-0', 'node-1'])
  assert.equal(workflowCanvas([{ definition: plain }]).edges.length, 2)
  assert.equal(workflowCanvas([{ definition: historic }]).edges.length, 3)
})
