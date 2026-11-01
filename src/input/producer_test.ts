import assert from 'node:assert/strict'
import { test } from 'node:test'
import { InputRouter, type InputEnvelope } from './router.ts'
import { bindInputProducer } from './producer.ts'

test('host-bound program signals share the router without gaining human identity or Session targets', async () => {
  let subscribed = false, authorized = true
  const received: InputEnvelope<unknown>[] = []
  const source = { type: 'program', id: 'news-checker' }
  const router = new InputRouter<unknown, boolean>('p', {
    listeners: () => subscribed ? [{ source, kind: 'signal', topic: 'news', target: { kind: 'bot', id: 'digest' } }] : [],
    deliver: async (target, input) => { assert.deepEqual(target, { kind: 'bot', id: 'digest' }); received.push(input); return true },
  })
  const emit = bindInputProducer(router, { projectId: 'p', source, routes: [{ kind: 'signal', topic: 'news' }], authorize: () => { if (!authorized) throw new Error('Producer revoked') } })
  const input = { id: 'news-1', kind: 'signal', topic: 'news', correlationId: 'scan-1', deduplicationKey: 'article:revision', payload: { senderId: 'owner', admin: true, target: 'web:owner', text: 'untrusted news' } }
  assert.equal(await emit(input), undefined)
  assert.equal(received.length, 0)
  subscribed = true
  assert.equal(await emit(input), true)
  assert.deepEqual(received[0]?.source, { type: 'program', id: 'news-checker' })
  assert.equal(received[0]?.kind, 'signal')
  assert.equal(received[0]?.correlationId, 'scan-1')
  assert.equal(received[0]?.deduplicationKey, 'article:revision')
  assert.equal(received[0]?.payload, input.payload)
  for (const extra of [{ source: { type: 'web', id: 'owner' } }, { projectId: 'other' }, { target: { kind: 'session', id: 'web:owner' } }, { kind: 'message' }, { topic: 'private' }, { admin: true }, { listeners: [] }, { parents: ['private'] }, { reply: 'owner' }])
    await assert.rejects(emit({ ...input, ...extra }))
  authorized = false
  await assert.rejects(emit(input), /revoked/)
  assert.equal(received.length, 1)
  assert.throws(() => bindInputProducer(router, { projectId: 'other', source, routes: [], authorize: () => {} }), /Project/)
})
