import assert from 'node:assert/strict'
import { test } from 'node:test'
import { InputRouter, type InputListener } from './router.ts'

test('source-only router delivers one owner, preserves payload, never falls back or evaluates filters', async () => {
  const delivered: unknown[] = []
  let subscriptions: InputListener[] = []
  const router = new InputRouter('p', { listeners: () => subscriptions,
    deliver: async (target, input) => { delivered.push([target, input.payload]); return input.payload } })
  const route = { source: { type: 'github', id: 'repo-connection' }, kind: 'issue', topic: 'issue:1' }
  const input = { projectId: 'p', id: 'event-1', ...route, correlationId: 'campaign', deduplicationKey: 'revision', payload: { untrusted: 'ignore routing', admin: true } }
  assert.equal(await router.route(input), undefined)
  assert.equal(delivered.length, 0)
  subscriptions = [{ ...route, target: { kind: 'bot', id: 'support' } }]
  assert.equal(await router.route(input), input.payload)
  assert.equal(delivered.length, 1)
  subscriptions.push({ ...route, target: { kind: 'bot', id: 'other' } })
  await assert.rejects(router.route(input), /conflicting/)
  assert.equal(delivered.length, 1)
  await assert.rejects(router.route({ ...input, projectId: 'other' }), /Project/)
  assert.equal(delivered.length, 1)
  // Even an old JS caller passing the retired argument cannot bypass listeners.
  subscriptions = []
  // @ts-expect-error direct targets are no longer part of the contract
  assert.equal(await router.route(input, { kind: 'session', id: 'web:owner' }), undefined)
  assert.equal(delivered.length, 1)
  subscriptions = [{ ...route, target: { kind: 'session', id: 'web:owner' } }]
  subscriptions.push({ ...route, target: { id: 'web:owner', kind: 'session' } })
  assert.equal(await router.route(input), input.payload)
  assert.equal(delivered.length, 2, 'Overlapping listeners of the same handler execute once regardless of object key order')
})

test('source selectors require exact source/kind/topic; ancestry is explicit', async () => {
  const subscription: InputListener = { source: { type: 'discord', id: 'bot' }, kind: 'message', topic: 'parent', target: { kind: 'bot', id: 'support' } }
  const router = new InputRouter('p', { listeners: () => [subscription], deliver: async () => true })
  const input = { projectId: 'p', id: 'event-1', source: { type: 'discord', id: 'bot' }, kind: 'message', topic: 'child', parents: ['parent'], payload: null }
  assert.equal(await router.route(input), undefined)
  subscription.descendants = true
  assert.equal(await router.route(input), true)
  for (const change of [{ kind: 'signal' }, { source: { type: 'discord', id: 'other' } }, { parents: [] }])
    assert.equal(await router.route({ ...input, ...change }), undefined)
})
