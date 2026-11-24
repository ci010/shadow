import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createBotSettingsClient, parseBotStatus } from './bot-settings.ts'

const status = { id: 'b', projectId: 'p', platform: 'wechat', displayName: 'Bot', label: 'WeChat', enabled: false, configured: false, state: 'disabled', config: {}, secrets: {} }

test('connection client creates transport only and scopes WeChat QR to the exact connection', async () => {
  const calls: Array<{ path: string; method: string; body?: unknown }> = []
  const client = createBotSettingsClient('http://127.0.0.1/projects/p', 'p', async (url, init) => {
    calls.push({ path: new URL(String(url)).pathname, method: init?.method ?? 'GET', body: init?.body && JSON.parse(String(init.body)) })
    return Response.json(String(url).endsWith('/wechat/login') ? { qrcodeUrl: 'synthetic' } : { channel: status })
  })
  assert.equal((await client.create('wechat', 'Transport')).platform, 'wechat')
  assert.deepEqual(await client.wechat('b', 'login'), { qrcodeUrl: 'synthetic' })
  assert.deepEqual(calls, [
    { path: '/projects/p/api/channels', method: 'POST', body: { platform: 'wechat', displayName: 'Transport', config: { enabled: false } } },
    { path: '/projects/p/api/channels/b/wechat/login', method: 'POST', body: undefined },
  ])
})

test('transport status carries no BOT mode, owner verification, or fallback role', () => {
  const parsed = parseBotStatus(status, 'p')
  assert.equal(parsed.id, 'b')
  assert.equal('purpose' in parsed, false)
  assert.equal('ownerVerified' in parsed, false)
  assert.throws(() => parseBotStatus(status, 'foreign'), /ownership/)
})
