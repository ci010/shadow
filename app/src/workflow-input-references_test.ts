import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addInputReference, captureInputReferences, removeSentInputReferences, workflowInputReference } from './workflow-input-references.ts'
import { workflowGraph, type WorkflowDefinition, type WorkflowRun } from './workflows.ts'

const definition: WorkflowDefinition = { id: 'flow', revision: 3, enabled: true, source: { kind: 'internal', id: 'signal' }, gate: { kind: 'revision', first: 'baseline' }, nodes: [{ kind: 'transform' }, { kind: 'record' }] }
test('reference selectors match the actual source, optional gate and zero-based action projection', () => {
  const graph = workflowGraph(definition)
  assert.deepEqual(graph.map(n => workflowInputReference('p', definition, n.id)?.reference.selector), [
    { kind: 'source' }, { kind: 'gate' }, { kind: 'node', index: 0, nodeKind: 'transform' }, { kind: 'node', index: 1, nodeKind: 'record' },
  ])
  assert.equal(workflowInputReference('p', { ...definition, gate: undefined }, 'gate'), undefined)
  assert.equal(workflowInputReference('p', definition, 'node-2'), undefined)
  assert.equal(workflowInputReference('p', definition, 'bot:source'), undefined)
  assert.equal(workflowInputReference('p', { ...definition, nodes: [{ kind: 'bot' }] }, 'node-0'), undefined)
})
test('historical references retain snapshot revision and run identity', () => {
  const run: WorkflowRun = { id: 'old', workflow: 'flow', definition, timestamp: '', status: 'completed', cursor: 2, attempts: 1, nextAt: 0, started: true }
  assert.deepEqual(workflowInputReference('p', definition, undefined, run)?.reference, { kind: 'workflow', projectId: 'p', workflowId: 'flow', revision: 3, runId: 'old' })
  assert.equal(workflowInputReference('p', { ...definition, revision: 4 }, undefined, run), undefined)
})
test('deduplicate, bound, capture wire-only references, and clear only admitted references', () => {
  const item = workflowInputReference('p', definition)!
  const added = addInputReference([], item)
  assert.equal(added.result, 'added')
  assert.equal(addInputReference(added.items, item).result, 'duplicate')
  const many = Array.from({ length: 8 }, (_, revision) => workflowInputReference('p', { ...definition, revision: revision + 1 })!)
  assert.equal(addInputReference(many, workflowInputReference('p', { ...definition, revision: 9 })!).result, 'limit')
  const captured = captureInputReferences(added.items)
  item.reference.revision = 8
  assert.equal(captured[0]!.revision, 3)
  assert.equal('label' in captured[0]!, false)
  const later = workflowInputReference('p', definition, 'source')!
  assert.deepEqual(removeSentInputReferences([...added.items, later], captured), [later])
  assert.deepEqual(captureInputReferences([]), [])
})

test('deduplication ignores selector field ordering while distinct revisions/runs stay distinct', () => {
  const item = workflowInputReference('p', definition, 'node-1')!
  const reordered = { ...item, reference: { ...item.reference, selector: { nodeKind: 'record', index: 1, kind: 'node' } as const } }
  assert.equal(addInputReference([item], reordered).result, 'duplicate')
  assert.equal(addInputReference([item], { ...item, reference: { ...item.reference, runId: 'old' } }).result, 'added')
  assert.equal(addInputReference([item], { ...item, reference: { ...item.reference, revision: 4 } }).result, 'added')
})
