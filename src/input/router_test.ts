import assert from 'node:assert/strict'
import { test } from 'node:test'
import { InputRouter, type InputSubscription } from './router.ts'

test('source-only router delivers one owner, preserves payload, never falls back or evaluates filters', async () => {
  const delivered: unknown[] = []
  let subscriptions: InputSubscription[] = []
  const router = new InputRouter('p', { subscriptions: () => subscriptions,
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
  await assert.rejects(router.route({ ...input, projectId: 'other' }, { kind: 'session', id: 'web:owner' }), /Project/)
  assert.equal(delivered.length, 1)
  assert.equal(await router.route(input, { kind: 'session', id: 'web:owner' }), input.payload)
})

test('source selectors require exact source/kind/topic; ancestry is explicit', async () => {
  const subscription: InputSubscription = { source: { type: 'discord', id: 'bot' }, kind: 'message', topic: 'parent', target: { kind: 'bot', id: 'support' } }
  const router = new InputRouter('p', { subscriptions: () => [subscription], deliver: async () => true })
  const input = { projectId: 'p', id: 'event-1', source: { type: 'discord', id: 'bot' }, kind: 'message', topic: 'child', parents: ['parent'], payload: null }
  assert.equal(await router.route(input), undefined)
  subscription.descendants = true
  assert.equal(await router.route(input), true)
  for (const change of [{ kind: 'signal' }, { source: { type: 'discord', id: 'other' } }, { parents: [] }])
    assert.equal(await router.route({ ...input, ...change }), undefined)
})
