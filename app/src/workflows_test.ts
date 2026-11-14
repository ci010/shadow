import assert from 'node:assert/strict'
import test from 'node:test'
import { createWorkflowClient, parseWorkflows, recentWorkflowRuns, workflowConversation, workflowConversationLocation, workflowGraph, workflowHint, type WorkflowDefinition, type WorkflowRun } from './workflows.ts'

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

test('group conversation chooses fixed targets or latest real receipt across revisions, never owner/run guesses', () => {
  const old = { ...run, output: { sessionId: 'web:old' } }
  const latest = { ...old, id: 'new', timestamp: '2026-11-13T00:00:00Z', output: { sessionId: 'web:latest' } }
  const empty = { ...run, id: 'no-session', timestamp: '2026-11-14T00:00:00Z' }
  for (const action of ['agent', 'program']) {
    const flow = { ...definition, owner: 'web:not-a-target', nodes: [{ kind: 'schedule-action', action }] }
    assert.deepEqual(workflowConversation(flow, [empty, old, latest]), { sessionId: 'web:latest', kind: 'latest' })
    assert.equal(workflowConversation(flow, [empty, { ...latest, workflow: 'other' }]), undefined)
  }
  for (const node of [{ kind: 'inbox' }, { kind: 'github-notify', subscription: { sessionId: 'web:fixed' } }, { kind: 'schedule-action', action: 'session', job: { target: { sessionId: 'web:fixed' } } }]) {
    assert.deepEqual(workflowConversation({ ...definition, owner: 'web:fixed', nodes: [node] }, [latest]), { sessionId: 'web:fixed', kind: 'fixed' })
  }
  assert.equal(workflowConversation(definition, [empty]), undefined)
})


test('managed/fresh conversation navigation reuses the sidebar automation route including no-run fallback', async () => {
  const { automationChatLocation } = await import('./automations.ts')
  const flow = { ...definition, id: 'schedule:learning:reflector', source: { kind: 'schedule', id: 'learning:reflector' }, nodes: [{ kind: 'schedule-action', action: 'program' }] }
  const job = { id: 'learning:reflector', name: 'Self reflection', source: 'learning' as const, session: 'fresh' as const, schedule: 'every 1h', enabled: true, editable: true, workflow: { id: flow.id, pending: 0, blocked: 0 } }
  for (const runs of [[], [{ ...run, workflow: flow.id, output: { sessionId: 'old-retained' } }]]) {
    const target = workflowConversation(flow, runs, [job])!
    assert.deepEqual(target, { kind: 'automation', automationId: job.id })
    assert.deepEqual(workflowConversationLocation('p', target), automationChatLocation('p', job.id))
  }
  assert.equal(workflowConversation(flow, [], []), undefined)
  assert.equal(workflowConversation(flow, [], [job, { ...job, id: 'ambiguous' }]), undefined)
  const fixed = workflowConversation({ ...flow, nodes: [{ kind: 'schedule-action', action: 'session', job: { target: { sessionId: 'fixed' } } }] }, [], [job])!
  assert.deepEqual(workflowConversationLocation('p', fixed), { name: 'chat', params: { projectId: 'p', sessionId: 'fixed' } })
  const host = { ...flow, id: 'internal:work-organizer', source: { kind: 'internal', id: 'organizer' } }
  assert.deepEqual(workflowConversation(host, [], [{ ...job, id: 'system:work-organizer', workflow: undefined }]), { kind: 'automation', automationId: 'system:work-organizer' })
})


test('BOT reference definitions parse beside ordinary flows and render identity without copied subscriptions or run navigation', async () => {
  const { workflowCanvas, workflowColumn } = await import('./workflow-canvas.ts')
  const bot: WorkflowDefinition = { id: 'bot-execution:support', revision: 1, enabled: true,
    source: { kind: 'bot', id: 'support' }, nodes: [{ kind: 'bot-reference', botId: 'support' }] }
  const snapshot = parseWorkflows({ projectId: 'fixture', definitions: [definition, bot], runs: [] }, 'fixture')
  assert.equal(snapshot.definitions.length, 2)
  assert.equal(workflowColumn({ definition: bot }), 'bot')
  const graph = workflowGraph(snapshot.definitions[1]!)
  assert.deepEqual(graph.map(node => node.config), [bot.source, bot.nodes[0]])
  assert.equal(graph[1]!.label, 'BOT reference')
  assert.equal(graph[1]!.detail, 'support')
  assert.match(graph[1]!.description!, /does not add listeners/)
  assert(graph.every(node => node.status === 'ready' && !node.targetSessionId))
  const canvas = workflowCanvas(snapshot.definitions.map(definition => ({ definition })))
  assert.equal(canvas.nodes.find(node => node.type === 'group' && node.data.definition.id === bot.id)!.data.column, 'bot')
  assert.equal(canvas.edges.length, 3) // Ordinary source/gate/action plus BOT source/reference.
  assert.equal(workflowConversation(bot, [{ ...run, workflow: bot.id, definition: bot, output: { sessionId: 'not-a-bot-run-target' } }]), undefined)
  for (const invalid of [
    { ...bot, binding: { demand: {} } }, { ...bot, gate: { kind: 'revision-dedupe', first: 'emit' } },
    { ...bot, source: { ...bot.source, address: 'copied-receiver' } },
    { ...bot, nodes: [{ kind: 'bot-reference', botId: 'other' }] },
    { ...bot, nodes: [{ kind: 'bot-reference', botId: 'support', bindings: [] }] },
    { ...bot, nodes: [...bot.nodes, { kind: 'record' }] },
    { ...bot, source: { kind: 'external', id: 'support' } },
  ]) assert.throws(() => parseWorkflows({ projectId: 'fixture', definitions: [invalid], runs: [] }, 'fixture'))
})
