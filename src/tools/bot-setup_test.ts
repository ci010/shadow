import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { BotChatSetup, botChatSetupPlugin } from '../channels/chat-setup.ts'
import { botSetupPlugin } from '../channels/bot-setup.ts'
import type { BotInstanceStore } from '../channels/bot-store.ts'
import { BotSetupTool } from './bot-setup.ts'
import type { ExecutionContext } from './context.ts'
import type { ChannelManager } from '../channels/manager.ts'

function harness() {
  const setup = new BotChatSetup('p')
  const calls: unknown[] = []
  const manager = { projectId: 'p', botStatuses: () => [], createBot: async (value: unknown) => { calls.push(value); return { id: 'b' } }, updateBot: async () => ({ id: 'b' }) } as unknown as ChannelManager
  const tool = new BotSetupTool(setup, manager, sessionId => { if (sessionId !== 'web:chat-a') throw new Error('Not a user-owned Web session') })
  const context = { projectId: 'p', sessionId: 'web:chat-a', channel: 'virtual', admin: true, inputSource: 'user', tools: { executionMode: 'session' }, signal: new AbortController().signal } as ExecutionContext
  return { setup, tool, context, calls }
}
test('Bot tool enforces Web admin and Project ownership independent of external channel admin', async () => {
  const { tool, context } = harness()
  for (const patch of [{ projectId: 'other' }, { channel: 'wechat' }, { sessionId: 'wechat:owner' }, { sessionId: 'web:child' }, { isGroup: true }, { scriptInvocation: true }]) {
    await assert.rejects(tool.execute({ action: 'status' }, { ...context, ...patch }))
  }
  assert.deepEqual(JSON.parse(await tool.execute({ action: 'status' }, context)), { bots: [] })
})
test('Bot tool rejects credentials and retired purpose fields; creates transport-only WeChat', async () => {
  const { tool, context, calls } = harness()
  await assert.rejects(tool.execute({ action: 'create', platform: 'qq', displayName: 'test', secret: 'synthetic' }, context))
  await assert.rejects(tool.execute({ action: 'create', platform: 'wechat', purpose: 'service', displayName: 'test' }, context))
  assert.equal(calls.length, 0)
  await tool.execute({ action: 'create', platform: 'wechat', displayName: 'test' }, context)
  assert.deepEqual(calls, [{ platform: 'wechat', displayName: 'test', config: { enabled: false } }])
})
test('connection API rejects retired fields, keeps QR, and exposes no owner pairing endpoints', async () => {
  const app = new Hono(), calls: unknown[] = []
  const runtime = {
    projectId: 'p',
    createBot: async (input: unknown) => { calls.push(input); return { id: 'b' } },
    updateBot: async (_id: string, input: unknown) => { calls.push(input); return { id: 'b' } },
    wechatLogin: async (id: string, wait: boolean) => { calls.push({ id, wait }); return { connected: wait } },
  } as unknown as ChannelManager
  botSetupPlugin({ runtime, store: { projectId: 'p' } as BotInstanceStore, authorize: request => request.headers.get('x-test-admin') === 'yes' })(app)
  const request = (method: string, path: string, body?: unknown, admin = true) => app.request(`/api/channels${path}`, {
    method, headers: { 'content-type': 'application/json', 'x-test-admin': admin ? 'yes' : 'no' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const create = { platform: 'wechat', displayName: 'Transport', config: { enabled: false } }
  assert.equal((await request('POST', '', create, false)).status, 401)
  assert.equal((await request('POST', '', { ...create, purpose: 'personal' })).status, 400)
  assert.equal((await request('PATCH', '/b', { purpose: 'service' })).status, 400)
  assert.equal((await request('PATCH', '/b', { ownerVerified: true })).status, 400)
  assert.deepEqual(calls, [])
  assert.equal((await request('POST', '', create)).status, 201)
  assert.equal((await request('PATCH', '/b', { displayName: 'Renamed' })).status, 200)
  assert.equal((await request('POST', '/b/wechat/wait')).status, 200)
  for (const [method, path] of [['GET', '/b/owner-candidate'], ['POST', '/b/owner-challenge'], ['POST', '/b/owner-confirm'], ['DELETE', '/b/owner']]) {
    assert.equal((await request(method, path)).status, 404)
  }
  assert.deepEqual(calls, [create, { displayName: 'Renamed' }, { id: 'b', wait: true }])
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

test('continuation execution identity has the same BOT setup management access', async () => {
  const { setup, tool, context, calls } = harness()
  for (const inputSource of ['session', 'event', undefined] as const) {
    const continuation = { ...context, inputSource, admin: false }
    assert.deepEqual(JSON.parse(await tool.execute({ action: 'status' }, continuation)), { bots: [] })
    await tool.execute({action:'create',platform:'qq',displayName:'Created'},continuation)
    await tool.execute({action:'connection',id:'b',enabled:false},continuation)
  }
  assert.equal(calls.length, 3)
  setup.stop()
})
