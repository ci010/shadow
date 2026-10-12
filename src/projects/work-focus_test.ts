import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'
import { Bus } from '../bus/bus.ts'
import { InitiativeStore } from '../initiatives/store.ts'
import { workRecordSchema } from '../initiatives/work-contract.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { createProjectScope } from './scope.ts'
import { WorkObserver, observedWorkSchema, recentFocusContext } from './work-observer.ts'
import { projectWorkPlugin } from './work-routes.ts'
import type { SessionManager } from '../sessions/session-manager.ts'

const source = { id: 'request', physicalId: 'segment' }
const focus = { category: 'Understand release effects', purpose: 'Decide using evidence', motivation: 'May want confidence', evidence: [source] }
const record = (i: number) => workRecordSchema.parse({
  key: `topic:web:chat-${i}`, subject: { kind: 'topic', sessionId: `web:chat-${i}` }, sequence: 1, revision: 1,
  definition: { objective: 'Explain the release', acceptance: [], boundaries: [], evidence: [] },
  origin: 'agent_interpretation', changedBy: 'work-observer', changedAt: '2026-10-11T00:00:00Z',
  change: 'understanding', reason: 'Evidence', paused: false,
  observation: { sessionId: `web:chat-${i}`, observedAt: '2026-10-11T00:00:00Z', sources: [source], focus },
})

test('inference schema is optional for old JSON records and evidence is validated', () => {
  const old = { ...record(1), observation: { sessionId: 'web:chat-1', observedAt: '2026-10-11T00:00:00Z', sources: [source] } }
  assert.equal(workRecordSchema.parse(JSON.parse(JSON.stringify(old))).observation?.focus, undefined)
  assert.deepEqual(workRecordSchema.parse(JSON.parse(JSON.stringify(record(1)))).observation?.focus, focus)
  assert.throws(() => workRecordSchema.parse({ ...record(1), observation: { ...record(1).observation, focus: { ...focus, evidence: [{ ...source, id: 'invented' }] } } }))
  assert(observedWorkSchema.safeParse({ track: true, title: 'x', objective: 'x', summary: '', next: '' }).success)
  const context = recentFocusContext(Array.from({ length: 12 }, (_, i) => record(i)), 'web:chat-1')
  assert.equal(context.length, 8)
  assert.deepEqual(Object.keys(context[0]!).sort(), ['category', 'purpose'])
})

test('explicit organization uses one bounded call, persists safely, rejects duplicates and keeps results on failure', async () => withTempWorkspace(async home => {
  let store = new InitiativeStore(home)
  const scope = createProjectScope('fixture'), bus = new Bus()
  for (let i = 0; i < 35; i++) store.saveWork(record(i), 0, 'fixture', 'created')
  let calls = 0, mode = 'success', input = ''
  const gate = Promise.withResolvers<void>()
  const observer = new WorkObserver(store, { scope, bus, state: () => null, changed() {}, summarize: async text => {
    calls++; input = text
    if (mode === 'wait') await gate.promise
    if (mode === 'fail') throw new Error('Provider unavailable')
    return JSON.stringify({ groups: [{ category: focus.category, purpose: focus.purpose, motivation: focus.motivation, topicKeys: [JSON.parse(text).topics[0].key] }] })
  } }, false)
  try {
    assert.equal(calls, 0)
    await observer.organize(new AbortController().signal)
    assert.equal(calls, 1)
    assert.equal(JSON.parse(input).topics.length, 30)
    assert.equal(store.projectFocus()?.omittedCount, 5)
    assert.equal(store.projectFocus()?.origin, 'model_interpretation')
    const saved = store.projectFocus()
    mode = 'fail'
    await assert.rejects(observer.organize(new AbortController().signal), /Provider/)
    assert.deepEqual(store.projectFocus(), saved)
    mode = 'wait'
    const running = observer.organize(new AbortController().signal)
    await assert.rejects(observer.organize(new AbortController().signal), /already running/)
    const key = JSON.parse(input).topics[0].key
    const prior = store.workRecords().find(value => value.key === key)!
    store.saveWork({ ...prior, sequence: 2 }, 1, 'human', 'note')
    gate.resolve()
    await assert.rejects(running, /Topics changed/)
    assert.deepEqual(store.projectFocus(), saved)
    await observer.stop(); store.close()
    store = new InitiativeStore(home)
    assert.deepEqual(store.projectFocus(), saved, 'SQLite reopen retains inference without replay')
  } finally { await observer.stop(); store.close(); scope.close() }
}))

test('organization endpoint enforces authorization and strict empty input before model execution', async () => {
  let calls = 0
  const sessions = { alignment: {} } as unknown as SessionManager
  const app = new Hono()
  projectWorkPlugin(sessions, request => request.headers.get('x-fixture-user') === 'yes', undefined, undefined,
    async () => { calls++; throw new Error('Provider failure') })(app)
  const post = (body: string, user = true) => app.request('/api/work/organize', { method: 'POST', body,
    headers: { 'content-type': 'application/json', ...(user ? { 'x-fixture-user': 'yes' } : {}) } })
  assert.equal((await post('{}', false)).status, 401)
  assert.equal((await post('{"projectId":"another-project"}')).status, 400)
  assert.equal(calls, 0)
  assert.equal((await post('{}')).status, 502)
  assert.equal(calls, 1)
})


test('real-shaped model output accepts only a complete JSON fence and preserves citation safety', async () => withTempWorkspace(async home => {
  const store = new InitiativeStore(home), scope = createProjectScope('fixture')
  store.saveWork(record(1), 0, 'fixture', 'created')
  let output = '\n```json\n' + JSON.stringify({ groups: [{ category: 'Release confidence', purpose: 'Understand effects', motivation: 'May want confidence', topicKeys: [record(1).key] }] }, null, 2) + '\n```\n'
  const observer = new WorkObserver(store, { scope, bus: new Bus(), state: () => null, changed() {}, summarize: async () => output }, false)
  try {
    await observer.organize(new AbortController().signal)
    const saved = store.projectFocus()
    for (const invalid of ['Here is the JSON:\n' + output, '{"groups":[', '{"groups":[],"extra":true}', JSON.stringify({ groups: [{ category: 'x', purpose: 'x', motivation: 'x', topicKeys: ['invented'] }] })]) {
      output = invalid
      await assert.rejects(observer.organize(new AbortController().signal), /model_(json|schema)_invalid/)
      assert.deepEqual(store.projectFocus(), saved)
      assert.equal(observer.status().running, false)
    }
  } finally { await observer.stop(); store.close(); scope.close() }
}))

test('organization route does not call model failures invalid requests and distinguishes overview failure', async () => {
  const { ObserverOutputError } = await import('./observer-output.ts')
  const sessions = { alignment: {} } as unknown as SessionManager
  for (const [error, code] of [[new SyntaxError('private model text'), 'organization_failed'], [new ObserverOutputError('model_json_invalid'), 'model_json_invalid'], [new ObserverOutputError('model_schema_invalid'), 'model_schema_invalid'], [undefined, 'organization_refresh_failed']] as const) {
    const app = new Hono()
    projectWorkPlugin(sessions, () => true, undefined, undefined, async () => { if (error) throw error })(app)
    const response = await app.request('/api/work/organize', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })
    assert.equal(response.status, 502)
    const body = await response.json()
    assert.equal(body.error, code)
    assert(!JSON.stringify(body).includes('private model text'))
  }
})
