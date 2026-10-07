import { deepEqual as assertEquals, rejects } from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { Bus } from '../bus/bus.ts'
import type { InboundMessage } from '../bus/events.ts'
import { sessionWorkspacePath } from '../utils/paths.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { QQChannel, type QQChannelOptions } from './qq.ts'

for (const events of [
  ['GROUP_MESSAGE_CREATE', 'GROUP_AT_MESSAGE_CREATE'],
  ['GROUP_AT_MESSAGE_CREATE', 'GROUP_MESSAGE_CREATE'],
]) {
  test(`QQ receives ${events[0]} by default and deduplicates both group event types`, async () => {
    const channel = new QQChannel(new Bus(), { appId: 'synthetic', secret: 'synthetic' })
    const received: InboundMessage[] = []
    channel.setReceiver(async message => {
      received.push(message)
      return { status: 'accepted', sessionId: `qq:${message.chatId}`, inputId: message.messageId }
    })
    assertEquals(channel['intents'] & (1 << 25), 1 << 25)
    const data = {
      id: 'source', group_openid: 'group', author: { member_openid: 'sender' },
      content: 'mentioned message', mentions: [{ id: 'synthetic' }], timestamp: new Date().toISOString(),
    }
    for (const event of [...events, events[0]]) {
      await channel['handleDispatch'](event, data)
    }
    assertEquals(received.map(message => ({
      chatId: message.chatId, senderId: message.senderId, content: message.content,
      messageId: message.messageId, platformMessageId: message.platformMessageId,
      isGroup: message.isGroup, admin: message.admin, silent: message.silent,
    })), [{
      chatId: 'group:group', senderId: 'sender',
      content: data.content,
      messageId: 'source', platformMessageId: 'source', isGroup: true, admin: false, silent: false,
    }])
  })
}

for (const triggerMode of [undefined, 'mention', 'all'] as const) {
  test(`QQ ${triggerMode ?? 'default'} mode separates reception from model triggering`, async () => {
    const options: QQChannelOptions = { appId: 'synthetic', secret: 'synthetic', triggerMode }
    const channel = new QQChannel(new Bus(), options)
    const received: InboundMessage[] = []
    channel.setReceiver(async message => {
      received.push(message)
      return { status: 'accepted', sessionId: `qq:${message.chatId}`, inputId: message.messageId }
    })
    await channel['handleDispatch']('READY', { session_id: 'session', user: { id: 'bot-user' } })
    const cases: Array<{ event: string; mentions?: unknown; triggers: boolean }> = [
      { event: 'GROUP_MESSAGE_CREATE', triggers: false },
      { event: 'GROUP_MESSAGE_CREATE', mentions: [{ id: 'someone-else', bot: true }], triggers: false },
      { event: 'GROUP_MESSAGE_CREATE', mentions: [null, 123, {}, { id: 123 }], triggers: false },
      { event: 'GROUP_MESSAGE_CREATE', mentions: { id: 'bot-user' }, triggers: false },
      { event: 'GROUP_MESSAGE_CREATE', mentions: [{ id: 'bot-user' }], triggers: true },
      { event: 'GROUP_MESSAGE_CREATE', mentions: [{ id: 'synthetic' }], triggers: true },
      { event: 'GROUP_MESSAGE_CREATE', mentions: [{ id: 'group-bot-openid', is_you: true }], triggers: true },
      { event: 'GROUP_MESSAGE_CREATE', mentions: [{ is_you: true }], triggers: true },
      { event: 'GROUP_MESSAGE_CREATE', mentions: [{ id: 'someone-else', is_you: false }], triggers: false },
      { event: 'GROUP_MESSAGE_CREATE', mentions: [{ id: 'someone-else', is_you: 'true' }], triggers: false },
      { event: 'GROUP_MESSAGE_CREATE', mentions: [{ id: 'someone-else', is_you: 1 }], triggers: false },
      { event: 'GROUP_AT_MESSAGE_CREATE', triggers: true },
      { event: 'C2C_MESSAGE_CREATE', triggers: true },
    ]
    for (const [index, entry] of cases.entries()) {
      await channel['handleDispatch'](entry.event, {
        id: `message-${index}`, group_openid: 'group',
        author: { member_openid: 'sender', user_openid: 'sender' },
        content: '@someone ordinary text', timestamp: new Date().toISOString(), mentions: entry.mentions,
      })
    }
    assertEquals(received.length, cases.length)
    assertEquals(received.map(message => message.silent === true),
      cases.map(entry => triggerMode !== 'all' && !entry.triggers))
    assertEquals(received.at(-1)?.chatId, 'c2c:sender')
  })
}

test('QQ all-message reception preserves the sender allowlist', async () => {
  const channel = new QQChannel(new Bus(), {
    appId: 'synthetic', secret: 'synthetic', allowFrom: ['allowed'],
  })
  const received: string[] = []
  channel.setReceiver(async message => {
    received.push(message.senderId)
    return { status: 'accepted', sessionId: `qq:${message.chatId}`, inputId: message.messageId }
  })
  for (const event of ['GROUP_MESSAGE_CREATE', 'GROUP_AT_MESSAGE_CREATE']) {
    const data = {
      id: `${event}-blocked`, group_openid: 'group', author: { member_openid: 'blocked' },
      content: 'hello', timestamp: new Date().toISOString(),
    }
    await rejects(channel['handleDispatch'](event, data), /not authorized/)
    await channel['handleDispatch'](event, {
      ...data, id: `${event}-allowed`, author: { member_openid: 'allowed' },
    })
  }
  assertEquals(received, ['allowed', 'allowed'])
})

test('QQ sends a local file from the originating non-mention group message', async () => {
  await withTempWorkspace(async (workspace) => {
    const chatId = 'group:group-openid'
    const sessionDir = sessionWorkspacePath(workspace, `qq:${chatId}`)
    await mkdir(sessionDir, { recursive: true })
    await writeFile(join(sessionDir, 'report.txt'), 'report contents')

    const originalFetch = globalThis.fetch
    const requests: Array<
      { method: string; path: string; body?: Record<string, unknown> }
    > = []
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input)
      if (url.href === 'https://bots.qq.com/app/getAppAccessToken') {
        return Response.json({ access_token: 'access-token', expires_in: 7200 })
      }

      if (url.href === 'https://upload.example.test/part-0') {
        requests.push({ method: init?.method ?? 'GET', path: url.pathname })
        return new Response(null, { status: 200 })
      }

      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      requests.push({ method: init?.method ?? 'GET', path: url.pathname, body })
      if (url.pathname.endsWith('/upload_prepare')) {
        return Response.json({
          upload_id: 'upload-id',
          block_size: 1024,
          parts: [{
            index: 0,
            presigned_url: 'https://upload.example.test/part-0',
          }],
        })
      }
      if (url.pathname.endsWith('/files')) {
        return Response.json({ file_info: 'file-info' })
      }
      return Response.json({ id: 'message-id' })
    }

    try {
      const channel = new QQChannel(new Bus(), {
        appId: 'app-id',
        secret: 'app-secret',
        triggerMode: 'all',
        workspace,
      })
      channel.setReceiver(async message => ({
        status: 'accepted', sessionId: `qq:${message.chatId}`, inputId: message.messageId,
      }))
      await (channel as unknown as {
        handleDispatch(event: string, data: Record<string, unknown>): Promise<void>
      }).handleDispatch('GROUP_MESSAGE_CREATE', {
        id: 'source-id', group_openid: 'group-openid', author: { member_openid: 'sender' },
        content: 'report', timestamp: new Date().toISOString(),
      })
      await channel.send({
        channel: 'qq',
        chatId,
        event: 'response',
        content: '',
        media: ['report.txt'],
        done: true,
        replyTo: 'source-id',
      })

      assertEquals(requests, [
        {
          method: 'POST',
          path: '/v2/groups/group-openid/upload_prepare',
          body: {
            file_type: 4,
            file_name: 'report.txt',
            file_size: 15,
            md5: createHash('md5').update('report contents').digest('hex'),
            sha1: createHash('sha1').update('report contents').digest('hex'),
            md5_10m: createHash('md5').update('report contents').digest('hex'),
          },
        },
        { method: 'PUT', path: '/part-0' },
        {
          method: 'POST',
          path: '/v2/groups/group-openid/upload_part_finish',
          body: {
            upload_id: 'upload-id',
            part_index: 0,
            block_size: 15,
            md5: createHash('md5').update('report contents').digest('hex'),
          },
        },
        {
          method: 'POST',
          path: '/v2/groups/group-openid/files',
          body: {
            upload_id: 'upload-id',
          },
        },
        {
          method: 'POST',
          path: '/v2/groups/group-openid/messages',
          body: {
            msg_type: 7,
            msg_seq: 1,
            msg_id: 'source-id',
            media: { file_info: 'file-info' },
          },
        },
      ])
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
