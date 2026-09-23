import assert from 'node:assert/strict'
import test from 'node:test'
import { createSessionSoundTracker, startSessionSoundMonitor } from './session-sound-monitor.ts'
import { parseSessionGraph } from './folders-sidebar.ts'
import type { LiveClient, LiveObserver } from './live-client.ts'
import { createProjectLiveState } from './project-live-state.ts'
import type { NotificationSound } from './notification-sounds.ts'
import type { ProjectConversationState } from './projects.ts'

const snapshot = (stages: Record<string, string>): ProjectConversationState => ({
  stages, sessionsError: '', stagesError: '',
  sessions: parseSessionGraph({ sessions: [
    { sessionId: 'web:root', mode: 'session' }, { sessionId: 'sub:task', mode: 'task', parentSessionId: 'web:root' },
    { sessionId: 'sub:call', mode: 'call', parentSessionId: 'web:root' },
  ], nodes: [] }),
})
const settle = () => new Promise(resolve => setTimeout(resolve, 10))

test('tracker only reports observed work-to-idle transitions, not history, cancellations of yields, or child executions', () => {
  const tracker = createSessionSoundTracker()
  assert.deepEqual(tracker.observe(snapshot({ 'web:root': 'idle' })).idle, [])
  assert.deepEqual(tracker.observe(snapshot({ 'web:root': 'llm', 'sub:task': 'tool', 'sub:call': 'tool' })).idle, [])
  assert.deepEqual(tracker.observe(snapshot({ 'web:root': 'tool', 'sub:task': 'idle', 'sub:call': 'idle' })).idle, [])
  assert.deepEqual(tracker.observe(snapshot({ 'web:root': 'idle' })).idle, ['web:root'])
  assert.deepEqual(tracker.observe(snapshot({ 'web:root': 'idle' })).idle, [])
  tracker.observe(snapshot({ 'web:root': 'waiting' }))
  assert.deepEqual(tracker.observe(snapshot({ 'web:root': 'idle' })).idle, [])
  tracker.observe(snapshot({ 'web:root': 'llm' }))
  tracker.reset()
  assert.deepEqual(tracker.observe(snapshot({ 'web:root': 'idle' })).idle, [])
})

test('yield identities suppress repeats but allow the next question without an intermediate stage snapshot', () => {
  const tracker = createSessionSoundTracker()
  const initial = tracker.observe(snapshot({ 'web:root': 'waiting', 'sub:task': 'waiting' }))
  assert.equal(initial.baseline, true)
  assert.deepEqual(initial.waiting, ['web:root'])
  assert.equal(tracker.question('web:root', 'q1', initial.baseline), false)
  const next = tracker.observe(snapshot({ 'web:root': 'waiting' }))
  assert.equal(next.baseline, false)
  assert.equal(tracker.question('web:root', 'q1'), false)
  assert.equal(tracker.question('web:root', 'q2'), true)
  assert.equal(tracker.question('web:root', 'q2'), false)
  assert.deepEqual(tracker.observe(snapshot({ 'web:root': 'waiting-for-call' })).waiting, [])
})

test('app monitor isolates Projects, confirms human yield recipients, ignores replay, and cleans up subscriptions', async t => {
  const observers = new Map<string, LiveObserver>()
  const stages: Record<string, string> = { a: 'idle', b: 'idle' }
  const questionIds: Record<string, string> = { a: 'a1', b: 'b1' }
  let parent = false
  let invalid = false
  let liveReady = true
  const emitted: NotificationSound[] = []
  let error = ''
  const request: typeof fetch = async input => {
    const path = new URL(String(input)).pathname
    if (path === '/api/projects') return Response.json({ projects: ['a', 'b'].map(id => ({ id, name: id, createdAt: '' })) })
    const id = path.split('/')[2]!
    if (path.endsWith('/graph')) return Response.json({ sessions: [{ sessionId: 'web:root', mode: 'session' }], nodes: [] })
    if (path.endsWith('/stages')) return Response.json(invalid ? { stages: { 'web:root': 123 } } : { stages: { 'web:root': stages[id] } })
    if (path.endsWith('/yield')) return Response.json({ request: {
      id: questionIds[id], sessionId: 'web:root', question: 'Continue?', options: ['Yes', 'No'], defaultOption: 'No',
      recipient: { kind: parent ? 'parent' : 'user', sessionId: parent ? 'web:owner' : 'web:root' },
      createdAt: new Date().toISOString(), deadline: null,
    } })
    throw new Error(`Unexpected ${path}`)
  }
  const live: Pick<LiveClient, 'subscribe' | 'isLive'> = {
    isLive: () => liveReady, subscribe(topic, observer) {
      const key = topic.kind === 'projects' ? 'catalog' : topic.projectId
      observers.set(key, observer)
      queueMicrotask(() => observer.reset('subscription'))
      return { ready: async () => {}, close: () => { observers.delete(key) } }
    },
  }
  const state = createProjectLiveState({ client: () => live }, { request, delayMs: 0 })
  t.after(() => state.dispose())
  const stop = startSessionSoundMonitor({
    base: 'http://fixture', request, state, live,
    notify: kind => emitted.push(kind), error: message => { error = message },
  })
  t.after(stop)
  const update = async (project: string, stage: string) => {
    stages[project] = stage
    observers.get(project)!.event({ type: 'event', cursor: 'epoch:1', topic: { kind: 'sessions', projectId: project }, payload: { event: 'invalidate' } })
    await settle()
  }
  await settle()
  assert.equal(observers.size, 3)
  assert.deepEqual(emitted, [])
  await update('a', 'llm')
  await update('a', 'idle')
  assert.deepEqual(emitted, ['idle'])
  await update('b', 'waiting')
  await update('b', 'waiting')
  assert.deepEqual(emitted, ['idle', 'yield'])
  questionIds.b = 'b2'
  await update('b', 'waiting')
  assert.deepEqual(emitted, ['idle', 'yield', 'yield'])
  parent = true
  await update('a', 'waiting')
  assert.equal(emitted.length, 3)
  parent = false
  questionIds.b = 'b3'
  observers.get('b')!.reset('epoch')
  await settle()
  await update('b', 'waiting')
  assert.equal(emitted.length, 3, 'A reconnect seeds existing questions silently')
  invalid = true
  await update('a', 'idle')
  assert.match(error, /sounds are unavailable/)
  invalid = false
  await update('a', 'idle')
  assert.equal(error, '')
  assert.equal(emitted.length, 3)
  const finish = async (turnId: string) => {
    observers.get('a')!.event({ type: 'event', cursor: 'epoch:2', topic: { kind: 'sessions', projectId: 'a' },
      payload: { event: 'invalidate', sessionId: 'web:root', completedTurnId: turnId } })
    await settle()
  }
  await finish('fast-turn')
  assert.equal(emitted.length, 4, 'A successful turn between snapshots still produces an idle cue')
  await finish('fast-turn')
  assert.equal(emitted.length, 4, 'Duplicate completed turn identities do not sound twice')
  liveReady = false
  await finish('replayed-turn')
  liveReady = true
  await update('a', 'idle')
  assert.equal(emitted.length, 4, 'Replayed completions never produce a backlog')
  await finish('new-turn')
  assert.equal(emitted.length, 5)
  stop()
  assert.equal(observers.size, 0)
})

test('disposing the monitor aborts its catalog request before it can monitor projects', async () => {
  let signal: AbortSignal | null | undefined
  let finish!: (response: Response) => void
  let subscriptions = 0
  const state = createProjectLiveState({ client: () => ({
    subscribe(topic) {
      assert.equal(topic.kind, 'projects')
      subscriptions++
      return { ready: async () => {}, close() { subscriptions-- } }
    },
  }) }, {
    request: async (_input, init) => { signal = init?.signal; return new Promise(resolve => { finish = resolve }) },
    delayMs: 0,
  })
  const stop = startSessionSoundMonitor({
    base: 'http://fixture', state, live: {}, notify: () => assert.fail('No sound after disposal'), error() {},
  })
  await settle()
  stop()
  assert.equal(signal?.aborted, true)
  finish(Response.json({ projects: [{ id: 'a', name: 'A', createdAt: '' }] }))
  await settle()
  assert.equal(subscriptions, 0)
  state.dispose()
})
