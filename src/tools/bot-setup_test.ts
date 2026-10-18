import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { BotChatSetup, botChatSetupPlugin } from '../channels/chat-setup.ts'
import { BotSetupTool } from './bot-setup.ts'
import type { ExecutionContext } from './context.ts'
import type { ChannelManager } from '../channels/manager.ts'

function harness() {
  const setup = new BotChatSetup('p')
  const calls: unknown[] = []
  const manager = { projectId: 'p', botStatuses: () => [], createBot: async (value: unknown) => { calls.push(value); return { id: 'b' } }, updateBot: async () => ({ id: 'b' }) } as unknown as ChannelManager
  const tool = new BotSetupTool(setup, manager, sessionId => { if (sessionId !== 'web:chat-a') throw new Error('Not a user-owned Web session') })
  const context = { projectId: 'p', sessionId: 'web:chat-a', channel: 'virtual', admin: true, signal: new AbortController().signal } as ExecutionContext
  return { setup, tool, context, calls }
}
test('Bot tool enforces Web admin and Project ownership independent of paired channel admin', async () => {
  const { tool, context } = harness()
  for (const patch of [{ admin: false }, { projectId: 'other' }, { channel: 'wechat' }, { sessionId: 'wechat:owner' }, { sessionId: 'web:child' }, { isGroup: true }, { scriptInvocation: true }]) {
    await assert.rejects(tool.execute({ action: 'status' }, { ...context, ...patch }))
  }
  assert.deepEqual(JSON.parse(await tool.execute({ action: 'status' }, context)), { bots: [] })
})
test('Bot tool rejects credential arguments and nonpersonal WeChat', async () => {
  const { tool, context, calls } = harness()
  await assert.rejects(tool.execute({ action: 'create', platform: 'qq', purpose: 'personal', displayName: 'test', secret: 'synthetic' }, context))
  await assert.rejects(tool.execute({ action: 'create', platform: 'wechat', purpose: 'service', displayName: 'test' }, context))
  assert.equal(calls.length, 0)
  await tool.execute({ action: 'create', platform: 'wechat', purpose: 'personal', displayName: 'test' }, context)
  assert.equal(calls.length, 1)
})
test('Setup invitations are ephemeral, scoped, and cancellation resolves without secrets', async () => {
  const { setup, tool, context } = harness()
  const controller = new AbortController()
  const pending = tool.execute({ action: 'open' }, { ...context, signal: controller.signal })
  assert.equal(setup.get('web:other'), null)
  const request = setup.get(context.sessionId)!
  assert.deepEqual(Object.keys(request).sort(), ['expiresAt', 'id', 'projectId', 'sessionId'])
  assert.throws(() => setup.finish(context.sessionId, 'stale', 'closed'))
  controller.abort()
  assert.equal(JSON.parse(await pending).status, 'cancelled')
  assert.equal(setup.get(context.sessionId), null)
})
test('Setup API requires HTTP authorization and real UI closure', async () => {
  const setup = new BotChatSetup('p')
  const app = new Hono()
  botChatSetupPlugin(setup, request => request.headers.get('authorization') === 'test-admin')(app)
  const pending = setup.request('web:a', new AbortController().signal)
  const url = '/api/bot-chat-setup/request'
  assert.equal((await app.request(url + '?sessionId=web:a')).status, 401)
  const response = await app.request(url + '?sessionId=web:a', { headers: { authorization: 'test-admin' } })
  const body = await response.json()
  const close = await app.request(url, { method: 'POST', headers: { authorization: 'test-admin', 'Content-Type': 'application/json' }, body: JSON.stringify({ id: body.request.id, sessionId: 'web:a', status: 'closed' }) })
  assert.equal(close.status, 200)
  assert.equal(JSON.parse(await pending).status, 'closed')
  setup.stop()
})
