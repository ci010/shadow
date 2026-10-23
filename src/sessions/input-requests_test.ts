import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { InputRequests } from './input-requests.ts'
import type { InputRecord } from './input-request.ts'
import type { SessionState } from './session-store.ts'
import type { ExecutionContext } from '../tools/context.ts'

function fixture(write?: (record: InputRecord) => Promise<void>, currentContext?: () => boolean) {
  const states: Record<string, SessionState> = {
    'web:root': { sessionId: 'web:root', segmentIndex: 0, mode: 'session' },
    child: { sessionId: 'child', segmentIndex: 0, mode: 'task', parentSessionId: 'web:root' },
    'web:other': { sessionId: 'web:other', segmentIndex: 0, mode: 'session' },
    'qq:group:one': { sessionId: 'qq:group:one', segmentIndex: 0, mode: 'session' },
    'a2a:caller': { sessionId: 'a2a:caller', segmentIndex: 0, mode: 'session' },
    call: { sessionId: 'call', segmentIndex: 0, mode: 'call' },
  }
  const records: InputRecord[] = []
  let timeout: number | null = null
  let decision = false
  let failDelivery = false
  const inputs = new InputRequests({
    currentContext,
    getState: id => states[id], assertAccess: () => {}, hasDecision: () => decision,
    timeout: () => timeout, changed: () => {},
    write: async record => { await write?.(record); records.push(structuredClone(record)) },
    notify: async () => { if (failDelivery) throw new Error('Delivery unavailable') },
  })
  const context = (sessionId = 'web:root', signal = new AbortController().signal) => ({
    sessionId, signal, channel: sessionId.split(':')[0], inputSource: 'user', senderId: 'alice', toolCallId: 'ask-call',
  }) as ExecutionContext
  return { inputs, states, records, context, deadline: () => { timeout = 5 }, decision: () => { decision = true },
    failDelivery: () => { failDelivery = true } }
}

test('input context is revalidated after persistence before any question is delivered', async () => {
  const saved = Promise.withResolvers<void>()
  let current = true
  const f = fixture(async record => { if (!record.answer && !record.closed) await saved.promise }, () => current)
  const pending = f.inputs.ask('Which release report?', f.context(), { originKey: 'goal', decisionKey: 'goal', path: [
    { key: 'goal', revision: 1, title: 'Release impact', objective: 'Measure token usage', kind: 'goal', origin: 'human' },
  ] })
  const rejected = assert.rejects(pending, /goal path changed while opening/)
  assert.equal(f.inputs.get('web:root'), null)
  current = false; saved.resolve()
  await rejected
  await f.inputs.settled()
  assert.equal(f.inputs.get('web:root'), null)
  assert.equal(f.records.at(-1)?.closed?.status, 'failed')
})

test('plain input waits, preserves request identity and never produces an approval', async () => {
  const f = fixture()
  const result = f.inputs.ask('Which path?', f.context())
  await setImmediate()
  const request = f.inputs.get('web:root')!
  assert.equal(request.kind, 'input')
  assert.equal('options' in request, false)
  assert.equal('defaultOption' in request, false)
  assert.equal('brief' in request, false)
  const answer = await f.inputs.replyUser('web:root', request.id, '  C:\\fixture  ')
  assert.deepEqual(await result, answer)
  assert.equal(answer.text, 'C:\\fixture')
  assert.equal('approved' in answer, false)
  assert.equal(f.records.length, 2)
  assert.equal(f.records[1].answer?.requestId, request.id)
  assert.equal(f.inputs.get('web:root'), null)
  assert.throws(() => f.inputs.replyUser('web:root', request.id, 'again'), /no longer pending/)
})

test('only the stored parent replies; references cannot transfer answer authority', async () => {
  const f = fixture()
  const result = f.inputs.ask('Which format?', f.context('child'))
  await setImmediate()
  const request = f.inputs.get('child')!
  assert.throws(() => f.inputs.replyParent('web:other', request.id, 'json'), /stored parent/)
  assert.throws(() => f.inputs.replyUser('child', request.id, 'json'), /root session/)
  f.states.child.parentSessionId = 'web:other'
  assert.throws(() => f.inputs.replyParent('web:root', request.id, 'json'), /stored parent/)
  f.states.child.parentSessionId = 'web:root'
  await f.inputs.replyParent('web:root', request.id, 'json')
  assert.equal((await result).answeredBy, 'parent')
})

test('channel input binds the initiating human and rejects event-only requests', async () => {
  const f = fixture()
  await assert.rejects(f.inputs.ask('Path?', { ...f.context('qq:group:one'), inputSource: 'event' }), /initiating human/)
  const result = f.inputs.ask('Path?', f.context('qq:group:one'))
  await setImmediate()
  const request = f.inputs.get('qq:group:one')!
  assert.throws(() => f.inputs.replyUser(request.sessionId, request.id, 'path', 'qq', 'bob'), /initiating channel user/)
  await f.inputs.replyUser(request.sessionId, request.id, 'path', 'qq', 'alice')
  assert.equal((await result).text, 'path')
})

test('A2A input binds the protocol caller without granting user or parent authority', async () => {
  const f = fixture()
  const reply = Promise.withResolvers<string>()
  const unbind = f.inputs.bindCaller('a2a:caller', async question => { assert.equal(question, 'Language?'); return reply.promise })
  const result = f.inputs.ask('Language?', f.context('a2a:caller'))
  await setImmediate()
  const request = f.inputs.get('a2a:caller')!
  assert.equal(request.recipient.kind, 'caller')
  assert.throws(() => f.inputs.replyUser(request.sessionId, request.id, 'TypeScript'), /root session/)
  assert.throws(() => f.inputs.replyParent('web:root', request.id, 'TypeScript'), /stored parent/)
  reply.resolve('TypeScript')
  assert.equal((await result).answeredBy, 'caller')
  unbind()
  await assert.rejects(f.inputs.ask('Again?', f.context('a2a:caller')), /no longer available/)
})

test('timeouts, cancellation and failed delivery do not invent answers', async () => {
  for (const action of ['timeout', 'abort', 'delivery', 'stop'] as const) {
    const f = fixture()
    const controller = new AbortController()
    if (action === 'timeout') f.deadline()
    if (action === 'delivery') f.failDelivery()
    const pending = f.inputs.ask('Required text?', f.context('web:root', controller.signal))
    const rejected = assert.rejects(pending)
    if (action === 'abort') controller.abort()
    if (action === 'stop') f.inputs.stop()
    await rejected
    await f.inputs.settled()
    assert.equal(f.inputs.get('web:root'), null)
    assert.equal(f.records.some(record => record.answer), false)
    assert.ok(f.records.at(-1)?.closed)
  }
})

test('conflicting decisions, duplicate asks, malformed input and leaf calls are rejected', async () => {
  const f = fixture()
  await assert.rejects(f.inputs.ask(' ', f.context()), /question/)
  await assert.rejects(f.inputs.ask('x'.repeat(4001), f.context()), /question/)
  await assert.rejects(f.inputs.ask('Text?', f.context('call')), /Leaf calls/)
  const pending = f.inputs.ask('Path?', f.context())
  await setImmediate()
  await assert.rejects(f.inputs.ask('Another?', f.context()), /pending question/)
  const request = f.inputs.get('web:root')!
  assert.throws(() => f.inputs.replyUser('web:root', request.id, ''), /1-4000/)
  await f.inputs.replyUser('web:root', request.id, 'done')
  await pending
  f.decision()
  await assert.rejects(f.inputs.ask('Blocked?', f.context()), /pending question/)
})

test('closing caller input aborts its protocol wait before another question can be sent', async () => {
  for (const close of ['timeout', 'stop', 'unbind'] as const) {
    const f = fixture()
    if (close === 'timeout') f.deadline()
    let signal: AbortSignal | undefined
    const unbind = f.inputs.bindCaller('a2a:caller', (_question, value) => {
      signal = value
      return new Promise((_resolve, reject) => value.addEventListener('abort', () => reject(value.reason), { once: true }))
    })

    const rejected = assert.rejects(f.inputs.ask('Required input?', f.context('a2a:caller')))
    await setImmediate()
    if (close === 'stop') f.inputs.stop()
    if (close === 'unbind') unbind()
    await rejected
    await f.inputs.settled()
    assert.equal(signal?.aborted, true)
    assert.equal(f.inputs.get('a2a:caller'), null)
    assert.equal(f.records.some(record => record.answer), false)
    unbind()
  }
})

test('publication waits for storage; failed writes never acknowledge or resume input', async () => {
  const saved = Promise.withResolvers<void>()
  let fail = false
  const f = fixture(async () => { await saved.promise; if (fail) throw new Error('Storage unavailable') })
  const result = f.inputs.ask('Path?', f.context())
  const rejected = assert.rejects(result, /Storage unavailable/)
  await setImmediate()
  assert.equal(f.inputs.get('web:root'), null)
  assert.ok(f.inputs.get('web:root', true))
  await assert.rejects(f.inputs.ask('Another?', f.context()), /pending question/)
  saved.resolve()
  await f.inputs.settled()
  const request = f.inputs.get('web:root')!
  fail = true
  await assert.rejects(f.inputs.replyUser('web:root', request.id, 'answer'), /Storage unavailable/)
  await rejected
  assert.equal(f.inputs.get('web:root'), null)
  assert.equal(f.records.some(record => record.answer), false)
  await assert.rejects(f.inputs.ask('Again?', f.context()), /Storage unavailable/)
  assert.equal(f.inputs.get('web:root', true), null)
})

test('cancellation while saving an answer preserves the receipt but never resumes execution', async () => {
  const saved = Promise.withResolvers<void>()
  const writing = Promise.withResolvers<void>()
  const f = fixture(async record => { if (record.answer) { writing.resolve(); await saved.promise } })
  const controller = new AbortController()
  const result = f.inputs.ask('Path?', f.context('web:root', controller.signal))
  const rejected = assert.rejects(result, reason => reason === null)
  await setImmediate()
  const request = f.inputs.get('web:root')!
  const answer = f.inputs.replyUser('web:root', request.id, 'fixture-path')
  await writing.promise
  controller.abort(null)
  saved.resolve()
  assert.equal((await answer).text, 'fixture-path')
  await rejected
  await f.inputs.settled()
  assert.equal(f.inputs.get('web:root'), null)
})
