import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { InitiativeStore } from '../initiatives/store.ts'
import type { WorkRecord } from '../initiatives/work-contract.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { WorkAlignment } from './work-alignment.ts'
import { parseWorkPolicy } from './work-policy.ts'
import type { SessionState, SessionStore } from './session-store.ts'
import { JsonlSessionStore } from './session-store-jsonl.ts'
import { SqliteSessionStore } from './session-store-sqlite.ts'
import { Tools, SessionTools } from '../tools/registry.ts'
import type { ExecutionContext } from '../tools/context.ts'
import type { Tool } from '../tools/tool.ts'

const definition = { objective: 'Deliver the assigned document', acceptance: ['Saved and verified'], boundaries: ['No publication'] }
const adoption = { understanding: 'Deliver the assigned document', next: ['Write and verify'] }
const actor = (sessionId: string) => ({ kind: 'session' as const, sessionId })

async function fixture(home: string, store: SessionStore) {
  await store.init()
  const states = new Map<string, SessionState>()
  for (const id of ['owner', 'worker', 'peer']) {
    const state: SessionState = { sessionId: id, segmentIndex: 0, mode: 'session', workPolicy: { mode: 'optional' } }
    states.set(id, state)
    await store.saveState(id, state)
  }
  const work = new InitiativeStore(home, { isSessionKnown: id => states.has(id) })
  work.migrateWorkItems()
  const alignment = new WorkAlignment(work, {
    state: id => states.get(id), evidence: async () => {},
    setPolicy: async (id, policy, validate) => {
      validate()
      const state = states.get(id)!
      await store.saveState(id, { ...state, workPolicy: policy })
      state.workPolicy = policy
    },
    changed: async () => {}, fresh: async () => {}, successor: async () => undefined,
  })
  const tools = new SessionTools(new Tools(home), home)
  const context = (id: string): ExecutionContext => ({
    sessionId: id, physicalSessionId: `${id}.0`, channel: 'web', chatId: id, senderId: 'fixture',
    messageId: 'message', signal: new AbortController().signal, tools, workStamps: alignment.snapshot(id),
  })
  const create = async (owner = 'owner', assignee: string | null = owner, parentKey?: string) =>
    await alignment.execute(actor(owner), 'create', undefined, undefined,
      { title: 'Document', definition, reason: 'Explicit fixture task', assignee, parentKey }) as WorkRecord
  const write: Tool = { name: 'write', description: '', parameters: { type: 'object', properties: {} }, execute: async () => 'saved' }
  const close = async () => { work.close(); await store.close?.() }
  return { states, work, alignment, context, create, write, close }
}

test('Work policy is a validated binding, never an unbound boolean or caller-selected authority field', () => {
  assert.equal(parseWorkPolicy(undefined), undefined)
  assert.deepEqual(parseWorkPolicy({ mode: 'optional' }), { mode: 'optional' })
  for (const value of [null, true, {}, { mode: 'required' }, { mode: 'optional', keys: ['x'] },
    { mode: 'required', keys: [], controllerSessionId: 'owner' },
    { mode: 'required', keys: ['x', 'x'], controllerSessionId: 'owner' },
    { mode: 'required', keys: ['x'], controllerSessionId: ' ' }]) {
    assert.throws(() => parseWorkPolicy(value), /Invalid Work policy/)
  }
})

for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  test(`${Store.name}: optional execution, explicit opt-in and authorized settled opt-out survive reload`, async () => withTempWorkspace(async home => {
    const store = new Store(join(home, 'sessions'))
    const f = await fixture(home, store)
    try {
      assert.deepEqual(f.alignment.snapshot('owner'), [])
      assert.equal(f.alignment.before(f.write, {}, f.context('owner')), undefined)
      const record = await f.create()
      assert.equal(f.alignment.required('owner'), false, 'Tracking and enforcement are independent')
      assert.equal(f.alignment.before(f.write, {}, f.context('owner')), undefined)
      const stale = f.context('owner')
      await f.alignment.execute(actor('owner'), 'policy', record.key, 1, { mode: 'required' })
      assert.throws(() => f.alignment.before(f.write, {}, stale), /basis changed|not adopted/)
      await f.alignment.execute(actor('owner'), 'adopt', record.key, 1, adoption)
      assert.throws(() => f.alignment.before(f.write, {}, stale), /basis changed|not adopted/)
      f.alignment.before(f.write, {}, f.context('owner'))!.finish(false)
      assert.equal((await store.getState('owner'))?.workPolicy?.mode, 'required')
      assert.equal((await store.listAllStates()).owner.workPolicy?.mode, 'required')
      await assert.rejects(f.alignment.execute(actor('peer'), 'policy', undefined, undefined,
        { mode: 'optional', sessionId: 'owner' }), /controller/)
      await assert.rejects(f.alignment.execute(actor('owner'), 'policy', undefined, undefined, { mode: 'optional' }), /Finish or cancel/)
      const current = f.alignment.get(record.key)
      await f.alignment.execute(actor('owner'), 'progress', current.key, current.revision,
        { expectedSequence: current.sequence, status: 'cancelled' })
      await f.alignment.execute(actor('owner'), 'policy', undefined, undefined, { mode: 'optional' })
      assert.deepEqual((await store.getState('owner'))?.workPolicy, { mode: 'optional' })
      assert.deepEqual(f.alignment.snapshot('owner'), [])
      assert.equal(f.alignment.before(f.write, {}, f.context('owner')), undefined)
      assert.equal(f.work.workRecords().length, 1, 'Disabling preserves task history')
      await assert.rejects(store.saveState('owner', { ...f.states.get('owner')!, workPolicy: JSON.parse('{"mode":"required"}') }),
        /Invalid Work policy/)
    } finally { await f.close() }
  }))

  test(`${Store.name}: external bindings cannot be disabled, selected away or escaped by descendants`, async () => withTempWorkspace(async home => {
    const store = new Store(join(home, 'sessions'))
    const f = await fixture(home, store)
    try {
      const root = await f.create('owner', null)
      const binding = { key: root.key, revision: 1 }
      const policy = f.alignment.prepareDelegation('owner', binding, 'session')
      f.states.get('worker')!.workPolicy = policy
      await store.saveState('worker', f.states.get('worker')!)
      assert.throws(() => f.alignment.assertCurrent(f.alignment.snapshot('worker'), 'worker'), /basis changed|not adopted/)
      await f.alignment.bindDelegation('worker', 'owner', binding)
      await f.alignment.execute(actor('worker'), 'adopt', root.key, 1, adoption)
      f.alignment.assertCurrent(f.alignment.snapshot('worker'), 'worker')
      assert.equal(f.alignment.required('owner'), false)
      await assert.rejects(f.alignment.execute(actor('worker'), 'policy', undefined, undefined, { mode: 'optional' }), /controller/)
      const unrelated = await f.create('worker')
      await f.alignment.execute(actor('worker'), 'select', unrelated.key, 1, {})
      assert(f.alignment.snapshot('worker').some(stamp => stamp.key === root.key))
      assert.throws(() => f.alignment.prepareDelegation('worker', undefined, 'session'), /explicit descendant/)
      const unrelatedPeer = await f.create('worker', null)
      assert.throws(() => f.alignment.prepareDelegation('worker', { key: unrelatedPeer.key, revision: 1 }, 'session'), /escape/)
      const descendant = await f.create('worker', null, root.key)
      const childPolicy = f.alignment.prepareDelegation('worker', { key: descendant.key, revision: 1 }, 'session')
      f.states.get('peer')!.workPolicy = childPolicy
      await f.alignment.bindDelegation('peer', 'worker', { key: descendant.key, revision: 1 })
      await f.alignment.execute(actor('peer'), 'adopt', descendant.key, 1, adoption)
      f.alignment.assertCurrent(f.alignment.snapshot('peer'), 'peer')
      f.alignment.assertDelegatedInput('worker', 'peer')
      f.alignment.assertDelegatedInput('worker', 'owner')
      assert.throws(() => f.alignment.assertDelegatedInput('peer', 'owner'), /recipient bound/)
      const current = f.alignment.get(root.key)
      await f.alignment.execute(actor('worker'), 'progress', root.key, 1,
        { expectedSequence: current.sequence, status: 'blocked', blockedReason: 'Owner approval pending', blockedScope: 'work' })
      assert.throws(() => f.alignment.assertCurrent(f.alignment.snapshot('peer'), 'peer'), /blocked/)
      const effect = crypto.randomUUID()
      f.work.startWorkEffect(effect, 'peer', 'write', f.alignment.snapshot('peer'))
      await assert.rejects(f.alignment.execute(actor('peer'), 'policy', undefined, undefined, { mode: 'optional' }), /controller/)
      assert.equal((await store.getState('worker'))?.workPolicy?.mode, 'required')
      assert.equal(f.work.workEffects().length, 1)
    } finally { await f.close() }
  }))

  test(`${Store.name}: a temporary binding constrains only its execution and inherits across nested calls`, async () => withTempWorkspace(async home => {
    const store = new Store(join(home, 'sessions'))
    const f = await fixture(home, store)
    try {
      const record = await f.create()
      assert.throws(() => f.alignment.prepareDelegation('owner', { key: record.key, revision: 1 }, 'task'), /adopted/)
      await f.alignment.execute(actor('owner'), 'adopt', record.key, 1, adoption)
      const policy = f.alignment.prepareDelegation('owner', { key: record.key, revision: 1 }, 'task')
      const child: SessionState = { sessionId: 'child', segmentIndex: 0, mode: 'task', parentSessionId: 'owner', workPolicy: policy }
      f.states.set('child', child)
      await store.saveState('child', child)
      f.states.set('call', { sessionId: 'call', segmentIndex: 0, mode: 'call', parentSessionId: 'child', workPolicy: { mode: 'optional' } })
      assert.equal(f.alignment.required('owner'), false)
      assert.equal(f.alignment.required('child'), true)
      assert.equal(f.alignment.required('call'), true, 'Even a stale optional child state cannot downgrade its required parent')
      f.alignment.assertCurrent(f.alignment.snapshot('call'), 'call')
      assert.deepEqual((await store.getState('child'))?.workPolicy, policy)
      assert.throws(() => f.alignment.before({ ...f.write, name: 'a2a_send' }, {}, f.context('child')), /cannot preserve/)
      assert.throws(() => f.alignment.before({ ...f.write, name: 'cron_add' }, { session: 'fresh' }, f.context('child')), /cannot preserve/)
    } finally { await f.close() }
  }))

  test(`${Store.name}: legacy assigned Work retains enforcement without changing untracked sessions`, async () => withTempWorkspace(async home => {
    const store = new Store(join(home, 'sessions'))
    const f = await fixture(home, store)
    try {
      delete f.states.get('worker')!.workPolicy
      delete f.states.get('peer')!.workPolicy
      await store.saveState('worker', f.states.get('worker')!)
      const record = await f.create('owner', 'worker')
      assert.equal(f.alignment.required('worker'), true)
      assert.equal(f.alignment.required('peer'), false)
      assert.equal((await store.getState('worker'))?.workPolicy, undefined, 'Absence remains distinguishable on disk')
      await assert.rejects(f.alignment.execute(actor('worker'), 'policy', undefined, undefined, { mode: 'optional' }), /controller/)
      await f.alignment.execute(actor('worker'), 'adopt', record.key, 1, adoption)
      f.alignment.assertCurrent(f.alignment.snapshot('worker'), 'worker')
    } finally { await f.close() }
  }))
}
