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

test('QQ supplies known group, guild-channel and direct-message display names without changing IDs', async t => {
  const channel = new QQChannel(new Bus(), { appId: 'synthetic', secret: 'synthetic' })
  t.after(() => channel.stop())
  const received: InboundMessage[] = []
  channel.setReceiver(async message => {
    received.push(message)
    return { status: 'accepted', sessionId: `qq:${message.chatId}`, inputId: message.messageId }
  })
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (url.pathname === '/app/getAppAccessToken') return Response.json({ access_token: 'synthetic', expires_in: 7200 })
    assertEquals(url.pathname, '/channels/channel-id')
    return Response.json({ id: 'channel-id', name: 'Guild channel' })
  })
  await channel['handleDispatch']('GROUP_AT_MESSAGE_CREATE', {
    id: 'group-message', group_openid: 'group-id', group_name: 'QQ group',
    author: { member_openid: 'member', username: 'Group member' },
    content: 'hello', timestamp: new Date().toISOString(),
  })
  await channel['handleDispatch']('C2C_MESSAGE_CREATE', {
    id: 'private-message', author: { user_openid: 'person', username: 'Private person' },
    content: 'hello', timestamp: new Date().toISOString(),
  })
  await channel['handleDispatch']('AT_MESSAGE_CREATE', {
    id: 'channel-message', channel_id: 'channel-id', guild_id: 'guild-id',
    author: { id: 'member', username: 'Member' }, content: 'hello',
  })
  await channel['handleDispatch']('CHANNEL_UPDATE', { id: 'channel-id', name: 'Renamed channel' })
  await channel['handleDispatch']('AT_MESSAGE_CREATE', {
    id: 'next-message', channel_id: 'channel-id', guild_id: 'guild-id',
    author: { id: 'member', username: 'Member' }, content: 'hello',
  })
  await channel['handleDispatch']('DIRECT_MESSAGE_CREATE', {
    id: 'guild-dm', guild_id: 'dm-id', author: { id: 'person', username: 'Guild person' },
    content: 'hello',
  })
  assertEquals(received.map(message => [message.chatId, message.chatName, message.senderName]), [
    ['group:group-id', 'QQ group', 'Group member'],
    ['c2c:person', undefined, 'Private person'],
    ['channel:channel-id', 'Guild channel', 'Member'],
    ['channel:channel-id', 'Renamed channel', 'Member'],
    ['dms:dm-id', 'Guild person', 'Guild person'],
  ])
})

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
          block_size: '1024',
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
            file_size: '15',
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
            block_size: '15',
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

for (const kind of ['group', 'c2c'] as const) for (const base of [0, 1]) for (const count of [2, 3]) {
  test(`QQ ${kind} base-${base} uploads ${count} parts for large files with the official hash prefix and indexed parts`, async t => {
    const channel = new QQChannel(new Bus(), { appId: 'fixture', secret: 'fixture' })
    t.after(() => channel.stop())
    const blockSize = count === 2 ? 10_485_760 : 5_242_880
    const tailSize = count === 2 ? 3_198_292 : 123
    const data = Buffer.alloc(blockSize * (count - 1) + tailSize, 97)
    data.fill(98, 10_002_432)
    const indices = (count === 2 ? [1, 0] : [2, 0, 1]).map(index => index + base)
    const uploaded = new Map<number, Buffer>()
    const finished: number[] = []
    const resource = kind === 'group' ? '/v2/groups/recipient' : '/v2/users/recipient'
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input)
      if (url.hostname === 'upload.example.test') {
        const index = Number(url.pathname.slice(1))
        assertEquals(init?.method, 'PUT')
        assertEquals(new Headers(init?.headers).has('authorization'), false)
        const bytes = Buffer.from(init?.body as Uint8Array)
        assertEquals(bytes, data.subarray((index - base) * blockSize, (index - base + 1) * blockSize))
        uploaded.set(index, bytes)
        return new Response(null)
      }
      const body = JSON.parse(String(init?.body))
      if (url.pathname === `${resource}/upload_prepare`) {
        assertEquals(body.file_size, String(data.length))
        assertEquals(body.md5, createHash('md5').update(data).digest('hex'))
        assertEquals(body.sha1, createHash('sha1').update(data).digest('hex'))
        assertEquals(body.md5_10m, createHash('md5').update(data.subarray(0, 10_002_432)).digest('hex'))
        return Response.json({ upload_id: 'upload', block_size: String(blockSize),
          parts: indices.map(index => ({ index: kind === 'c2c' ? String(index) : index, presigned_url: `https://upload.example.test/${index}` })) })
      }
      if (url.pathname === `${resource}/upload_part_finish`) {
        finished.push(body.part_index)
        const bytes = uploaded.get(body.part_index)!
        assertEquals(body.block_size, String(bytes.length))
        assertEquals(body.md5, createHash('md5').update(bytes).digest('hex'))
        return Response.json({})
      }
      assertEquals(url.pathname, `${resource}/files`)
      assertEquals(uploaded.size, count)
      assertEquals(finished, indices)
      assertEquals(Buffer.concat([...uploaded].sort(([a], [b]) => a - b).map(([, bytes]) => bytes)), data)
      assertEquals(uploaded.get(base + count - 1)!.length, tailSize)
      assertEquals(body, { upload_id: 'upload' })
      return Response.json({ file_info: 'completed' })
    })
    assertEquals(await channel['uploadNamedMedia']({ kind, id: 'recipient' }, {}, 'report.zip', data, 4),
      { file_info: 'completed' })
  })
}

// Official example is zero-based; live C2C returned index 2 for two parts.
// Compatibility accepts only complete zero-based or one-based sets.
// https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_id_upload_prepare.post.html
for (const index of [2, '2', -1, 0.5, Number.MAX_SAFE_INTEGER + 1, '9007199254740992', 'signed-secret', { url: 'signed-secret' }]) {
  test(`QQ rejects invalid single-part index ${JSON.stringify(index)} with numeric-only diagnostics`, async t => {
    const channel = new QQChannel(new Bus(), { appId: 'fixture', secret: 'fixture' })
    t.after(() => channel.stop())
    const warnings: unknown[][] = []
    t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args) })
    let requests = 0
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input)
      requests++
      assertEquals(url.pathname, '/v2/users/recipient/upload_prepare')
      return Response.json({
        upload_id: 'private-upload-id', block_size: '1024',
        parts: [{ index, presigned_url: 'https://upload.example.test/?signature=signed-secret' }],
      })
    })
    await rejects(channel['uploadNamedMedia']({ kind: 'c2c', id: 'recipient' }, {}, 'test.png', Buffer.from('image'), 1),
      /invalid part/)
    assertEquals(requests, 1) // No PUT, finish, completion or message after rejection.
    const numericIndex = typeof index === 'string' && /^\d+$/.test(index) ? Number(index) : index
    assertEquals(warnings, [['[qq] Invalid upload part metadata', {
      index: typeof numericIndex === 'number' && Number.isSafeInteger(numericIndex) ? numericIndex : null,
      blockSize: 1024,
      indexType: typeof index,
      validInteger: typeof numericIndex === 'number' && Number.isSafeInteger(numericIndex),
      inRange: typeof numericIndex === 'number' && numericIndex >= 0 && numericIndex <= 1,
      duplicate: false,
      hasUploadUrl: true,
      parts: 1,
    }]])
    assertEquals(JSON.stringify(warnings).includes('signed-secret'), false)
    assertEquals(JSON.stringify(warnings).includes('private-upload-id'), false)
  })
}

// No network writes may happen until the entire metadata set is validated.
for (const fixture of [
  { name: 'duplicate zero', indices: [0, 0], blockSize: 4 },
  { name: 'duplicate one', indices: [1, 1], blockSize: 4 },
  { name: 'mixed bases / gap', indices: [0, 2], blockSize: 4 },
  { name: 'missing part', indices: [0], blockSize: 4 },
  { name: 'empty parts', indices: [], blockSize: 4 },
  { name: 'out of range', indices: [1, 3], blockSize: 4 },
  { name: 'unsafe index', indices: [1, Number.MAX_SAFE_INTEGER + 1], blockSize: 4 },
  { name: 'zero block size', indices: [0, 1], blockSize: 0 },
  { name: 'negative block size', indices: [0, 1], blockSize: -4 },
  { name: 'fractional block size', indices: [0, 1], blockSize: 3.5 },
  { name: 'unsafe block size', indices: [0], blockSize: Number.MAX_SAFE_INTEGER + 1 },
]) {
  test(`QQ rejects ${fixture.name} before any upload`, async t => {
    const channel = new QQChannel(new Bus(), { appId: 'fixture', secret: 'fixture' })
    t.after(() => channel.stop())
    t.mock.method(console, 'warn', () => {})
    let requests = 0
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
      requests++
      assertEquals(new URL(input instanceof Request ? input.url : input).pathname,
        '/v2/users/recipient/upload_prepare')
      return Response.json({ upload_id: 'private', block_size: fixture.blockSize,
        parts: fixture.indices.map(index => ({ index, presigned_url: 'https://upload.example.test/' })) })
    })
    await rejects(channel['uploadNamedMedia']({ kind: 'c2c', id: 'recipient' }, {}, 'test.zip', Buffer.from('1234567'), 4), /preparation response/)
    assertEquals(requests, 1)
  })
}

for (const index of [0, '0', 1, '1']) {
  test(`QQ accepts complete single-part wire index ${JSON.stringify(index)}`, async t => {
    const channel = new QQChannel(new Bus(), { appId: 'fixture', secret: 'fixture' })
    t.after(() => channel.stop())
    const data = Buffer.from('single-part')
    let requests = 0
    t.mock.method(globalThis, 'fetch', async (_input: unknown, init?: RequestInit) => {
      requests++
      if (requests === 1) return Response.json({ upload_id: 'private', block_size: 1024,
        parts: [{ index, presigned_url: 'https://upload.example.test/' }] })
      if (requests === 2) {
        assertEquals(init?.method, 'PUT')
        assertEquals(Buffer.from(init?.body as Uint8Array), data)
      }
      if (requests === 3) assertEquals(JSON.parse(String(init?.body)), {
        upload_id: 'private', part_index: Number(index), block_size: String(data.length),
        md5: createHash('md5').update(data).digest('hex'),
      })
      return Response.json(requests === 4 ? { file_info: 'complete' } : {})
    })
    assertEquals(await channel['uploadNamedMedia']({ kind: 'c2c', id: 'recipient' }, {}, 'image.png', data, 1), { file_info: 'complete' })
    assertEquals(requests, 4)
  })
}
