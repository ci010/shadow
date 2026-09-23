import assert from 'node:assert/strict'
import test from 'node:test'
import { groupFolderSessions, parseSessionGraph } from './folders-sidebar.ts'
import { childConversationTarget } from './conversation-split.ts'
import { activeSubagentsByOwner, executionDisplayStage, executionStages, executionStatus, isOneShot, ownedExecutions, subagentActivityLabel, summarizeSubagents } from './subagent-executions.ts'
import { isWaitingStage, isWorkingStage, sessionActivity } from './session-activity.ts'
import { readFile } from 'node:fs/promises'
import { compileScript, compileStyle, compileTemplate, parse } from 'vue/compiler-sfc'

const graph = () => ({
  sessions: [
    { sessionId: 'web:chat-root', mode: 'session', agentType: 'general', current: 'p-root' },
    { sessionId: 'web:chat-persistent', mode: 'session', agentType: 'explore', parentSessionId: 'web:chat-root' },
    { sessionId: 'web:chat-task', mode: 'task', agentType: 'explore', parentSessionId: 'web:chat-root', executionStatus: 'pending' },
    { sessionId: 'web:chat-nested-call', mode: 'call', agentType: 'explore', parentSessionId: 'web:chat-task', executionStatus: 'running' },
    { sessionId: 'heartbeat:reflector-123', mode: 'task', executionStatus: 'completed',
      automation: { jobId: 'fresh', name: 'Review', runId: 'run', startedAt: '2026-09-16T00:00:00Z', contextMode: 'fresh' } },
    { sessionId: 'reflection-task', mode: 'task', parentSessionId: 'heartbeat:reflector-123', executionStatus: 'completed' },
    { sessionId: 'reusable-in-task', mode: 'session', parentSessionId: 'web:chat-task' },
  ],
  nodes: [
    { physicalId: 'old-root', logicalId: 'old-parent' },
    { physicalId: 'p-root', logicalId: 'web:chat-root' },
    { physicalId: 'old-task', logicalId: 'web:chat-task', parentPhysicalId: 'old-root' },
  ],
})

test('role and mode are independent; only delegated executions leave the conversation tree', () => {
  const sessions = parseSessionGraph(graph())
  const groups = groupFolderSessions([], sessions)
  assert.deepEqual(groups.chats.map(item => [item.sessionId, item.depth]), [
    ['web:chat-root', 0], ['web:chat-persistent', 0], ['reusable-in-task', 0],
  ])
  assert.deepEqual(groups.automations[0].sessions.map(item => item.sessionId), ['heartbeat:reflector-123', 'reflection-task'])
  assert.equal(sessions.find(item => item.sessionId === 'reusable-in-task')?.parentSessionId, 'web:chat-task', 'Grouping never mutates diagnostic lineage')
  assert.equal(sessions.find(item => item.sessionId === 'web:chat-task')?.isDirectChat, false, 'Mode overrides even web chat ID prefixes')
  assert.equal(sessions.find(item => item.sessionId === 'web:chat-persistent')?.isDirectChat, true)
  assert.equal(ownedExecutions(sessions, 'web:chat-root')[0].isCurrent, false, 'Pending execution without a physical current is a card, not an empty conversation')
})

test('leaf call inspection follows explicit logical ownership, not inherited physical context', () => {
  const sessions = parseSessionGraph(graph())
  assert.deepEqual(ownedExecutions(sessions, 'web:chat-root').map(item => item.sessionId), ['web:chat-task'])
  assert.deepEqual(ownedExecutions(sessions, 'web:chat-task').map(item => item.sessionId), ['web:chat-nested-call'])
  assert.deepEqual(childConversationTarget(sessions, 'web:chat-nested-call', 'web:chat-root'), { primaryId: 'web:chat-root', childId: 'web:chat-nested-call' })
  assert.deepEqual(ownedExecutions(sessions, 'web:chat-nested-call'), [])
  assert.equal(sessions.find(item => item.sessionId === 'web:chat-nested-call')?.isDirectChat, false)
  assert.deepEqual(ownedExecutions(sessions, 'heartbeat:reflector-123').map(item => item.sessionId), ['reflection-task'])
})

test('legacy graphs retain their old conversation and input behavior', () => {
  const sessions = parseSessionGraph({
    sessions: [{ sessionId: 'web:chat-parent' }, { sessionId: 'web:chat-child', ephemeral: true }],
    nodes: [{ physicalId: 'p', logicalId: 'web:chat-parent' }, { physicalId: 'c', logicalId: 'web:chat-child', parentPhysicalId: 'p' }],
  })
  assert.equal(sessions[1].parentSessionId, 'web:chat-parent')
  assert.equal(sessions[1].isDirectChat, true)
  assert.equal(isOneShot(sessions[1]), false, 'Do not interpret ephemeral config in the new UI')
  assert.equal(groupFolderSessions([], sessions).chats.length, 2)
  assert.equal(ownedExecutions(sessions, 'web:chat-parent').length, 0)
})

test('refresh keeps stable card IDs and tree IDs despite terminal transitions and physical compaction', () => {
  const before = parseSessionGraph(graph())
  const next = graph()
  next.sessions[2].executionStatus = 'completed'
  next.nodes.push({ physicalId: 'new-root', logicalId: 'web:chat-root', parentPhysicalId: 'p-root' })
  const after = parseSessionGraph(next)
  assert.deepEqual(ownedExecutions(before, 'web:chat-root').map(item => item.sessionId), ownedExecutions(after, 'web:chat-root').map(item => item.sessionId))
  assert.deepEqual(groupFolderSessions([], before).chats, groupFolderSessions([], after).chats)
})

test('all execution states are explicit and terminal states never regress to idle or stale activity', () => {
  const execution = parseSessionGraph(graph())[2]
  for (const status of ['pending', 'running', 'waiting', 'completed', 'failed', 'cancelled'] as const) {
    execution.executionStatus = status
    assert.equal(executionStatus(execution, 'idle'), status)
    assert.notEqual(sessionActivity(status).label, 'Ready')
    assert.equal(sessionActivity(status).working, status === 'running' || status === 'waiting')
    if (['completed', 'failed', 'cancelled'].includes(status)) assert.equal(executionStatus(execution, 'llm'), status)
  }
  execution.executionStatus = undefined
  assert.equal(executionStages([execution], { [execution.sessionId]: 'idle' })[execution.sessionId], undefined)
  assert.equal(executionStatus(execution, 'waiting'), 'waiting')
  assert.equal(executionStatus(execution, 'tool'), 'running')
})

test('invalid mode, status, role, owner and duplicate identity reject the whole graph', () => {
  for (const fields of [{ mode: 'ephemeral' }, { mode: null }, { executionStatus: 'idle' }, { agentType: 123 }, { parentSessionId: 5 }, { parentSessionId: '' }, { waitingForCall: 'true' }, { waitingForCall: null }]) {
    assert.throws(() => parseSessionGraph({ sessions: [{ sessionId: 'valid', ...fields }], nodes: [] }), /Cannot read conversations/)
  }
  assert.throws(() => parseSessionGraph({ sessions: [{ sessionId: 'same' }, { sessionId: 'same' }], nodes: [] }), /Cannot read conversations/)
  const value = graph()
  value.sessions[2].parentSessionId = null as unknown as string
  assert.equal(parseSessionGraph(value).find(item => item.sessionId === 'web:chat-task')?.parentSessionId, null)
})

test('orphaned and cyclic executions retain a bounded diagnostic entry', () => {
  const sessions = parseSessionGraph({ sessions: [
    { sessionId: 'orphan', mode: 'task', parentSessionId: 'missing' },
    { sessionId: 'a', mode: 'task', parentSessionId: 'b' },
    { sessionId: 'b', mode: 'task', parentSessionId: 'a' },
  ], nodes: [] })
  assert.deepEqual(new Set(groupFolderSessions([], sessions).chats.map(item => item.sessionId)), new Set(['orphan', 'a', 'b']))
})

test('async tasks never override the owning conversation runtime activity', () => {
  const sessions = parseSessionGraph(graph())
  for (const stage of ['idle', 'llm', 'tool', 'waiting'] as const) {
    const displayed = executionStages(sessions, { 'web:chat-root': stage })
    assert.equal(displayed['web:chat-root'], stage)
    assert.equal(displayed['web:chat-nested-call'], 'running', 'Only the child retains its actual execution state')
  }
})

test('sidebar activity rolls up nested delegated executions without changing parent stages or historical lineage', () => {
  const sessions = parseSessionGraph(graph())
  const stages = { 'web:chat-root': 'idle', 'web:chat-nested-call': 'tool' } as const
  const owners = activeSubagentsByOwner(sessions, stages)
  assert.deepEqual(owners.get('web:chat-root')?.map(session => session.sessionId), ['web:chat-task', 'web:chat-nested-call'])
  assert.deepEqual(owners.get('web:chat-task')?.map(session => session.sessionId), ['web:chat-nested-call'])
  assert.equal(owners.has('web:chat-persistent'), false)
  assert.equal(owners.has('heartbeat:reflector-123'), false)
  assert.deepEqual(summarizeSubagents(owners.get('web:chat-root')!, stages), { running: 1, waiting: 0, pending: 1 })
  assert.equal(stages['web:chat-root'], 'idle')
  assert.equal(executionStages(sessions, stages)['web:chat-root'], 'idle')
  const completed = sessions.map(session => isOneShot(session) ? { ...session, executionStatus: 'completed' as const } : session)
  assert.equal(activeSubagentsByOwner(completed, stages).size, 0, 'Terminal metadata wins even over stale running stages')
})

test('delegated status keeps waiting for a human, pending, and working distinct and deduplicates group summaries', () => {
  const sessions = parseSessionGraph({ sessions: [
    { sessionId: 'root', mode: 'session' },
    { sessionId: 'task', parentSessionId: 'root', mode: 'task', executionStatus: 'waiting', waitingForCall: true },
    { sessionId: 'call', parentSessionId: 'task', mode: 'call', executionStatus: 'waiting' },
    { sessionId: 'pending', parentSessionId: 'root', mode: 'task', executionStatus: 'pending' },
  ], nodes: [] })
  const owners = activeSubagentsByOwner(sessions, {})
  const activity = summarizeSubagents([...owners.get('root')!, ...owners.get('task')!], {})
  assert.deepEqual(activity, { running: 1, waiting: 1, pending: 1 })
  assert.equal(subagentActivityLabel(activity), '1 subagent working, 1 subagent waiting for a response, 1 subagent pending')
  assert.equal(subagentActivityLabel({ running: 2, waiting: 0, pending: 0 }), '2 subagents working')
  assert.equal(subagentActivityLabel(summarizeSubagents([], {})), '')
})

test('subagent rollups stop at persistent owners and ignore orphan, context-only, and cross-project ancestry', () => {
  const sessions = parseSessionGraph({ sessions: [
    { sessionId: 'historical', mode: 'session', projectId: 'a' },
    { sessionId: 'owner', mode: 'session', projectId: 'a', parentSessionId: 'historical' },
    { sessionId: 'child', mode: 'task', projectId: 'a', parentSessionId: 'owner', executionStatus: 'running' },
    { sessionId: 'other-project', mode: 'task', projectId: 'b', parentSessionId: 'owner', executionStatus: 'running' },
    { sessionId: 'context-only', mode: 'task', parentSessionId: null, executionStatus: 'running' },
    { sessionId: 'orphan', mode: 'task', parentSessionId: 'missing', executionStatus: 'running' },
  ], nodes: [] })
  const owners = activeSubagentsByOwner(sessions, {})
  assert.deepEqual([...owners.keys()], ['owner'])
  assert.deepEqual(owners.get('owner')?.map(session => session.sessionId), ['child'])
  const cycle = parseSessionGraph({ sessions: [
    { sessionId: 'a', mode: 'task', parentSessionId: 'b', executionStatus: 'running' },
    { sessionId: 'b', mode: 'call', parentSessionId: 'a', executionStatus: 'running' },
  ], nodes: [] })
  assert.deepEqual([...activeSubagentsByOwner(cycle, {})].map(([owner, children]) => [owner, children.map(child => child.sessionId)]),
    [['b', ['a']], ['a', ['b']]])
})

test('blocking call waits belong to their task or reusable sub-session, never its root ancestor', () => {
  for (const mode of ['session', 'task'] as const) {
    const sessions = parseSessionGraph({ sessions: [
      { sessionId: 'root', mode: 'session' },
      { sessionId: 'owner', mode, parentSessionId: 'root', waitingForCall: true, executionStatus: 'waiting' },
      { sessionId: 'leaf', mode: 'call', parentSessionId: 'owner', executionStatus: 'running' },
    ], nodes: [] })
    const owner = sessions[1]
    const stages = executionStages(sessions, { root: 'idle', owner: 'llm', leaf: 'llm' })
    assert.equal(stages.root, 'idle')
    assert.equal(stages.owner, 'waiting-for-call')
    assert.equal(isWorkingStage(stages.owner), true)
    assert.equal(isWaitingStage(stages.owner), true)
    assert.equal(sessionActivity(stages.owner).label, 'Waiting for call')
    assert.equal(executionDisplayStage(owner, 'tool'), 'waiting-for-call')
    owner.waitingForCall = false
    assert.equal(executionDisplayStage(owner, 'waiting'), 'waiting', 'Real yield remains distinct outside calls')
    owner.waitingForCall = true
    owner.executionStatus = 'completed'
    assert.equal(executionDisplayStage(owner, 'waiting'), 'completed', 'Terminal wins over stale wait metadata')
  }
})

test('mode surfaces compile without replacing existing composer, hidden preview or child-pane controls', async () => {
  for (const filename of ['ExecutionMessage.vue', 'ConversationEvent.vue', 'ChatTab.vue', 'AgentsTab.vue', 'SessionActivity.vue', 'YieldQuestion.vue', 'FolderSessionList.vue', 'SessionWorkControls.vue', 'BackgroundTasks.vue', 'FoldersSidebar.vue']) {
    const source = await readFile(new URL(`./components/${filename}`, import.meta.url), 'utf8')
    const { descriptor, errors } = parse(source, { filename })
    assert.deepEqual(errors, [])
    const script = compileScript(descriptor, { id: filename })
    assert.deepEqual(compileTemplate({ source: descriptor.template!.content, filename, id: filename,
      compilerOptions: { bindingMetadata: script.bindings } }).errors, [])
    for (const style of descriptor.styles) assert.deepEqual(compileStyle({
      source: style.content, filename, id: filename, scoped: true,
    }).errors, [])
    if (filename === 'ExecutionMessage.vue') {
      assert.match(source, /:data-execution-id="execution\.sessionId"/)
      assert.doesNotMatch(source, /fetch\(/)
    }
    if (filename === 'ChatTab.vue') {
      assert.match(source, /:explorer-enabled="!embedded && \(!activeSessionId \|\| !!currentWorkdir \|\| expectedHome\)"/)
      assert.match(source, /<FileWorkbench[^>]*:session-id="activeSessionId"/)
      assert.match(source, /conversationDocumentVisible\.value && activeSessionId\.value/)
      assert.match(source, /if \(isExecution\.value\) \{\s*composerError\.value/)
      assert.match(source, /ctxRes && !ctxRes\.ok/)
      assert.match(source, /inspectExecution, restoreSession \} = useConversationNavigation\(/)
      assert.match(source, /<ExecutionMessage v-(?:else-)?if="inlineExecutions.entries.has\(idx\)"/, 'Executions occupy the original tool-call position')
      assert.doesNotMatch(source, /<ExecutionCards|expandedEvents/)
      assert.match(source, /<YieldQuestion v-if="!isCall"/, 'Leaf calls must not mount or poll yield controls')
      assert.doesNotMatch(source, /if \(awaitingCall\.value\) return/, 'Callers can submit guidance while a blocking call runs')
      assert.doesNotMatch(source, /waiting-for-subagent|waiting-for-user/)
    }
    if (filename === 'AgentsTab.vue') assert.doesNotMatch(source, /ephemeral/i)
    if (filename === 'ExecutionMessage.vue') {
      assert.match(source, /Task · fresh context · async/)
      assert.match(source, /Call · inherited context · blocking/)
      assert.doesNotMatch(source, /Call · inherited context · async/)
    }
    if (filename === 'SessionActivity.vue') assert.match(source, /activity\.working && !isWaitingStage\(activity\.kind\)/)
  }
})
