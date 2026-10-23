import assert from 'node:assert/strict'
import test from 'node:test'
import { InitiativeStore } from '../initiatives/store.ts'
import { WorkAlignment } from '../sessions/work-alignment.ts'
import type { SessionState } from '../sessions/session-store.ts'
import type { SessionManager } from '../sessions/session-manager.ts'
import { isLightweightTopic, sessionTopicKey, sessionTopicSequence } from '../sessions/lightweight-topic.ts'
import { SessionTool } from '../tools/session.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { visibleProjectFocus, projectWorkOverviewSchema } from './work-overview.ts'
import { projectWorkOverview } from './work-routes.ts'
import { WorkOrganizer } from './work-organizer.ts'
import { overviewGraph } from '../../app/src/project-overview-graph.ts'
import { projectTopics } from '../../app/src/project-topic-history.ts'
import type { ExecutionContext } from '../tools/context.ts'

const state = (sessionId: string, patch: Partial<SessionState> = {}): SessionState => ({ sessionId, segmentIndex: 0, mode: 'session', name: sessionId, ...patch })

test('self metadata schema has no topic and historical topic values remain discoverable', () => {
  assert.equal('topic' in new SessionTool({} as never).parameters.properties!, false)
  assert.equal(isLightweightTopic(state('web:old', { topic: { title: 'Old title', goal: 'Old goal', scope: 'Old scope' } })), true)
  for (const patch of [{ mode: 'task' }, { mode: 'call' }, { agentType: 'work-organizer' }, { agentType: 'work-observer' }]) assert.equal(isLightweightTopic(state('internal', patch as Partial<SessionState>)), false)
})

test('ordinary no-Work sessions are globally rendered; persisted associations survive focus clearing without duplicate roots or Work completion', async () => withTempWorkspace(async home => {
  const states = [state('web:question', { description: 'A normal question', completed: true }), state('web:work'), state('internal:task', { mode: 'task', parentSessionId: 'web:work' }), state('internal:call', { mode: 'call', parentSessionId: 'web:work' }), state('organizer', { agentType: 'work-organizer' })]
  const store = new InitiativeStore(home, { isSessionKnown: id => states.some(s => s.sessionId === id) })
  const alignment = new WorkAlignment(store, { state: id => states.find(s => s.sessionId === id), evidence: async () => {}, changed: async () => {}, fresh: async () => {}, successor: async () => undefined })
  const sessions = { alignment, listHistoryStates: async () => states, inputs: new Map(), yields: new Map(), isWaitingForCall: () => false, getActiveSession: () => undefined } as unknown as SessionManager
  try {
    let overview = await projectWorkOverview(sessions)
    assert.equal(overview.items.length, 0)
    assert.equal(overview.sessions.some(s => s.sessionId === 'internal:call'), false)
    assert.deepEqual(projectTopics(overview).map(t => t.key).sort(), ['session:web:question', 'session:web:work'])
    const question = overviewGraph(overview).nodes.find(n => n.sessionId === 'web:question')!
    assert.equal(question.detail, 'A normal question')
    assert.equal(question.status, 'completed')
    assert.equal(question.sessionId, 'web:question', 'graph retains conversation navigation')
    const actor = { kind: 'session' as const, sessionId: 'web:work' }
    const created = await alignment.execute(actor, 'create', undefined, undefined, { title: 'A work goal', definition: { objective: 'Track an outcome' }, notes: { kind: 'goal' } }) as { key: string }
    assert(store.workSessionKeys('web:work').includes(created.key))
    await alignment.execute(actor, 'select', undefined, undefined, undefined)
    assert.equal(store.workFocus('web:work'), undefined)
    assert(store.workSessionKeys('web:work').includes(created.key))
    await alignment.execute({ kind: 'session', sessionId: 'web:question' }, 'link', created.key, undefined, undefined)
    assert.equal(store.workFocus('web:question'), undefined)
    assert.equal(alignment.get(created.key).workflow?.assignee, 'web:work')
    assert.equal(alignment.get(created.key).workflow?.status, 'pending')
    overview = await projectWorkOverview(sessions)
    assert.equal(projectTopics(overview).length, 1)
    assert.equal(projectTopics(overview)[0].sessions.filter(s => s.assignable).length, 2)
    assert.equal(overviewGraph(overview).nodes.filter(n => n.id.startsWith('session:')).length, 0)
    await assert.rejects(alignment.execute({ kind: 'session', sessionId: 'internal:task' }, 'link', created.key, undefined, undefined))
    store.close()
    const reopened = new InitiativeStore(home)
    try { assert(reopened.workSessionKeys('web:question').includes(created.key)); assert.equal(reopened.workFocus('web:question'), undefined) } finally { reopened.close() }
  } finally { store.close() }
}))

test('organizer accepts lightweight conversation identities without creating Work and detects metadata-only changes', async () => withTempWorkspace(async home => {
  const conversation = state('web:question', { description: 'Explain a concept', lastActivityAt: '2026-10-16T00:00:00Z' })
  const store = new InitiativeStore(home, { sessionTopicSequence: id => id === conversation.sessionId ? sessionTopicSequence(conversation) : undefined })
  const organizer = new WorkOrganizer(store, { projectId: 'p', activity: () => conversation.lastActivityAt!, evidence: async () => ({ sources: [], partial: false }), changed() {} })
  const ctx = { projectId: 'p', sessionId: 'organizer', physicalSessionId: 'organizer.0', signal: new AbortController().signal } as ExecutionContext
  const key = sessionTopicKey(conversation.sessionId)
  const topic = () => ({ key, sequence: sessionTopicSequence(conversation), changedAt: conversation.lastActivityAt!, workflow: { title: 'Explain concept' }, definition: { objective: conversation.description! }, observation: { sessionId: conversation.sessionId } })
  const patch = (id: string) => ({ patchId: id, expectedRevision: 0, groups: [{ id: 'concept', category: 'Concepts', purpose: 'Understand', motivation: 'Question', topicKeys: [key], cards: [] }], hierarchy: [{ id: 'learning', title: 'Learning', purpose: 'Understand', groupIds: ['concept'] }] })
  try {
    const manifest = organizer.begin(ctx.sessionId, 'full', ctx.signal, [topic()])
    assert.equal(JSON.parse(manifest).manifest[0].key, key)
    await organizer.initialContext(manifest)
    conversation.completed = true
    await assert.rejects(organizer.patch(patch('stale'), ctx), /Topics changed/)
    assert.equal(store.workRecords().length, 0)
    organizer.end()
    const next = organizer.begin(ctx.sessionId, 'full', ctx.signal, [topic()])
    await organizer.initialContext(next)
    await organizer.patch(patch('valid'), ctx)
    await organizer.finish({}, ctx)
    assert.equal(store.projectFocus()?.sources[0].key, key)
    assert.equal(store.workRecords().length, 0)
    organizer.end()
    assert.equal(JSON.parse(organizer.begin(ctx.sessionId, 'delta', ctx.signal, [topic()])).manifest.length, 0)
    organizer.end()
    conversation.description = 'Updated discovery description'
    assert.equal(JSON.parse(organizer.begin(ctx.sessionId, 'delta', ctx.signal, [topic()])).manifest.length, 1)
  } finally { organizer.end(); store.close() }
}))


test('saved standalone presentation does not duplicate a subsequently associated conversation', () => {
  const data = projectWorkOverviewSchema.parse({ items: [{ key: 'work:existing', title: 'Work', revision: 1, sequence: 1, status: 'pending', parentKey: null, dependencies: [], blockedReason: null, manager: null, assignee: null, paused: false, adopted: false, proposals: 0, interpretationReview: false, changedAt: '2026-10-16T00:00:00Z' }], sessions: [{ sessionId: 'web:linked', title: 'Linked', assignable: true, workKey: 'work:existing' }, { sessionId: 'web:free', title: 'Free', assignable: true }], requests: [], effects: [], focus: {
    origin: 'model_interpretation', inferredAt: '2026-10-16T00:00:00Z', inputCount: 2, omittedCount: 0,
    sources: [{ key: 'session:web:linked', sequence: 1 }, { key: 'session:web:free', sequence: 1 }], result: {
      groups: ['linked', 'free'].map(id => ({ category: id, purpose: id, motivation: id, topicKeys: ['session:web:' + id] })),
      hierarchy: [{ id: 'root', title: 'Topics', purpose: 'Topics', groupIndexes: [] }, { id: 'linked', parentId: 'root', title: 'Linked', purpose: 'Linked', groupIndexes: [0] }, { id: 'free', parentId: 'root', title: 'Free', purpose: 'Free', groupIndexes: [1] }],
    },
  } })
  const focus = visibleProjectFocus(data)!
  assert.deepEqual(focus.result.groups.map(group => group.topicKeys), [['session:web:free']])
  assert.deepEqual(focus.result.hierarchy?.map(node => [node.id, node.groupIndexes]), [['root', []], ['free', [0]]])
  assert.equal(data.focus?.result.groups.length, 2, 'projection never deletes persisted organization evidence')
  projectWorkOverviewSchema.parse({ ...data, focus })
})
