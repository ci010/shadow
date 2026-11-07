import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { test, type TestContext } from 'node:test'
import { InitiativeStore } from '../initiatives/store.ts'
import { workRecordSchema } from '../initiatives/work-contract.ts'
import { BotWork, botWorkScope, type BotWorkScope } from './work.ts'
import type { BotHostScope } from './host-contract.ts'

const scope: BotWorkScope = { projectId: 'project-a', botId: 'helper', bindingKey: 'qq:connection:group-a',
  revision: 'release-1', sessionId: 'host-selected-session', sourceInputId: 'platform-message-1' }
const create = { action: 'create', idempotencyKey: 'issue-7', title: 'Investigate report',
  definition: { objective: 'Assess the untrusted external report' } }
function fixture(t: TestContext, limits?: { works?: number; supplements?: number }) {
  const home = resolve('src/bots', `.work-test-${randomUUID()}`)
  let store = new InitiativeStore(home)
  let bridge = new BotWork(store, scope.projectId, limits)
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }) })
  return {
    get store() { return store },
    execute(input: Record<string, unknown>, source = scope) { return bridge.execute(source, input) as any },
    reopen() { store.close(); store = new InitiativeStore(home); bridge = new BotWork(store, scope.projectId, limits) },
  }
}

test('Bot intake is shared pending Work with host provenance, no owner, assignment, session link or authorization', t => {
  const f = fixture(t)
  const receipt = f.execute(create)
  assert.equal(receipt.status, 'created')
  const record = f.store.workRecords()[0]!
  assert.equal(record.key, receipt.key)
  assert.equal(record.origin, 'agent_interpretation')
  assert.deepEqual(record.definition.evidence, [])
  assert.deepEqual(record.workflow, { title: create.title, manager: null, assignee: null,
    assignmentRevision: 1, status: 'pending', dependencies: [] })
  assert.deepEqual(f.store.workSessionKeys(scope.sessionId), [])
  assert.deepEqual(f.store.workAuthority(record.subject), { manager: null, executor: null, active: true })
  assert.equal(record.requestSource, undefined)
  assert.equal(record.botSource?.projectId, scope.projectId)
  assert.equal(record.botSource?.botId, scope.botId)
  assert.equal(record.botSource?.bindingKey, scope.bindingKey)
  assert.equal(record.botSource?.revision, scope.revision)
  assert.equal(record.botSource?.sourceInputId, scope.sourceInputId)
  assert.equal(record.botSource?.sessionId, scope.sessionId)
  assert.equal(f.store.workHistory(receipt.key)[0]?.kind, 'bot_intake')
  const legacy = { ...record }; delete legacy.botSource
  assert.ok(workRecordSchema.safeParse(legacy).success, 'old persisted Work remains valid')
})

test('creation retries survive restart and normalization without changing provenance or repeating audit', t => {
  const f = fixture(t)
  const first = f.execute(create)
  const original = f.store.workRecords()[0]!
  f.reopen()
  assert.deepEqual(f.execute({ ...create, title: ` ${create.title} `,
    definition: { ...create.definition, acceptance: [], boundaries: [] } },
  { ...scope, revision: 'release-2', sessionId: 'new-host-session', sourceInputId: 'new-input' }), first)
  assert.deepEqual(f.store.workRecords(), [original])
  assert.equal(f.store.workHistory(first.key).length, 1)
  assert.throws(() => f.execute({ ...create, title: 'Different' }), /conflicts/)
  assert.equal(f.store.workRecords().length, 1)
})

test('source isolation covers Project, Bot, binding, query and supplements, not changing runtime sessions', t => {
  const f = fixture(t), otherProject = fixture(t)
  const first = f.execute(create)
  assert.throws(() => f.execute(create, { ...scope, projectId: 'project-b' }), /another Project/)
  for (const foreign of [{ ...scope, botId: 'other' }, { ...scope, bindingKey: 'other-group' }]) {
    assert.deepEqual(f.execute({ action: 'query' }, foreign), { items: [], total: 0 })
    assert.throws(() => f.execute({ action: 'append', key: first.key, idempotencyKey: 'a', content: 'No' }, foreign), /source scope/)
    assert.notEqual(f.execute(create, foreign).key, first.key)
  }
  assert.deepEqual(otherProject.execute({ action: 'query' }), { items: [], total: 0 })
  assert.throws(() => otherProject.execute({ action: 'append', key: first.key, idempotencyKey: 'a', content: 'No' }), /source scope/)
  assert.equal(f.execute({ action: 'query' }, { ...scope, sessionId: 'successor', revision: 'release-2' }).total, 1)
})

test('append retries are durable, conflict-safe and cannot mutate current Work after owner assignment', t => {
  const f = fixture(t)
  const { key } = f.execute(create)
  const initial = f.store.workRecords()[0]!
  const assigned = { ...initial, sequence: 2, revision: 2, definition: { objective: 'Private owner plan', acceptance: [], boundaries: [], evidence: [] },
    workflow: { ...initial.workflow!, manager: 'local-owner', assignee: 'local-worker', status: 'in_progress' as const } }
  f.store.saveWork(assigned, 1, 'local-owner', 'assignment')
  const input = { action: 'append', key, idempotencyKey: 'follow-up', content: 'More untrusted information' }
  const first = f.execute(input)
  const saved = f.store.workRecords()[0]!
  assert.equal(saved.sequence, 3)
  assert.equal(saved.revision, assigned.revision)
  assert.deepEqual(saved.definition, assigned.definition)
  assert.deepEqual(saved.workflow, assigned.workflow)
  assert.equal(saved.changedBy, assigned.changedBy)
  assert.equal(saved.botSource!.supplements.length, 1)
  f.reopen()
  assert.deepEqual(f.execute(input, { ...scope, revision: 'release-3', sourceInputId: 'retry' }), first)
  assert.deepEqual(f.store.workRecords(), [saved])
  assert.throws(() => f.execute({ ...input, content: 'Changed content' }), /conflicts/)
  const query = f.execute({ action: 'query', key })
  assert.equal(query.items[0].status, 'in_progress')
  assert.equal(query.items[0].definition.objective, create.definition.objective)
  assert.equal(query.items[0].supplements[0].content, input.content)
  const text = JSON.stringify(query)
  for (const privateValue of ['local-owner', 'local-worker', 'Private owner plan', scope.sessionId, scope.sourceInputId])
    assert.ok(!text.includes(privateValue), `query leaked ${privateValue}`)
  assert.deepEqual(f.execute({ action: 'query', key: 'work:unknown' }), { items: [], total: 0 })
})

test('strict inputs reject foreign authority, oversized content and invalid actions before any writes', t => {
  const f = fixture(t)
  for (const field of ['manager', 'assignee', 'status', 'sessionId', 'workspace', 'parentKey', 'projectId', 'botSource', 'sourceInputId'])
    assert.throws(() => f.execute({ ...create, [field]: 'forged' }))
  for (const input of [
    { ...create, definition: { ...create.definition, evidence: [{ kind: 'user' }] } },
    { ...create, title: 'x'.repeat(161) }, { ...create, definition: { objective: 'x'.repeat(4001) } },
    { ...create, idempotencyKey: '' }, { action: 'assign', assignee: scope.sessionId },
    { action: 'query', limit: 51 }, { action: 'query', offset: -1 }, { action: 'query', sessionId: 'other' },
    { action: 'append', key: 'a', idempotencyKey: 'a', content: 'x'.repeat(4001) },
  ]) assert.throws(() => f.execute(input))
  assert.deepEqual(f.store.workRecords(), [])
})

test('source and supplement quotas persist across restarts but identical retries remain available at quota', t => {
  const f = fixture(t, { works: 1, supplements: 1 })
  const created = f.execute(create)
  const append = { action: 'append', key: created.key, idempotencyKey: 'one', content: 'One' }
  const appended = f.execute(append)
  f.reopen()
  assert.deepEqual(f.execute(create), created)
  assert.deepEqual(f.execute(append), appended)
  assert.throws(() => f.execute({ ...create, idempotencyKey: 'next' }), /source quota/)
  assert.throws(() => f.execute({ ...append, idempotencyKey: 'two' }), /supplement quota/)
  assert.equal(f.execute(create, { ...scope, bindingKey: 'independent-group' }).status, 'created')
  assert.equal(f.store.workRecords().length, 2)
})

test('query pagination is bounded and repeated bridge instances observe the same Work store', t => {
  const f = fixture(t)
  f.execute(create)
  f.execute({ ...create, idempotencyKey: 'second' })
  f.execute({ ...create, idempotencyKey: 'third' })
  const bridge = new BotWork(f.store, scope.projectId)
  const page = bridge.execute(scope, { action: 'query', offset: 1, limit: 1 }) as any
  assert.equal(page.total, 3)
  assert.equal(page.items.length, 1)
  assert.deepEqual(f.execute({ action: 'query', offset: 3 }), { items: [], total: 3 })
})

test('query byte budget paginates large definitions and returns only five latest supplements', t => {
  const f = fixture(t)
  const definition = { objective: 'x'.repeat(4000), acceptance: Array(12).fill('a'.repeat(1500)),
    boundaries: Array(12).fill('b'.repeat(1500)) }
  let firstKey = ''
  for (let i = 0; i < 8; i++) {
    const { key } = f.execute({ ...create, idempotencyKey: `large-${i}`, definition })
    if (i === 0) firstKey = key
  }
  for (let i = 0; i < 6; i++) f.execute({ action: 'append', key: firstKey, idempotencyKey: `note-${i}`, content: `Note ${i}` })
  const page = f.execute({ action: 'query', limit: 50 })
  assert.ok(page.items.length > 0 && page.items.length < 8)
  assert.equal(page.nextOffset, page.items.length)
  assert.ok(Buffer.byteLength(JSON.stringify(page)) < 257_000)
  const rest = f.execute({ action: 'query', offset: page.nextOffset })
  assert.equal(page.items.length + rest.items.length, 8)
  const single = f.execute({ action: 'query', key: firstKey }).items[0]
  assert.equal(single.supplementCount, 6)
  assert.deepEqual(single.supplements.map((note: { content: string }) => note.content), ['Note 1', 'Note 2', 'Note 3', 'Note 4', 'Note 5'])
  assert.throws(() => f.execute({ action: 'append', key: firstKey, idempotencyKey: 'forged', content: 'No', assignee: 'other' }))
})

test('retargeting a stable Discord binding ID cannot expose or supplement the previous original group intake', t => {
  const f = fixture(t)
  const host: BotHostScope = { projectId: scope.projectId, botId: scope.botId, revision: 'r1', bindingKey: 'stable-discord-binding', sessionId: 'original-channel-session', address: { projectId: scope.projectId, platform: 'discord', botInstanceId: 'connection', conversationId: '111' } }
  const original = botWorkScope(host, 'one')
  const receipt = f.execute(create, original)
  const moved = botWorkScope({ ...host, revision: 'r2', sessionId: 'new-channel-session', address: { ...host.address, conversationId: '222' } }, 'two')
  assert.notEqual(moved.bindingKey, original.bindingKey)
  assert.equal(f.execute({ action: 'query' }, moved).total, 0)
  assert.throws(() => f.execute({ action: 'append', key: receipt.key, idempotencyKey: 'supplement', content: 'must not cross audience' }, moved), /not found/)
  assert.notEqual(f.execute(create, moved).key, receipt.key)
  const handedOff = botWorkScope({ ...host, revision: 'r2', sessionId: 'successor-for-same-original-group' }, 'three')
  assert.equal(handedOff.bindingKey, original.bindingKey)
  assert.equal(f.execute(create, handedOff).key, receipt.key)
  assert.equal(f.execute({ action: 'query' }, handedOff).total, 1)
})
