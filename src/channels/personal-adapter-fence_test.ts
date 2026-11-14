import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { Bus } from '../bus/bus.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { Client } from './feishu/sdk.ts'
import { WeChatChannel } from './wechat.ts'

for (const multipart of [false, true]) test(`Feishu final ${multipart ? 'multipart upload' : 'message'} request rechecks lease after asynchronous token acquisition`, async t => {
  const started = Promise.withResolvers<void>(), token = Promise.withResolvers<Response>()
  let requests = 0, current = true
  t.mock.method(globalThis, 'fetch', async () => { requests++; started.resolve(); return token.promise })
  const client = new Client({ appId: 'synthetic', appSecret: 'synthetic', beforeRequest: async () => { if (!current) throw Error('synthetic stale Personal lease') } })
  const sending = multipart ? client.im.image.create(new FormData()) : client.im.message.create({ params: { receive_id_type: 'open_id' }, data: { receive_id: 'owner', msg_type: 'text', content: '{}' } })
  await started.promise
  current = false
  token.resolve(new Response(JSON.stringify({ code: 0, tenant_access_token: 'synthetic', expire: 7200 })))
  await assert.rejects(sending, /stale Personal lease/)
  assert.equal(requests, 1, 'only token request, never upload/message request after revocation')
})

test('real WeChat per-chat outbound queue rechecks original lease before SDK send, not just when enqueued', async () => {
  await withTempWorkspace(async home => {
    const channel = new WeChatChannel(new Bus(), { workspace: home, storageDirectory: join(home, 'wechat'), scoped: true })
    const repo = channel['repository'], started = Promise.withResolvers<void>(), first = Promise.withResolvers<void>()
    repo.saveAccount({ accountId: 'synthetic', botToken: 'synthetic', baseUrl: 'https://fixture.invalid', savedAt: 'old' })
    repo.saveContextToken('owner', 'synthetic')
    let generation = '0', requests = 0
    channel['apiClient'].sendMessage = async () => { requests++; started.resolve(); await first.promise }
    const guard = async () => { if (generation !== '0') throw Error('synthetic stale Personal lease') }
    const message = { channel: 'wechat', chatId: 'owner', event: 'response' as const, done: true, content: 'synthetic' }
    try {
      const sending = channel.withDeliveryGuard(guard, () => channel.send(message))
      await started.promise
      const queued = channel.withDeliveryGuard(guard, () => channel.send(message))
      generation = '2' // pause/re-enable ABA while second output waits behind first
      const rejected = assert.rejects(queued)
      first.resolve()
      await sending; await rejected
      assert.equal(requests, 1, 'second queued reply must not reach the SDK')
    } finally { first.resolve(); await channel.stop() }
  })
})
