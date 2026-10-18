import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Bus } from '../bus/bus.ts'
import { WeChatChannel } from './wechat.ts'
import { WeixinApiClient, WeixinDeliveryError, WeixinRepository } from './wechat/sdk.ts'

test('sendmessage requires explicit valid zero business codes; failures never retry or expose remote data', async () => {
  const original = globalThis.fetch
  const api = new WeixinApiClient()
  try {
    for (const [body, reason] of [
      ['{"ret":0}', null], ['{"errcode":0}', null], ['{"ret":0,"errcode":0}', null],
      ['{"ret":-1,"errmsg":"secret-token https://secret"}', 'business_rejected'],
      ['{"ret":0,"errcode":42}', 'business_rejected'], ['{"ret":1,"errcode":0}', 'business_rejected'],
      ['{}', 'malformed_response'], ['null', 'malformed_response'], ['[]', 'malformed_response'],
      ['{"ret":"0"}', 'malformed_response'], ['{"ret":0,"errcode":null}', 'malformed_response'],
      ['{"ret":1e100}', 'malformed_response'], ['broken secret-token', 'malformed_response'],
    ] as const) {
      let calls = 0
      globalThis.fetch = async () => { calls++; return new Response(body) }
      const send = api.sendMessage('https://secret', 'secret-token', { msg: {} })
      if (!reason) await send
      else await assert.rejects(send, (e: unknown) => {
        assert.ok(e instanceof WeixinDeliveryError)
        assert.equal(e.reason, reason)
        assert.equal(e.retryable, false)
        assert.doesNotMatch(JSON.stringify(e) + e.message, /secret|https|errmsg/)
        return true
      })
      assert.equal(calls, 1)
    }
    globalThis.fetch = async () => new Response('secret', { status: 403, statusText: 'secret' })
    await assert.rejects(api.sendMessage('https://secret', 'secret', { msg: {} }), (e: unknown) => e instanceof WeixinDeliveryError && e.status === 403 && e.reason === 'http_rejected' && !e.message.includes('secret'))
    globalThis.fetch = async () => { throw new Error('https://secret?token=secret') }
    await assert.rejects(api.sendMessage('https://secret', 'secret', { msg: {} }), (e: unknown) => e instanceof WeixinDeliveryError && e.reason === 'transport_unknown' && !e.message.includes('secret'))
  } finally { globalThis.fetch = original }
})

test('repository keeps legacy timestamp unknown and persists metadata-only undelivered counts without erasing concurrent failures', () => {
  const root = mkdtempSync(join(tmpdir(), 'wechat-repo-'))
  try {
    writeFileSync(join(root, 'context-tokens.json'), JSON.stringify({ owner: 'legacy' }))
    let repo = new WeixinRepository(root, root)
    assert.deepEqual(repo.getContextTokenRecord('owner'), { token: 'legacy' })
    repo.saveContextToken('owner', 'fresh')
    assert.ok(repo.getContextTokenRecord('owner')?.updatedAt)
    repo.recordUndelivered('owner')
    repo.enableUndeliveredNotice('owner')
    const snapshot = repo.getUndelivered('owner')!.eligibleCount
    repo.recordUndelivered('owner')
    repo.acknowledgeUndelivered('owner', snapshot)
    repo = new WeixinRepository(root, root)
    assert.equal(repo.getUndelivered('owner')?.count, 1)
    assert.equal(repo.getUndelivered('owner')?.eligibleCount, 0)
    assert.ok(repo.getUndelivered('owner')?.lastFailureAt)
    assert.doesNotMatch(readFileSync(join(root, 'undelivered.json'), 'utf8'), /legacy|fresh|content/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('channel requires credentials, persists failed final/decision counts, merges notice only after valid new inbound token', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wechat-channel-'))
  const channel = new WeChatChannel(new Bus(), { workspace: root, storageDirectory: root, scoped: true })
  const repo = channel['repository']
  const sent: string[] = []
  let fail = false
  channel['apiClient'].sendMessage = async (_base, _token, payload) => {
    if (fail) throw new WeixinDeliveryError('business_rejected', 200, -1)
    sent.push(payload.msg.item_list?.[0]?.text_item?.text ?? '')
  }
  const send = () => channel.send({ channel: 'wechat', chatId: 'owner', event: 'response', content: 'new answer', done: true })
  try {
    await assert.rejects(send(), (e: unknown) => e instanceof WeixinDeliveryError && e.reason === 'missing_account')
    repo.saveAccount({ accountId: 'bot', botToken: 'credential', baseUrl: 'https://invalid', savedAt: 'old' })
    await assert.rejects(channel.presentDecisionText('owner', 'decision'), (e: unknown) => e instanceof WeixinDeliveryError && e.reason === 'missing_context_token')
    assert.equal(sent.length, 0)
    assert.equal(repo.getUndelivered('owner')?.count, 2)
    repo.saveContextToken('owner', 'old')
    await send()
    assert.equal(sent[0], 'new answer') // token alone is not an inbound recovery
    channel.setReceiver(async () => ({ status: 'accepted', sessionId: 'fixture', inputId: 'fixture' }))
    await channel['_processMessage']({ message_type: 1, from_user_id: 'stranger', message_id: 1, context_token: 'foreign', item_list: [{ type: 1, text_item: { text: 'hi' } }] }, 'owner')
    await channel['_processMessage']({ message_type: 1, from_user_id: 'owner', message_id: 2, context_token: 'fresh', item_list: [{ type: 1, text_item: { text: 'hi' } }] }, 'owner')
    fail = true
    await assert.rejects(send(), (e: unknown) => e instanceof WeixinDeliveryError && e.ret === -1)
    assert.equal(repo.getUndelivered('owner')?.count, 3)
    fail = false
    await Promise.all([send(), send()])
    assert.equal(sent.filter(s => s.includes('此前有2条回复未送达，可在Web查看')).length, 1)
    assert.equal(repo.getUndelivered('owner')?.count, 1) // newer failed reply not erased
    assert.equal(repo.getUndelivered('owner')?.eligibleCount, 0)
    assert.equal(sent.at(-1), 'new answer')
  } finally { await channel.stop(); rmSync(root, { recursive: true, force: true }) }
})

