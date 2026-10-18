import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Bus } from '../bus/bus.ts'
import type { InboundMessage } from '../bus/events.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { QQChannel } from './qq.ts'
import { WeChatChannel } from './wechat.ts'
import { WeixinMessageType, WeixinMessageItemType } from './wechat/sdk.ts'
import { channelSupportsAsk } from '../tools/ask-policy.ts'
import { channelSessionId } from '../bus/events.ts'

// Audit the existing behavior, including unsafe defaults; these are not a
// specification that unconfigured private-message access should remain open.
function capture(channel: QQChannel | WeChatChannel) {
  const messages: InboundMessage[] = []
  channel.setReceiver(async message => {
    messages.push(message)
    return { status: 'accepted', sessionId: `${message.channel}:${message.chatId}`, inputId: message.messageId }
  })
  return messages
}

function qqMessage(sender: string, id: string) {
  return { id, author: { user_openid: sender }, content: 'personal bot audit' }
}

test('personal QQ: scoped Bot preserves DM admin and allowFrom rejects other users', async t => {
  const channel = new QQChannel(new Bus(), { appId: 'fixture', secret: 'fixture', allowFrom: ['owner'] })
  t.after(() => channel.stop())
  channel.setBotScope({ projectId: 'fixture-project', botInstanceId: 'fixture-bot', platform: 'qq' })
  const received = capture(channel)
  await channel['handleDispatch']('C2C_MESSAGE_CREATE', qqMessage('owner', 'owner-message'))
  await assert.rejects(channel['handleDispatch']('C2C_MESSAGE_CREATE', qqMessage('stranger', 'stranger-message')), /not authorized/)
  assert.equal(received.length, 1)
  assert.equal(received[0]!.admin, true)
  assert.equal(received[0]!.isGroup, false)
  assert.equal(received[0]!.channelAddress?.botInstanceId, 'fixture-bot')
})

test('personal QQ audit: omitted or empty allowFrom admits arbitrary DMs as admin', async t => {
  for (const allowFrom of [undefined, []]) {
    const channel = new QQChannel(new Bus(), { appId: 'fixture', secret: 'fixture', allowFrom })
    t.after(() => channel.stop())
    const received = capture(channel)
    await channel['handleDispatch']('C2C_MESSAGE_CREATE', qqMessage('unconfigured-stranger', 'message'))
    assert.equal(received.length, 1)
    assert.equal(received[0]!.admin, true)
  }
})

function wechatMessage(sender: string, id: number) {
  return { message_id: id, from_user_id: sender, message_type: WeixinMessageType.USER,
    item_list: [{ type: WeixinMessageItemType.TEXT, text_item: { text: 'personal bot audit' } }] }
}

test('legacy personal WeChat: linked user is admin and other users are ignored', async () => {
  await withTempWorkspace(async workspace => {
    const channel = new WeChatChannel(new Bus(), { workspace })
    try {
      const received = capture(channel)
      await channel['_processMessage'](wechatMessage('owner', 1), 'owner')
      await channel['_processMessage'](wechatMessage('stranger', 2), 'owner')
      assert.equal(received.length, 1)
      assert.equal(received[0]!.admin, true)
      assert.equal(received[0]!.senderId, 'owner')
    } finally { await channel.stop() }
  })
})

test('legacy personal WeChat audit: absent linked user and allowFrom admit arbitrary sender as admin', async () => {
  await withTempWorkspace(async workspace => {
    const channel = new WeChatChannel(new Bus(), { workspace })
    try {
      const received = capture(channel)
      await channel['_processMessage'](wechatMessage('unconfigured-stranger', 1))
      assert.equal(received.length, 1)
      assert.equal(received[0]!.admin, true)
    } finally { await channel.stop() }
  })
})

test('personal QQ audit: sender allowlist does not enforce private-only conversations', async t => {
  const channel = new QQChannel(new Bus(), { appId: 'fixture', secret: 'fixture', allowFrom: ['owner'] })
  t.after(() => channel.stop())
  const received = capture(channel)
  await channel['handleDispatch']('GROUP_AT_MESSAGE_CREATE', {
    id: 'group-message', group_openid: 'group', author: { member_openid: 'owner' }, content: 'hello',
  })
  assert.equal(received.length, 1)
  assert.equal(received[0]!.isGroup, true)
  assert.equal(received[0]!.admin, false)
})

test('personal QQ audit: question tool policy is platform-wide, including scoped owner DMs', () => {
  const sessionId = channelSessionId({ projectId: 'fixture-project', botInstanceId: 'fixture-bot',
    platform: 'qq', conversationId: 'c2c:owner' })
  assert.equal(channelSupportsAsk('qq', sessionId), false)
  assert.equal(channelSupportsAsk('web', 'web:owner'), true)
})
