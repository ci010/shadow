import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { test } from 'node:test'
import { YieldError, YieldManager } from './yield.ts'
import type { SessionState } from './session-store.ts'
import type { YieldPolicy, YieldQuestion, YieldRequest } from './yield-contract.ts'

const question = (): YieldQuestion => ({
  question: 'Which approach?', options: ['Continue', 'Change', 'Stop'], defaultOption: 'Continue',
})
const code = (expected: YieldError['code']) => (error: unknown) => error instanceof YieldError && error.code === expected
const signal = () => new AbortController().signal

test('channel decisions bind the initiating human, not anyone who can see or quote the request', async () => {
  const state: SessionState = { sessionId: 'discord:room', segmentIndex: 0 }
  const manager = new YieldManager({
    getState: id => id === state.sessionId ? state : undefined,
    getPolicy: () => ({ timeoutMs: null }),
    notifyUser: async () => {}, notifyParent: async () => {},
  })
  const user = { channel: 'discord', senderId: 'alice' }
  const waiting = manager.ask(state.sessionId, question(), signal(), user)
  user.senderId = 'bob'
  const request = manager.get(state.sessionId)!
  assert.throws(() => manager.answerChannel(state.sessionId, request.id, 'Continue', 'discord', 'bob'), code('forbidden'))
  assert.throws(() => manager.cancelChannel(state.sessionId, request.id, 'discord', 'bob'), code('forbidden'))
  assert.throws(() => manager.answerChannel(state.sessionId, request.id, 'Continue', 'qq', 'alice'), code('forbidden'))
  assert.throws(() => manager.answerChannel('discord:other', request.id, 'Continue', 'discord', 'alice'), code('forbidden'))
  assert.equal(manager.get(state.sessionId)?.id, request.id)
  manager.answerChannel(state.sessionId, request.id, 'Change', 'discord', 'alice')
  assert.equal((await waiting).option, 'Change')
  assert.throws(() => manager.answerChannel(state.sessionId, request.id, 'Change', 'discord', 'alice'), code('not_found'))
  await assert.rejects(manager.ask(state.sessionId, question(), signal()), code('forbidden'))
})

test('expired channel controls cannot override the configured default', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 })
  const manager = new YieldManager({
    getState: sessionId => ({ sessionId, segmentIndex: 0 }),
    getPolicy: () => ({ timeoutMs: 10 }),
    notifyUser: async () => {}, notifyParent: async () => {},
  })
  const waiting = manager.ask('feishu:room', question(), signal(), { channel: 'feishu', senderId: 'alice' })
  const id = manager.get('feishu:room')!.id
  t.mock.timers.tick(10)
  assert.equal((await waiting).answeredBy, 'timeout')
  assert.throws(() => manager.cancelChannel('feishu:room', id, 'feishu', 'alice'), code('not_found'))
})

function fixture(overrides: {
  notifyUser?: (request: YieldRequest) => Promise<void>
  notifyParent?: (request: YieldRequest) => Promise<void>
} = {}) {
  const states = new Map<string, SessionState>([
    ['root', { sessionId: 'root', segmentIndex: 0 }],
    ['parent', { sessionId: 'parent', segmentIndex: 0 }],
    ['other', { sessionId: 'other', segmentIndex: 0 }],
    ['child', { sessionId: 'child', segmentIndex: 0, parent: { id: 'parent' }, reportTo: 'other' }],
    ['sibling', { sessionId: 'sibling', segmentIndex: 0, parent: { id: 'parent' } }],
  ])
  let policy: YieldPolicy = { timeoutMs: null }
  const users: YieldRequest[] = []
  const parents: YieldRequest[] = []
  const manager = new YieldManager({
    getState: id => states.get(id), getPolicy: () => policy,
    notifyUser: overrides.notifyUser ?? (async request => { users.push(request) }),
    notifyParent: overrides.notifyParent ?? (async request => { parents.push(request) }),
  })
  return { manager, states, users, parents, setPolicy: (value: YieldPolicy) => { policy = value } }
}

test('root waits for its human; child uses real stored parent, never reportTo', async () => {
  const f = fixture()
  f.states.get('root')!.reportTo = 'other'
  const root = f.manager.ask('root', question(), signal())
  const child = f.manager.ask('child', question(), signal())
  assert.deepEqual(f.users[0]?.recipient, { kind: 'user', sessionId: 'root' })
  assert.deepEqual(f.parents[0]?.recipient, { kind: 'parent', sessionId: 'parent' })
  assert.equal(f.users.length, 1)
  assert.equal(f.parents.length, 1)
  const request = f.manager.get('root')!
  assert.match(request.id, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)
  assert.notEqual(request.id, f.parents[0]!.id)
  const receipt = f.manager.answerUser('root', request.id, 'Change')
  assert.equal(await root, receipt)
  assert.ok(Object.isFrozen(receipt))
  assert.equal(receipt.answeredBy, 'user')
  assert.ok(Number.isFinite(Date.parse(receipt.answeredAt)))
  f.manager.answerParent('parent', f.parents[0]!.id, 'Stop')
  assert.equal((await child).answeredBy, 'parent')
  assert.equal(f.manager.get('root'), null)
  assert.equal(f.manager.get('child'), null)
})

test('publishes waiting state before invoking delivery, allowing immediate answers', async () => {
  let manager: YieldManager
  let receipt
  const f = fixture({
    notifyUser: async request => {
      assert.deepEqual(manager.get('root'), request)
      receipt = manager.answerUser('root', request.id, 'Stop')
    },
  })
  manager = f.manager
  assert.equal(await manager.ask('root', question(), signal()), receipt)
})

test('question, recipient and policy are immutable snapshots', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 })
  const f = fixture()
  const input = question()
  const policy = { timeoutMs: 100 }
  f.setPolicy(policy)
  const waiting = f.manager.ask('child', input, signal())
  input.question = 'Changed'
  input.options[0] = 'Mutated'
  input.defaultOption = 'Mutated'
  policy.timeoutMs = 1
  f.setPolicy({ timeoutMs: null })
  const request = f.manager.get('child')!
  assert.equal(request.question, 'Which approach?')
  assert.equal(request.options[0], 'Continue')
  assert.equal(request.deadline, new Date(1100).toISOString())
  assert.ok(Object.isFrozen(request))
  assert.ok(Object.isFrozen(request.options))
  assert.ok(Object.isFrozen(request.recipient))
  assert.throws(() => { request.options[0] = 'Mutated' }, TypeError)
  assert.throws(() => { f.parents[0]!.recipient.sessionId = 'other' }, TypeError)
  t.mock.timers.tick(99)
  assert.ok(f.manager.get('child'))
  t.mock.timers.tick(1)
  assert.deepEqual(await waiting, { requestId: request.id, option: 'Continue', answeredBy: 'timeout', answeredAt: new Date(1100).toISOString() })
})

test('null timeout never automatically answers and retains no abort listener after answer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture()
  const controller = new AbortController()
  const waiting = f.manager.ask('root', question(), controller.signal)
  let settled = false
  void waiting.then(() => { settled = true })
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1)
  t.mock.timers.tick(2_147_483_647)
  await Promise.resolve()
  assert.equal(settled, false)
  assert.equal(f.manager.get('root')!.deadline, null)
  f.manager.answerUser('root', f.users[0]!.id, 'Stop')
  await waiting
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})

test('one waiter per session, independent sessions and stale/replayed answers', async () => {
  const f = fixture()
  const first = f.manager.ask('root', question(), signal())
  await assert.rejects(f.manager.ask('root', question(), signal()), code('conflict'))
  const independent = f.manager.ask('other', question(), signal())
  const oldId = f.users[0]!.id
  f.manager.answerUser('root', oldId, 'Continue')
  await first
  assert.throws(() => f.manager.answerUser('root', oldId, 'Continue'), code('not_found'))
  const next = f.manager.ask('root', question(), signal())
  assert.notEqual(f.manager.get('root')!.id, oldId)
  assert.throws(() => f.manager.answerUser('root', oldId, 'Stop'), code('not_found'))
  assert.ok(f.manager.get('root'))
  f.manager.answerUser('root', f.manager.get('root')!.id, 'Change')
  f.manager.answerUser('other', f.manager.get('other')!.id, 'Stop')
  await Promise.all([next, independent])
})

test('only same-session human and exact stored parent may answer; invalid options do not consume', async () => {
  const f = fixture()
  const root = f.manager.ask('root', question(), signal())
  const child = f.manager.ask('child', question(), signal())
  const rootId = f.users[0]!.id
  const childId = f.parents[0]!.id
  for (const answer of [
    () => f.manager.answerUser('other', rootId, 'Continue'),
    () => f.manager.answerUser('child', childId, 'Continue'),
    () => f.manager.answerUser('parent', childId, 'Continue'),
    () => f.manager.answerParent('root', rootId, 'Continue'),
    () => f.manager.answerParent('other', childId, 'Continue'),
    () => f.manager.answerParent('sibling', childId, 'Continue'),
    () => f.manager.answerParent('child', childId, 'Continue'),
  ]) assert.throws(answer, code('forbidden'))
  for (const option of ['', 'continue', ' Continue', 'Continue ', 1, null]) {
    assert.throws(() => f.manager.answerUser('root', rootId, option as string), code('invalid_request'))
    assert.throws(() => f.manager.answerParent('parent', childId, option as string), code('invalid_request'))
  }
  assert.equal(f.manager.get('root')!.id, rootId)
  assert.equal(f.manager.get('child')!.id, childId)
  f.manager.answerUser('root', rootId, 'Continue')
  f.manager.answerParent('parent', childId, 'Continue')
  await Promise.all([root, child])
  assert.throws(() => f.manager.answerParent('parent', childId, 'Stop'), code('not_found'))
})

test('changed or deleted lineage forbids answers without transferring a request', async () => {
  const f = fixture()
  const child = f.manager.ask('child', question(), signal())
  const id = f.parents[0]!.id
  f.states.get('child')!.parent = { id: 'other' }
  assert.throws(() => f.manager.answerParent('parent', id, 'Stop'), code('forbidden'))
  assert.throws(() => f.manager.answerParent('other', id, 'Stop'), code('forbidden'))
  delete f.states.get('child')!.parent
  assert.throws(() => f.manager.answerUser('child', id, 'Stop'), code('forbidden'))
  f.states.get('child')!.parent = { id: 'parent' }
  f.states.delete('parent')
  assert.throws(() => f.manager.answerParent('parent', id, 'Stop'), code('forbidden'))
  f.states.delete('child')
  assert.throws(() => f.manager.answerParent('parent', id, 'Stop'), code('forbidden'))
  const rejected = assert.rejects(child, { name: 'AbortError' })
  f.manager.cancelSession('child')
  await rejected

  const root = f.manager.ask('root', question(), signal())
  f.states.get('root')!.parent = { id: 'other' }
  assert.throws(() => f.manager.answerUser('root', f.users[0]!.id, 'Stop'), code('forbidden'))
  const cancelled = assert.rejects(root, { name: 'AbortError' })
  f.manager.stop()
  await cancelled
})

test('user cancellation requires a current root request and cannot cancel a child or replacement', async () => {
  const f = fixture()
  const root = f.manager.ask('root', question(), signal())
  const child = f.manager.ask('child', question(), signal())
  const rootId = f.users[0]!.id
  const childId = f.parents[0]!.id
  assert.throws(() => f.manager.cancelUser('other', rootId), code('forbidden'))
  assert.throws(() => f.manager.cancelUser('child', childId), code('forbidden'))
  assert.throws(() => f.manager.cancelUser('parent', childId), code('forbidden'))
  const rejected = assert.rejects(root, { name: 'AbortError' })
  f.manager.cancelUser('root', rootId)
  await rejected
  const replacement = f.manager.ask('root', question(), signal())
  assert.throws(() => f.manager.cancelUser('root', rootId), code('not_found'))
  assert.ok(f.manager.get('root'))
  f.manager.answerUser('root', f.manager.get('root')!.id, 'Change')
  f.manager.answerParent('parent', childId, 'Stop')
  await Promise.all([replacement, child])
})

test('cancelUser cancels only the exact waiter, never its addressed children or a timeout default', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture()
  f.setPolicy({ timeoutMs: 10 })
  const controller = new AbortController()
  const parent = f.manager.ask('parent', question(), controller.signal)
  const child = f.manager.ask('child', question(), signal())
  const parentId = f.manager.get('parent')!.id
  const childId = f.manager.get('child')!.id
  const rejected = assert.rejects(parent, { name: 'AbortError', message: 'Yield cancelled by user.' })
  f.manager.cancelUser('parent', parentId)
  await rejected
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  assert.equal(f.manager.get('parent'), null)
  assert.equal(f.manager.get('child')!.id, childId)
  t.mock.timers.tick(9)
  assert.equal(f.manager.get('child')!.id, childId)
  f.manager.answerParent('parent', childId, 'Change')
  t.mock.timers.tick(100)
  assert.equal((await child).answeredBy, 'parent')
  assert.throws(() => f.manager.cancelUser('parent', parentId), code('not_found'))
  assert.throws(() => f.manager.answerUser('parent', parentId, 'Continue'), code('not_found'))
})

test('unknown, orphaned and cyclic sessions fail explicitly without human fallback', async () => {
  const f = fixture()
  await assert.rejects(f.manager.ask('missing', question(), signal()), code('not_found'))
  f.states.get('child')!.parent = { id: 'missing' }
  await assert.rejects(f.manager.ask('child', question(), signal()), code('unavailable'))
  f.states.get('child')!.parent = { id: 'child' }
  await assert.rejects(f.manager.ask('child', question(), signal()), code('unavailable'))
  f.states.get('child')!.parent = { id: 'parent' }
  f.states.get('parent')!.parent = { id: 'child' }
  await assert.rejects(f.manager.ask('child', question(), signal()), code('unavailable'))
  f.states.get('parent')!.parent = { id: 'missing' }
  await assert.rejects(f.manager.ask('child', question(), signal()), code('unavailable'))
  f.states.get('child')!.parent = { id: '' }
  await assert.rejects(f.manager.ask('child', question(), signal()), code('unavailable'))
  assert.deepEqual(f.users, [])
  assert.deepEqual(f.parents, [])
  assert.equal(f.manager.get('child'), null)
})

test('manager runtime validation rejects malformed questions and policies before delivery', async () => {
  const f = fixture()
  for (const invalid of [
    null, {}, { ...question(), question: ' ' }, { ...question(), options: ['A', 'B'] },
    { ...question(), options: ['A', 'B', 'C', 'D'] }, { ...question(), options: ['A', 'A', 'C'] },
    { ...question(), options: ['A', ' A ', 'C'] }, { ...question(), options: ['A', '', 'C'] },
    { ...question(), defaultOption: 'continue' },
  ]) await assert.rejects(f.manager.ask('root', invalid as YieldQuestion, signal()), code('invalid_request'))
  for (const timeoutMs of [0, -1, 0.5, Infinity, NaN, 2_147_483_648, '1', undefined]) {
    f.setPolicy({ timeoutMs } as YieldPolicy)
    await assert.rejects(f.manager.ask('root', question(), signal()), code('invalid_request'))
  }
  assert.equal(f.users.length, 0)
  assert.equal(f.manager.get('root'), null)
})

test('already-aborted and later-aborted requests never default and remove listeners', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture()
  f.setPolicy({ timeoutMs: 10 })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(f.manager.ask('root', question(), controller.signal), { name: 'AbortError' })
  assert.equal(f.users.length, 0)
  const later = new AbortController()
  const waiting = f.manager.ask('root', question(), later.signal)
  const rejected = assert.rejects(waiting, { name: 'AbortError' })
  t.mock.timers.tick(9)
  later.abort()
  t.mock.timers.tick(100)
  await rejected
  assert.equal(f.manager.get('root'), null)
  assert.equal(getEventListeners(later.signal, 'abort').length, 0)
  assert.throws(() => f.manager.answerUser('root', f.users[0]!.id, 'Stop'), code('not_found'))
})

test('answer/timeout/cancel races settle once; old timers cannot consume the next request', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture()
  f.setPolicy({ timeoutMs: 10 })
  const controller = new AbortController()
  const first = f.manager.ask('root', question(), controller.signal)
  t.mock.timers.tick(9)
  f.manager.answerUser('root', f.users[0]!.id, 'Change')
  controller.abort()
  const second = f.manager.ask('root', question(), signal())
  t.mock.timers.tick(1)
  assert.ok(f.manager.get('root'))
  assert.equal((await first).answeredBy, 'user')
  t.mock.timers.tick(9)
  assert.equal((await second).answeredBy, 'timeout')
  f.manager.cancelSession('root')
  assert.throws(() => f.manager.answerUser('root', f.users[1]!.id, 'Stop'), code('not_found'))
})

test('cancel and stop clean up every request; stopped manager rejects new asks', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture()
  f.setPolicy({ timeoutMs: 10 })
  const a = new AbortController()
  const b = new AbortController()
  const first = f.manager.ask('root', question(), a.signal)
  const second = f.manager.ask('child', question(), b.signal)
  const firstRejected = assert.rejects(first, { name: 'AbortError', message: 'Deleted.' })
  const secondRejected = assert.rejects(second, { name: 'AbortError' })
  f.manager.cancelSession('root', 'Deleted.')
  f.manager.cancelSession('root')
  f.manager.stop()
  f.manager.stop()
  t.mock.timers.tick(100)
  await Promise.all([firstRejected, secondRejected])
  assert.equal(getEventListeners(a.signal, 'abort').length, 0)
  assert.equal(getEventListeners(b.signal, 'abort').length, 0)
  assert.equal(f.manager.get('root'), null)
  assert.equal(f.manager.get('child'), null)
  await assert.rejects(f.manager.ask('root', question(), signal()), code('unavailable'))
})

test('cancelSession cancels own and addressed requests, including unlisted ephemeral children', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture()
  f.setPolicy({ timeoutMs: 10 })
  const controllers = ['parent', 'child', 'sibling'].map(() => new AbortController())
  const rejected = ['parent', 'child', 'sibling'].map((id, index) => {
    const waiting = f.manager.ask(id, question(), controllers[index]!.signal)
    return assert.rejects(waiting, { name: 'AbortError', message: 'Parent deleted.' })
  })
  const unrelated = f.manager.ask('root', question(), signal())
  assert.equal(f.states.get('parent')!.children, undefined)
  f.states.delete('parent')
  f.manager.cancelSession('parent', 'Parent deleted.')
  await Promise.all(rejected)
  for (const id of ['parent', 'child', 'sibling']) assert.equal(f.manager.get(id), null)
  for (const controller of controllers) assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  assert.ok(f.manager.get('root'))
  f.manager.answerUser('root', f.manager.get('root')!.id, 'Change')
  assert.equal((await unrelated).answeredBy, 'user')
  t.mock.timers.tick(100)
})

test('synchronous throws and asynchronous delivery failures reject and remove waiting state', async () => {
  for (const notify of [
    () => { throw new Error('Delivery unavailable') },
    async () => { throw new Error('Delivery unavailable') },
  ]) {
    const f = fixture({ notifyUser: notify, notifyParent: notify })
    for (const sessionId of ['root', 'child']) {
      const controller = new AbortController()
      await assert.rejects(f.manager.ask(sessionId, question(), controller.signal), error =>
        code('unavailable')(error) && /Delivery unavailable/.test((error as Error).message))
      assert.equal(f.manager.get(sessionId), null)
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
      // A delivery failure must not leave a conflict on the next attempt.
      await assert.rejects(f.manager.ask(sessionId, question(), signal()), code('unavailable'))
    }
  }
})

test('hanging delivery cannot delay an answer or abort; late failure cannot affect a replacement', async () => {
  const delivery = Promise.withResolvers<void>()
  let deliveries = 0
  const f = fixture({ notifyUser: () => ++deliveries <= 2 ? delivery.promise : Promise.resolve() })
  const first = f.manager.ask('root', question(), signal())
  f.manager.answerUser('root', f.manager.get('root')!.id, 'Change')
  assert.equal((await first).option, 'Change')
  const controller = new AbortController()
  const next = f.manager.ask('other', question(), controller.signal)
  const rejected = assert.rejects(next, { name: 'AbortError' })
  controller.abort()
  await rejected
  const replacement = f.manager.ask('root', question(), signal())
  const request = f.manager.get('root')!
  delivery.reject(new Error('Late delivery error'))
  await Promise.resolve()
  assert.equal(f.manager.get('root')!.id, request.id)
  f.manager.answerUser('root', request.id, 'Stop')
  assert.equal((await replacement).option, 'Stop')
  assert.equal(f.manager.get('root'), null)
  assert.equal(f.manager.get('other'), null)
})

test('timeout resolves during hanging delivery, remains final after abort and observes cleanup', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture({ notifyUser: () => new Promise(() => {}) })
  f.setPolicy({ timeoutMs: 10 })
  const controller = new AbortController()
  const waiting = f.manager.ask('root', question(), controller.signal)
  t.mock.timers.tick(10)
  controller.abort()
  assert.equal((await waiting).answeredBy, 'timeout')
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  assert.equal(f.manager.get('root'), null)
})

test('delivery failure before timeout cancels the timer rather than silently choosing default', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const delivery = Promise.withResolvers<void>()
  const f = fixture({ notifyParent: () => delivery.promise })
  f.setPolicy({ timeoutMs: 10 })
  const waiting = f.manager.ask('child', question(), signal())
  const rejected = assert.rejects(waiting, code('unavailable'))
  delivery.reject(new Error('Parent unreachable'))
  await rejected
  t.mock.timers.tick(10)
  assert.equal(f.manager.get('child'), null)
})
