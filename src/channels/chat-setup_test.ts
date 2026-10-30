import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BotChatSetup } from './chat-setup.ts'

test('setup emits create/close/abort/expiry once, not reads or stale decisions', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let changes = 0
  const setup = new BotChatSetup('p', () => { changes++ })
  const controller = new AbortController()
  const first = setup.request('chat', controller.signal)
  assert.equal(changes, 1)
  const request = setup.get('chat')!
  setup.get('chat')
  assert.throws(() => setup.finish('chat', 'stale', 'closed'))
  assert.equal(changes, 1)
  setup.finish('chat', request.id, 'closed')
  await first
  assert.equal(changes, 2)
  const second = setup.request('chat', controller.signal)
  controller.abort()
  await second
  assert.equal(changes, 4)
  const third = setup.request('chat', new AbortController().signal)
  t.mock.timers.tick(10 * 60_000)
  assert.equal(await third, JSON.stringify({ status: 'expired' }))
  assert.equal(changes, 6)
  setup.stop()
  assert.equal(changes, 6)
})
