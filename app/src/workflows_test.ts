import assert from 'node:assert/strict'
import test from 'node:test'
import { createWorkflowClient, parseWorkflows, recentWorkflowRuns, workflowGraph, workflowHint, type WorkflowDefinition, type WorkflowRun } from './workflows.ts'

const definition: WorkflowDefinition = { id: 'external:issues', name: 'Issue intake', revision: 2, enabled: true, source: { kind: 'external', id: 'issues' }, gate: { kind: 'revision-dedupe', first: 'baseline' }, nodes: [{ kind: 'record' }] }
const run: WorkflowRun = { id: 'run-only', workflow: definition.id, definition: { ...definition, revision: 1 }, timestamp: '2026-11-12T12:00:00Z', status: 'blocked', cursor: 0, attempts: 1, started: true, nextAt: 0, error: 'interrupted_effect' }
test('workflow view validates Project, identity, revisions and run cursor without inventing sessions', () => {
  const value = parseWorkflows({ projectId: 'fixture', definitions: [definition], runs: [run] }, 'fixture')
  assert.equal(value.runs[0]!.output?.sessionId, undefined)
  assert.equal(value.runs[0]!.definition.revision, 1)
  assert.throws(() => parseWorkflows(value, 'other'))
  assert.throws(() => parseWorkflows({ ...value, definitions: [definition, definition] }, 'fixture'))
  assert.throws(() => parseWorkflows({ ...value, runs: [{ ...run, cursor: 2 }] }, 'fixture'))
  assert.throws(() => parseWorkflows({ ...value, runs: [{ ...run, definition: { ...definition, id: 'other' } }] }, 'fixture'))
})
test('read-only graph models source, durable gate, ordered action status and historic snapshots', () => {
  assert.deepEqual(workflowGraph(run.definition, run).map(n => [n.id, n.status]), [['source', 'received'], ['gate', 'accepted'], ['node-0', 'blocked']])
  assert.equal(workflowGraph(definition, { ...run, status: 'completed', cursor: 1 })[2]!.status, 'completed')
  assert.ok(workflowGraph(definition).every(node => node.status === 'ready'))
  assert.match(workflowHint('interrupted_effect'), /duplicate/)
  assert.match(workflowHint('mapping_conflict'), /ownership/)
})
test('recent runs are bounded and workflow-scoped, not session navigation', () => {
  const runs = Array.from({ length: 45 }, (_, i) => ({ ...run, id: String(i), timestamp: new Date(Date.UTC(2026, 10, 12, i)).toISOString() }))
  const rows = recentWorkflowRuns({ projectId: 'fixture', definitions: [definition], runs: [...runs, { ...run, workflow: 'other' }] }, definition.id)
  assert.equal(rows.length, 30)
  assert.equal(rows[0]!.id, '44')
})
test('workflow controls use Project-scoped authenticated API with explicit replay acknowledgement', async () => {
  const requests: Array<{ url: string; body: unknown }> = []
  const request = (async (input, init) => { requests.push({ url: String(input), body: init?.body && JSON.parse(String(init.body)) }); return Response.json({ saved: true }) }) as typeof fetch
  const client = createWorkflowClient('https://fixture.test/projects/p', 'p', request)
  await client.control('run-only', 'retry', true, new AbortController().signal)
  assert.deepEqual(requests, [{ url: 'https://fixture.test/projects/p/api/workflows/control', body: { id: 'run-only', action: 'retry', acknowledgeReplay: true } }])
})
