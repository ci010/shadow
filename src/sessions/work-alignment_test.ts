import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { InitiativeStore } from '../initiatives/store.ts'
import { workKey, type WorkChange, type WorkRecord } from '../initiatives/work-contract.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { WorkAlignment } from './work-alignment.ts'
import { SessionTools, Tools } from '../tools/registry.ts'
import type { ExecutionContext } from '../tools/context.ts'
import type { SessionState } from './session-store.ts'
import { WorkTool } from '../tools/work.ts'
import { InitiativeTool } from '../tools/initiative.ts'
import { INITIATIVE_SCHEMA_PROMPT } from '../initiatives/schema.ts'

const worker = 'web:worker', owner = 'web:owner', peer = 'web:peer'
const adoption = { understanding: 'Both evaluations are required.', stop: ['Treating smoke as final scope'], retain: ['Verified inputs'], next: ['Run a bounded first phase'] }
const inventory = { completed: ['Collected inputs'], artifacts: ['synthetic/report.json'], inFlight: [], unknown: [], retired: ['Smoke-only goal'] }
function change(revision = 0): WorkChange {
  return { subject: { kind: 'topic', sessionId: worker }, expectedRevision: revision,
    change: 'understanding', reason: 'Keep final outcome distinct from execution staging.', paused: false,
    definition: { objective: 'Run both independent evaluations', acceptance: ['Both have attributable results'], boundaries: ['No publication authority'], evidence: [] } }
}
function fixture(workspace: string, trackWork = false) {
  const states: Record<string, SessionState> = Object.fromEntries([worker, owner, peer].map(sessionId => [sessionId, { sessionId, mode: 'session', segmentIndex: 0 }]))
  const options = { trackWork, isSessionKnown: (id: string) => !!states[id] }
  const store = new InitiativeStore(workspace, options)
  const changes: WorkRecord[] = [], transitions: WorkRecord[] = []
  const alignment = new WorkAlignment(store, {
    state: id => states[id], evidence: async () => { throw new Error('No evidence fixture for this source.') },
    changed: async record => { changes.push(record) },
    fresh: async (_, record) => { transitions.push(record) },
    successor: async () => 'web:successor',
  })
  const base = new Tools(workspace)
  base.setWorkGuard(alignment)
  base.register(new WorkTool(alignment))
  const tools = new SessionTools(base, workspace)
  const context = (id = worker): ExecutionContext => ({
    sessionId: id, physicalSessionId: 'synthetic.0', channel: 'web', chatId: id.slice(4), senderId: 'fixture',
    messageId: randomUUID(), signal: new AbortController().signal, projectId: 'project', tools,
    workStamps: alignment.snapshot(id),
  })
  const apply = async (request = change(), human = false) => {
    await alignment.execute(human ? { kind: 'user' } : { kind: 'session', sessionId: worker }, 'update', undefined, undefined, request)
    return alignment.get(workKey(request.subject))
  }
  const adopt = async (key = workKey(change().subject), revision = 1, id = worker) =>
    alignment.execute({ kind: 'session', sessionId: id }, 'adopt', key, revision, adoption)
  return { states, options, store, alignment, base, tools, context, apply, adopt, changes, transitions }
}

test('contracts separate human provenance, agent phase, control and executor adoption', async () => withTempWorkspace(async workspace => {
  const f = fixture(workspace)
  try {
    const record = await f.apply()
    assert.equal(record.origin, 'agent_interpretation')
    assert.throws(() => f.alignment.assertCurrent(f.alignment.snapshot(worker), worker), /not adopted/)
    await assert.rejects(f.alignment.execute({ kind: 'user' }, 'adopt', record.key, 1, adoption), /cannot impersonate/)
    await assert.rejects(f.alignment.execute({ kind: 'session', sessionId: peer }, 'adopt', record.key, 1, adoption), /Only the current/)
    await f.adopt()
    f.alignment.assertCurrent(f.alignment.snapshot(worker), worker)
    assert.equal(f.alignment.get(record.key).definition.objective, 'Run both independent evaluations')
    assert.deepEqual(f.alignment.get(record.key).adoption?.next, adoption.next)
    await assert.rejects(f.alignment.execute({ kind: 'session', sessionId: peer }, 'update', undefined, undefined, change(1)), /Only the work controller/)
    const proposed = await f.alignment.execute({ kind: 'session', sessionId: peer }, 'propose', undefined, undefined, change(1))
    assert.equal((proposed as { status: string }).status, 'proposed')
    assert.equal(f.alignment.get(record.key).revision, 1)
    await f.apply(change(1), true)
    await assert.rejects(f.apply(change(2)), /human review/)
    await assert.rejects(f.apply(change(1), true), /revision changed/)
    assert.throws(() => f.store.query('SELECT * FROM work_contracts', worker), /Unknown/)
  } finally { f.store.close() }
}))

test('registry fences old inference, same-batch adoption, nested tools, and restored pending calls', async () => withTempWorkspace(async workspace => {
  const f = fixture(workspace)
  let writes = 0
  f.base.register({ name: 'write_fixture', description: '', parameters: { type: 'object', properties: {} },
    async execute() { writes++; return 'written' } })
  f.base.register({ name: 'nested_fixture', description: '', parameters: { type: 'object', properties: {} },
    async execute(_, context) { return context.tools.execute('write_fixture', {}, context) } })
  try {
    assert.match(await f.tools.execute('write_fixture', {}, f.context()), /Untracked execution/)
    await f.apply()
    const clarification = { name: 'yield', description: '', parameters: { type: 'object' as const, properties: {} }, async execute() { return 'clarification' } }
    assert.equal(f.alignment.before(clarification, { action: 'ask' }, f.context()), undefined, 'Asking for clarification does not require adopting an unclear goal')
    const unadopted = f.context()
    await f.adopt()
    assert.match(await f.tools.execute('write_fixture', {}, unadopted), /basis changed|not adopted/)
    assert.match(await f.tools.execute('write_fixture', {}, { ...f.context(), workStamps: undefined }), /not adopted/)
    const old = f.context()
    const snapshot = f.tools.snapshot()
    assert.equal(snapshot.getWorkGuard(), f.alignment, 'Call snapshots keep the runtime fence')
    assert.equal(await f.tools.execute('nested_fixture', {}, old), 'written')
    await f.apply(change(1), true)
    await f.adopt(undefined, 2)
    assert.match(await f.tools.execute('nested_fixture', {}, old), /basis changed/)
    assert.equal(writes, 1)
    assert.equal(await f.tools.execute('write_fixture', {}, f.context()), 'written')
    assert.equal(writes, 2)
  } finally { f.store.close() }
}))

test('late results stay attributable and unresolved effects survive restart without replay', async () => withTempWorkspace(async workspace => {
  const f = fixture(workspace)
  const result = Promise.withResolvers<string>(), started = Promise.withResolvers<void>()
  f.base.register({ name: 'held_fixture', description: '', parameters: { type: 'object', properties: {} },
    async execute() { started.resolve(); return result.promise } })
  try {
    await f.apply(); await f.adopt()
    const pending = f.tools.execute('held_fixture', {}, f.context())
    await started.promise
    assert.equal(f.store.workEffects().length, 1)
    await f.apply(change(1), true)
    result.resolve('external result')
    assert.match(await pending, /STALE WORK RESULT/)
    const key = workKey(change().subject)
    const event = f.store.workHistory(key).find(item => item.kind === 'tool_result')
    assert.equal((event?.data as { stale: boolean }).stale, true)
    await f.adopt(key, 2)
    const effectId = randomUUID()
    f.store.startWorkEffect(effectId, worker, 'external', f.alignment.snapshot(worker))
    f.store.close()
    const reopened = new InitiativeStore(workspace, f.options)
    try {
      reopened.recoverWorkEffects()
      assert.equal(reopened.workEffects()[0].status, 'unknown')
      assert.equal(reopened.workRecords()[0].revision, 2)
      assert.equal(reopened.workRecords()[0].adoption?.revision, 2)
    } finally { reopened.close() }
  } finally { result.resolve('cleanup'); f.store.close() }
}))

test('bounded tasks cannot manage contracts but retain their durable owner execution fence', async () => withTempWorkspace(async workspace => {
  const f = fixture(workspace)
  let writes = 0
  f.base.register({ name: 'write_fixture', description: '', parameters: { type: 'object', properties: {} },
    async execute() { writes++; return 'written' } })
  try {
    const tools = new SessionTools(f.base, workspace)
    tools.setExecutionScope('task', ['task'])
    assert.equal(tools.has('work'), false)
    f.states['task:standalone'] = { sessionId: 'task:standalone', mode: 'task', segmentIndex: 0 }
    assert.equal(await tools.execute('write_fixture', {}, { ...f.context('task:standalone'), tools }), 'written')
    f.states['task:child'] = { sessionId: 'task:child', mode: 'task', segmentIndex: 0, parentSessionId: worker }
    await f.apply()
    const pending = { ...f.context('task:child'), tools }
    assert.match(await tools.execute('write_fixture', {}, pending), /not adopted/)
    await f.adopt()
    assert.match(await tools.execute('write_fixture', {}, pending), /basis changed|not adopted/)
    assert.equal(await tools.execute('write_fixture', {}, { ...f.context('task:child'), tools }), 'written')
    assert.equal(writes, 2)
  } finally { f.store.close() }
}))

test('safe fresh-context transitions require executor inventory and retain unknown effects', async () => withTempWorkspace(async workspace => {
  const f = fixture(workspace)
  try {
    const { key } = await f.apply()
    await assert.rejects(f.alignment.execute({ kind: 'user' }, 'transition', key, 1, { strategy: 'fresh' }), /checkpoint/)
    await f.alignment.execute({ kind: 'session', sessionId: worker }, 'checkpoint', key, 1, { ...inventory, inFlight: ['remote job'] })
    await assert.rejects(f.alignment.execute({ kind: 'user' }, 'transition', key, 1, { strategy: 'fresh' }), /in-flight/)
    await f.alignment.execute({ kind: 'session', sessionId: worker }, 'checkpoint', key, 1, inventory)
    await assert.rejects(f.alignment.execute({ kind: 'session', sessionId: peer }, 'transition', key, 1, { strategy: 'fresh' }), /controller/)
    await f.alignment.execute({ kind: 'user' }, 'transition', key, 1, { strategy: 'fresh' })
    assert.equal(f.transitions.length, 1)
    await assert.rejects(f.adopt(), /pending transition/)
    const record = f.alignment.get(key)
    assert.match(f.alignment.handoff(record), /retired.*Smoke-only/)
    f.alignment.finishTransition(key, record.transition!.id)
    await f.adopt()
    f.alignment.assertCurrent(f.alignment.snapshot(worker), worker)
    f.alignment.reviewAnswer(worker, 'I asked for both, not just smoke.', 'question')
    assert.throws(() => f.alignment.assertCurrent(f.alignment.snapshot(worker), worker), /not adopted/)
    assert.equal(f.alignment.get(key).answerReview?.text, 'I asked for both, not just smoke.')
  } finally { f.store.close() }
}))

test('Initiative contracts reuse assignment authority and isolate selected unaffected work', async () => withTempWorkspace(async workspace => {
  const f = fixture(workspace, true)
  try {
    f.store.query("INSERT INTO initiatives(id,title,goal,context) VALUES('build','Build','Deliver both outputs',''); INSERT INTO initiative_items(id,initiative_id,title,assignee_session_id) VALUES('a','build','Output A','web:worker'); INSERT INTO initiative_items(id,initiative_id,title,assignee_session_id) VALUES('b','build','Output B','web:worker')", owner)
    assert.equal(f.alignment.records(worker).length, 2)
    await f.adopt('item:a'); await f.adopt('item:b')
    await f.alignment.execute({ kind: 'user' }, 'update', undefined, undefined, {
      ...change(), subject: { kind: 'item', initiativeId: 'build', itemId: 'a' }, expectedRevision: 1, paused: true,
    })
    assert.throws(() => f.alignment.assertCurrent(f.alignment.snapshot(worker), worker), /not adopted/)
    await f.alignment.execute({ kind: 'session', sessionId: worker }, 'select', 'item:b', 1, undefined)
    f.alignment.assertCurrent(f.alignment.snapshot(worker), worker)
    f.store.query("UPDATE initiative_items SET status='in_progress' WHERE id='b'", worker)
    assert.equal(f.alignment.get('item:b').revision, 1, 'Status changes are not semantic revisions')
    assert.throws(() => f.store.query("UPDATE initiatives SET goal='Only smoke' WHERE id='build'", owner), /versioned agreements/)
    f.base.register(new InitiativeTool(f.store, 'project', INITIATIVE_SCHEMA_PROMPT))
    const readTools = new SessionTools(f.base, workspace, ['initiative'])
    assert.match(await readTools.execute('initiative', { query: 'SELECT * FROM initiative_items' }, { ...f.context(), tools: readTools, workStamps: [] }), /Output A/)
  } finally { f.store.close() }
}))

test('successor preparation retires old execution but cannot seize Initiative ownership', async () => withTempWorkspace(async workspace => {
  const f = fixture(workspace, true)
  try {
    f.store.query("INSERT INTO initiatives(id,title,goal,context) VALUES('build','Build','Deliver',''); INSERT INTO initiative_items(id,initiative_id,title,assignee_session_id) VALUES('a','build','Output','web:worker')", owner)
    await f.adopt('item:a')
    await f.alignment.execute({ kind: 'session', sessionId: worker }, 'checkpoint', 'item:a', 1, inventory)
    await f.alignment.execute({ kind: 'session', sessionId: owner }, 'transition', 'item:a', 1, { strategy: 'successor' })
    assert.equal(f.store.workAuthority({ kind: 'item', initiativeId: 'build', itemId: 'a' }).executor, worker)
    await assert.rejects(f.adopt('item:a'), /retired/)
    await assert.rejects(f.alignment.execute({ kind: 'session', sessionId: owner }, 'release', 'item:a', 1, undefined), /Only the current assignee/)
    await f.alignment.execute({ kind: 'session', sessionId: worker }, 'release', 'item:a', 1, undefined)
    assert.equal(f.store.workAuthority({ kind: 'item', initiativeId: 'build', itemId: 'a' }).executor, null)
    assert.throws(() => f.alignment.assertCurrent(f.alignment.snapshot(worker), worker), /not adopted|paused/)
  } finally { f.store.close() }
}))

test('v3 migration preserves legacy work without inventing contracts or user requirements', async () => withTempWorkspace(async workspace => {
  const store = new InitiativeStore(workspace)
  store.query("INSERT INTO initiatives(id,title,goal,context) VALUES('legacy','Legacy','Original','Keep'); INSERT INTO initiative_items(id,initiative_id,title,assignee_session_id) VALUES('old','legacy','Old task','worker')", 'owner')
  store.close()
  const db = new DatabaseSync(join(workspace, 'initiatives.sqlite'))
  db.exec('DROP TABLE work_focus; DROP TABLE work_effects; DROP TABLE work_contract_events; DROP TABLE work_contracts; PRAGMA user_version=3')
  db.close()
  const reopened = new InitiativeStore(workspace, { trackWork: true })
  try {
    assert.deepEqual(reopened.workRecords(), [])
    assert.equal(reopened.query('SELECT assignee_session_id FROM initiative_items', 'owner').results[0].rows[0].assignee_session_id, 'worker')
  } finally { reopened.close() }
}))

test('aborting evidence review never publishes an agreement', async () => withTempWorkspace(async workspace => {
  const f = fixture(workspace), controller = new AbortController()
  const alignment = new WorkAlignment(f.store, {
    state: id => f.states[id],
    evidence: async () => { controller.abort(new Error('Cancelled review')) },
    changed: async () => { assert.fail('An aborted review must not publish') },
    fresh: async () => { assert.fail('No transition requested') },
    successor: async () => { throw new Error('No successor requested') },
  })
  try {
    const request = change()
    request.definition.evidence = [{ sessionId: worker, physicalId: 'synthetic.0', kind: 'user', id: 'input', quote: 'Both outcomes' }]
    await assert.rejects(alignment.execute({ kind: 'user' }, 'update', undefined, undefined, request, controller.signal), /Cancelled review/)
    assert.deepEqual(f.store.workRecords(), [])
  } finally { f.store.close() }
}))
